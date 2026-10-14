// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { useAppStore, type AppState } from '../store';
import { TextSaveCoordinator } from '../lib/textSaveCoordinator';
import type { VaultFile } from '../types';
import { createVaultController, mergeWatchEvents } from './vault';
const io = vi.hoisted(() => ({ watch: vi.fn(), valid: vi.fn(async () => true), read: vi.fn(), scan: vi.fn(async () => []) }));
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
vi.mock('@tauri-apps/plugin-fs', async original => ({ ...await original<object>(), stat: async () => ({ size: 1, mtime: null }) }));
function watcherFixture() {
  let onChange!: (events: { paths: string[]; kind: string }[]) => void;
  io.watch.mockImplementation(async (_root: string, callback: typeof onChange) => { onChange = callback; return () => {}; });
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: null, files: [], notes: {}, contentCache: {} }));
  const controller = createVaultController({ get: state.getState, set: state.setState,
    textSaves: new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: async () => {} }), resetDocuments: vi.fn(),
    stopResearch: async () => {}, setupActivityBridge: async () => {}, ensureSyncEventBridge: async () => {},
    stopListening: async () => false, startListening: async () => {} });
  return { state, controller, change: (events: Parameters<typeof onChange>[0]) => onChange(events) };
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
