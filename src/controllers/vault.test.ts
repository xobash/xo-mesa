// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { useAppStore, type AppState } from '../store';
import { TextSaveCoordinator } from '../lib/textSaveCoordinator';
import type { VaultFile } from '../types';
import { createVaultController, mergeWatchEvents } from './vault';
const io = vi.hoisted(() => ({ watch: vi.fn(), valid: vi.fn(async () => true), read: vi.fn(), scan: vi.fn(async () => []), exists: vi.fn(async (_path: string) => true) }));
vi.mock('../lib/vault', async original => ({ ...await original<object>(), authorizeVaultRoot: async () => { }, assertVaultRootAvailable: async () => { }, scanVault: io.scan, recoverWriteArtifacts: async () => ({ restored: [], removed: [] }), watchVault: io.watch, readNoteResult: io.read, isValidUtf8Text: io.valid, readNote: async () => (await io.read()).text }));
vi.mock('../lib/vaultIndex', async original => ({ ...await original<object>(), loadIndexedNotes: async () => ({ notes: {}, cache: {}, read: 0, reused: 0, skipped: [], failed: [] }) }));
it('releases a watcher that finishes registration after controller disposal', async () => {
  let resolve!: (stop: () => void) => void;
  io.watch.mockReturnValue(new Promise(r => { resolve = r; }));
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: null, files: [], notes: {}, contentCache: {} }));
  const controller = createVaultController({
    get: state.getState, set: state.setState,
    textSaves: new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: async () => { } }), resetDocuments: vi.fn(), stopResearch: async () => { }, setupActivityBridge: async () => { }, ensureSyncEventBridge: async () => { },
    stopListening: async () => false, startListening: async () => { }
  });
  await controller.actions.openVault('/synthetic');
  expect(io.watch).toHaveBeenCalledOnce();
  const generation = controller.generation;
  controller.dispose(); const stop = vi.fn(); resolve(stop);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(controller.generation).toBeGreaterThan(generation);
});

it('stops the old vault listener before publishing a new vault and resumes it on the new root', async () => {
  io.watch.mockResolvedValue(() => {});
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: '/old', syncListening: true, files: [], notes: {}, contentCache: {} }));
  const events: string[] = [];
  const controller = createVaultController({
    get: state.getState, set: state.setState,
    textSaves: new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: async () => {} }),
    resetDocuments: vi.fn(), stopResearch: async () => {}, setupActivityBridge: async () => {}, ensureSyncEventBridge: async () => {},
    stopListening: async () => {
      events.push(`stop:${state.getState().vaultPath}`);
      state.setState({ syncListening: false });
      return true;
    },
    startListening: async root => {
      events.push(`start:${root}:${state.getState().vaultPath}`);
      state.setState({ syncListening: true });
    },
  });
  await controller.actions.openVault('/new');
  expect(events).toEqual(['stop:/old', 'start:/new:/new']);
  expect(state.getState()).toMatchObject({ vaultPath: '/new', syncListening: true });
  controller.dispose();
});

