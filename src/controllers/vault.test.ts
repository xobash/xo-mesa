// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { useAppStore, type AppState } from '../store';
import { TextSaveCoordinator } from '../lib/textSaveCoordinator';
import type { VaultFile } from '../types';
import { createVaultController, mergeWatchEvents } from './vault';
const io = vi.hoisted(() => ({ watch: vi.fn(), read: vi.fn(), scan: vi.fn(async () => []) }));
vi.mock('../lib/vault', async original => ({ ...await original<object>(), authorizeVaultRoot: async () => { }, assertVaultRootAvailable: async () => { }, scanVault: io.scan, recoverWriteArtifacts: async () => ({ restored: [], removed: [] }), watchVault: io.watch, readNoteResult: io.read, readNote: async () => (await io.read()).text }));
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