vi.mock('../lib/textRevisionHistory', async original => ({ ...await original<object>(), recordTextRevisionAsync: async () => true }));
vi.mock('@tauri-apps/plugin-fs', async original => ({ ...await original<object>(), stat: async () => ({ size: 1, mtime: null }), exists: io.exists }));
function watcherFixture() {
  let onChange!: (events: { paths: string[]; kind: string }[]) => void;
  io.watch.mockImplementation(async (_root: string, callback: typeof onChange) => { onChange = callback; return () => {}; });
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: null, files: [], notes: {}, contentCache: {} }));
  const textSaves = new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: async () => {} });
  const controller = createVaultController({ get: state.getState, set: state.setState,
    textSaves, resetDocuments: vi.fn(),
    stopResearch: async () => {}, setupActivityBridge: async () => {}, ensureSyncEventBridge: async () => {},
    stopListening: async () => false, startListening: async () => {} });
  return { state, controller, textSaves, change: (events: Parameters<typeof onChange>[0]) => onChange(events) };
}
const file = (rel: string): VaultFile => ({ path: `/v/${rel}`, relPath: rel, name: rel.replace(/\.md$/, ''), ext: 'md', isMarkdown: true });
it('a slower older watcher batch never overwrites newer disk content', async () => {
  const f = watcherFixture(); await f.controller.actions.openVault('/v');
  const files = [file('a.md'), file('b.md')];
  f.state.setState({ files, contentCache: { 'a.md': 'v0', 'b.md': 'b0' },
    fileFor: rel => f.state.getState().files.find(file => file.relPath === rel),
    notes: Object.fromEntries(files.map(file => [file.relPath, { relPath: file.relPath, title: file.name, rawLinks: [], tags: [], aliases: [] }])) });
  let releaseB!: (value: unknown) => void;
  io.read.mockReset().mockImplementationOnce(async () => ({ ok: true, text: 'v1' }))
    .mockImplementationOnce(() => new Promise(resolve => { releaseB = resolve; }));
  f.change([{ kind: 'modify', paths: ['/v/a.md', '/v/b.md'] }]);
  await vi.waitFor(() => expect(releaseB).toBeTypeOf('function'));
  io.read.mockImplementationOnce(async () => ({ ok: true, text: 'v2' }));
  f.change([{ kind: 'modify', paths: ['/v/a.md'] }]);
  releaseB({ ok: true, text: 'b1' });
  await vi.waitFor(() => expect(f.state.getState().contentCache['a.md']).toBe('v2'));
  expect(f.state.getState().contentCache['b.md']).toBe('b1'); f.controller.dispose();
});
it('coalesces paths with their latest kind in last occurrence order', () => {
  expect(mergeWatchEvents([{kind:'remove',paths:['/v/a.md']},{kind:'modify',paths:['/v/b.md']},{kind:'create',paths:['/v/a.md']}]))
    .toEqual([{kind:'modify',paths:['/v/b.md']},{kind:'create',paths:['/v/a.md']}]);
});

it('keeps one leading rescan request that later kinds for the root cannot hide', () => {
  expect(mergeWatchEvents([{kind:'rescan',paths:['/v']},{kind:'modify',paths:['/v']},{kind:'rescan',paths:['/v']},{kind:'create',paths:['/v/a.md']}]))
    .toEqual([{kind:'rescan',paths:['/v']},{kind:'modify',paths:['/v']},{kind:'create',paths:['/v/a.md']}]);
});

it('turns a watcher overflow into one rescan that applies lost creates, deletes and edits', async () => {
  const f = watcherFixture(); await f.controller.actions.openVault('/v');
  const sized = (rel: string, size: number): VaultFile => ({ ...file(rel), size, mtime: 1 });
  const existing = [sized('kept.md', 1), sized('gone.md', 1), sized('edited.md', 1)];
  f.state.setState({ files: existing, contentCache: { 'kept.md': 'k', 'gone.md': 'g', 'edited.md': 'old' },
    fileFor: rel => f.state.getState().files.find(file => file.relPath === rel),
    notes: Object.fromEntries(existing.map(file => [file.relPath, { relPath: file.relPath, title: file.name, rawLinks: [], tags: [], aliases: [] }])) });
  io.scan.mockReset().mockResolvedValue([sized('kept.md', 1), sized('edited.md', 9), sized('new.md', 3)] as never);
  io.read.mockReset().mockImplementation(async () => ({ ok: true, text: 'fresh' }));
  // Two overflow windows plus a root modify arrive before the batch runs.
  f.change([{ kind: 'rescan', paths: ['/v'] }]);
  f.change([{ kind: 'rescan', paths: ['/v'] }, { kind: 'modify', paths: ['/v'] }]);
  await vi.waitFor(() => expect(f.state.getState().files.map(file => file.relPath)).toEqual(['edited.md', 'kept.md', 'new.md']));
  await vi.waitFor(() => expect(f.state.getState().contentCache['edited.md']).toBe('fresh'));
  expect(f.state.getState().contentCache['new.md']).toBe('fresh');
  expect(f.state.getState().contentCache['gone.md']).toBeUndefined();
  expect(f.state.getState().contentCache['kept.md']).toBe('k');
  // One scan for the merged batch (the root modify may schedule a later debounced refresh).
  expect(io.scan).toHaveBeenCalledTimes(1);
  expect(f.state.getState().status).toContain('missed changes');
  f.controller.dispose();
});

it('never treats an empty rescan listing as a mass deletion', async () => {
  const f = watcherFixture(); await f.controller.actions.openVault('/v');
  f.state.setState({ files: [file('a.md')], fileFor: rel => f.state.getState().files.find(file => file.relPath === rel) });
  io.scan.mockReset().mockResolvedValue([] as never);
  f.change([{ kind: 'rescan', paths: ['/v'] }]);
  await vi.waitFor(() => expect(io.scan).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.state.getState().files.map(file => file.relPath)).toEqual(['a.md']);
  f.controller.dispose();
});

it('ingests 200 external creates with one read each and one sorted catalogue commit', async () => {
  const f = watcherFixture(); await f.controller.actions.openVault('/v');
  const existing = Array.from({length:2000}, (_, i) => file(`Old-${i}.md`));
  f.state.setState({files: existing, fileFor: rel => f.state.getState().files.find(file => file.relPath === rel)});
  io.read.mockReset().mockResolvedValue({ok:true, text:'new text'}); io.scan.mockClear();
  let commits = 0;
  const stop = f.state.subscribe((state, previous) => { if (state.files !== previous.files) commits++; });
  const additions = Array.from({length:200}, (_, i) => `New-${i}.md`);
  f.change([{kind:'create',paths:additions.map(rel => `/v/${rel}`)}]);
  await vi.waitFor(() => expect(f.state.getState().files).toHaveLength(2200));
  expect(io.read).toHaveBeenCalledTimes(200); expect(commits).toBeLessThanOrEqual(2);
  expect(f.state.getState().files.map(file => file.relPath)).toEqual([...existing.map(file => file.relPath), ...additions].sort((a,b) => a.localeCompare(b)));
  await new Promise(resolve => setTimeout(resolve, 220)); expect(io.scan).not.toHaveBeenCalled();
  stop(); f.controller.dispose();
});

it('keeps externally replaced invalid text read-only even when decoded text is unchanged', async () => {
  const f = watcherFixture(); await f.controller.actions.openVault('/v');
  const a = file('a.md');
  f.state.setState({ files: [a], activePath: 'a.md', content: 'caf\uFFFD', contentCache: { 'a.md': 'caf\uFFFD' }, fileFor: () => a });
  io.read.mockReset().mockResolvedValue({ ok: true, text: 'caf\uFFFD' });
  io.valid.mockResolvedValue(false);
  f.change([{ kind: 'modify', paths: ['/v/a.md'] }]);
  await vi.waitFor(() => expect(f.state.getState().activeContentState).toBe('invalid-encoding'));
  expect(f.state.getState().content).toBe('caf\uFFFD');
  io.valid.mockResolvedValue(true);
  f.change([{ kind: 'modify', paths: ['/v/a.md'] }]);
  await vi.waitFor(() => expect(f.state.getState().activeContentState).toBe('ready'));
  f.controller.dispose();
});

it('forgets the side-by-side file when it is deleted outside Mesa', async () => {
  const f = watcherFixture(); await f.controller.actions.openVault('/v');
  const files = [file('Live.md'), file('Side.md')];
  f.state.setState({ files, activePath: 'Live.md', docSplit: { active: 'doc2', other: 'Side.md' },
    fileFor: rel => f.state.getState().files.find(file => file.relPath === rel) });
  f.change([{ kind: 'remove', paths: ['/v/Side.md'] }]);
  await vi.waitFor(() => expect(f.state.getState().files).toHaveLength(1));
  expect(f.state.getState().docSplit).toEqual({ active: 'doc2', other: null });
  f.controller.dispose();
});

it('removes 300 external deletes with one catalogue commit and clears their tabs, notes and text', async () => {
  const f = watcherFixture(); await f.controller.actions.openVault('/v');
  const existing = Array.from({length:2000}, (_, i) => file(`Old-${i}.md`));
  const removed = existing.slice(0, 300).map(file => file.relPath);
  f.state.setState({ files: existing, openTabs: ['Old-0.md', 'Old-1999.md'], activePath: 'Old-0.md', content: 'text',
    contentCache: Object.fromEntries(existing.map(file => [file.relPath, 'text'])),
    notes: Object.fromEntries(existing.map(file => [file.relPath, { relPath: file.relPath, title: file.name, rawLinks: [], tags: [], aliases: [] }])),
    fileFor: rel => f.state.getState().files.find(file => file.relPath === rel) });
  let commits = 0;
  const stop = f.state.subscribe((state, previous) => { if (state.files !== previous.files) commits++; });
  f.change([{ kind: 'remove', paths: removed.map(rel => `/v/${rel}`) }]);
  await vi.waitFor(() => expect(f.state.getState().files).toHaveLength(1700));
  const state = f.state.getState();
  expect(commits).toBe(1);
  expect(state).toMatchObject({ openTabs: ['Old-1999.md'], activePath: null, content: '' });
  expect(removed.some(rel => rel in state.notes || state.contentCache[rel] !== undefined)).toBe(false);
  expect(state.contentCache['Old-1999.md']).toBe('text');
  stop(); f.controller.dispose();
});

it('removes the old name of an external rename reported as one modify event', async () => {
  const f = watcherFixture(); await f.controller.actions.openVault('/v');
  const old = file('old.md'); const kept = file('kept.md');
  f.state.setState({ files: [kept, old], openTabs: ['old.md'], contentCache: { 'old.md': 'moved', 'kept.md': 'dirty' },
    notes: { 'old.md': { relPath: 'old.md', title: 'old', rawLinks: [], tags: [], aliases: [] } },
    fileFor: rel => f.state.getState().files.find(entry => entry.relPath === rel) });
  f.textSaves.markDirty(kept.path, kept, 'dirty local text', 'dirty');
  io.read.mockReset().mockImplementation(async (entry: VaultFile) =>
    entry.relPath === 'new.md' ? { ok: true, text: 'moved' } : { ok: false, text: '' });
  io.exists.mockReset().mockImplementation(async (path: string) => path === '/v/new.md');
  f.change([{ kind: 'modify', paths: ['/v/old.md', '/v/new.md', '/v/kept.md'] }]);
  await vi.waitFor(() => expect(f.state.getState().files.map(entry => entry.relPath)).toEqual(['kept.md', 'new.md']));
  const state = f.state.getState();
  expect(state.openTabs).toEqual([]);
  expect('old.md' in state.notes || 'old.md' in state.contentCache).toBe(false);
  expect(state.status).not.toContain('could not be read');
  expect(state.status).toContain('unsaved text was kept for kept.md');
  f.controller.dispose();
});

it('removes every known file under a folder that vanished in a modify event', async () => {
  const f = watcherFixture(); await f.controller.actions.openVault('/v');
  const files = [file('notes/a.md'), file('notes/deep/b.md'), file('notesy.md')];
  f.state.setState({ files, fileFor: rel => f.state.getState().files.find(entry => entry.relPath === rel) });
  io.read.mockReset().mockResolvedValue({ ok: false, text: '' });
  io.exists.mockReset().mockResolvedValue(false);
  f.change([{ kind: 'modify', paths: ['/v/notes'] }]);
  await vi.waitFor(() => expect(f.state.getState().files.map(entry => entry.relPath)).toEqual(['notesy.md']));
  expect(f.state.getState().status).not.toContain('could not be read');
  f.controller.dispose();
});

it('refreshes reference metadata from an external edit so a later rename can repair the new embed', async () => {
  const f = watcherFixture(); await f.controller.actions.openVault('/v');
  const files = [file('a.md')];
  f.state.setState({ files, contentCache: { 'a.md': 'plain' },
    fileFor: rel => f.state.getState().files.find(file => file.relPath === rel),
    notes: { 'a.md': { relPath: 'a.md', title: 'a', rawLinks: [], rawReferences: [], tags: [], aliases: [] } } });
  io.read.mockReset().mockImplementationOnce(async () => ({ ok: true, text: 'plain ![[pic.png]] [ref]: docs/spec.pdf' }));
  f.change([{ kind: 'modify', paths: ['/v/a.md'] }]);
  await vi.waitFor(() => expect(f.state.getState().contentCache['a.md']).toContain('pic.png'));
  expect(f.state.getState().notes['a.md'].rawReferences).toEqual(expect.arrayContaining(['pic.png']));
  f.controller.dispose();
});
