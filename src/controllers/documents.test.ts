// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { useAppStore, type AppState } from '../store';
import { TextSaveCoordinator } from '../lib/textSaveCoordinator';
import type { VaultFile } from '../types';
import { createDocumentController } from './documents';
const io = vi.hoisted(() => ({ read: vi.fn(), valid: vi.fn(), create: vi.fn() }));
vi.mock('../lib/vault', async original => ({ ...await original<object>(), readNoteResult: io.read, isValidUtf8Text: io.valid, createNote: io.create }));
it('coalesces reads and refuses another vault cache after a generation change', async () => {
  let resolve!: (value: { ok: true; text: string }) => void;
  io.read.mockReturnValue(new Promise(r => { resolve = r; }));
  const file: VaultFile = { path: '/old/a.md', relPath: 'a.md', name: 'a', ext: 'md', isMarkdown: true };
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: '/old', files: [file], contentCache: {}, fileFor: () => file }));
  let generation = 1;
  const controller = createDocumentController({
    get: state.getState, set: state.setState, getGeneration: () => generation,
    textSaves: new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: async () => { } }), commitSettings: vi.fn(), reportingFailure: async (_, run) => run()
  });
  const first = controller.actions.ensureContent('a.md');
  const second = controller.actions.ensureContent('a.md');
  expect(io.read).toHaveBeenCalledOnce();
  generation++;
  controller.reset();
  state.setState({ vaultPath: '/new', contentCache: { 'a.md': 'new private text' } });
  resolve({ ok: true, text: 'old' });
  expect(await first).toBe(''); expect(await second).toBe('');
  expect(state.getState().contentCache['a.md']).toBe('new private text');
});

it.each([true, false])('validates a cached replacement tab after closing the active tab (valid=%s)', async (valid) => {
  const file: VaultFile = { path: '/vault/a.md', relPath: 'a.md', name: 'a', ext: 'md', isMarkdown: true };
  const closing = { ...file, path: '/vault/b.md', relPath: 'b.md', name: 'b' };
  let resolve!: (value: boolean) => void;
  io.valid.mockReturnValue(new Promise<boolean>(done => { resolve = done; }));
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: '/vault', files: [file, closing],
    activePath: 'b.md', activeContentState: valid ? 'invalid-encoding' : 'ready', openTabs: ['a.md', 'b.md'],
    contentCache: { 'a.md': valid ? 'valid text' : 'caf\uFFFD', 'b.md': 'closing' },
    fileFor: path => [file, closing].find(candidate => candidate.relPath === path) }));
  const saves = new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: vi.fn() });
  const controller = createDocumentController({ get: state.getState, set: state.setState, getGeneration: () => 1,
    textSaves: saves, commitSettings: vi.fn(), reportingFailure: async (_, run) => run() });
  state.setState(controller.actions);
  controller.actions.closeTab('b.md');
  expect(state.getState().activePath).toBe('a.md');
  expect(state.getState().activeContentState).toBe('loading');
  controller.actions.setContentFromEditor('must not edit before validation');
  expect(saves.pendingSnapshots()).toHaveLength(0);
  resolve(valid);
  await vi.waitFor(() => expect(state.getState().activeContentState).toBe(valid ? 'ready' : 'invalid-encoding'));
  if (!valid) {
    controller.actions.setContentFromEditor('must not edit invalid bytes');
    expect(saves.pendingSnapshots()).toHaveLength(0);
  }
});

it.each(['/new', '/old'])('does not publish linked-note creation after switching or reopening a vault (%s)', async (nextRoot) => {
  const created: VaultFile = { path: '/old/new.md', relPath: 'new.md', name: 'new', ext: 'md', isMarkdown: true };
  let resolve!: (file: VaultFile) => void;
  io.create.mockReturnValue(new Promise<VaultFile>(done => { resolve = done; }));
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: '/old', files: [], notes: {}, contentCache: {} }));
  let generation = 1;
  const select = vi.fn();
  const controller = createDocumentController({ get: state.getState, set: state.setState, getGeneration: () => generation,
    textSaves: new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: vi.fn() }), commitSettings: vi.fn(), reportingFailure: async (_, run) => run() });
  state.setState({ selectFile: select });
  const opening = controller.actions.openTarget('new');
  generation++;
  state.setState({ vaultPath: nextRoot, status: 'current workspace' });
  resolve(created);
  await opening;
  expect(state.getState().files).toEqual([]);
  expect(state.getState().contentCache).toEqual({});
  expect(state.getState().notes).toEqual({});
  expect(state.getState().status).toBe('current workspace');
  expect(select).not.toHaveBeenCalled();
});

it('opens lossy UTF-8 read-only through lazy reads, cached selection and deliberate reload', async () => {
  const file: VaultFile = { path: '/vault/a.md', relPath: 'a.md', name: 'a', ext: 'md', isMarkdown: true };
  const text = 'caf\uFFFD';
  io.read.mockResolvedValue({ ok: true, text }); io.valid.mockResolvedValue(false);
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: '/vault', files: [file], activePath: 'a.md', contentCache: {}, fileFor: () => file }));
  const saves = new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: vi.fn() });
  const controller = createDocumentController({ get: state.getState, set: state.setState, getGeneration: () => 1,
    textSaves: saves, commitSettings: vi.fn(), reportingFailure: async (_, run) => run() });
  state.setState(controller.actions);
  await controller.actions.selectFile('a.md');
  expect(state.getState().content).toBe(text);
  expect(state.getState().activeContentState).toBe('invalid-encoding');
  expect(state.getState().status).toContain('read-only');
  controller.actions.setContentFromEditor('changed'); expect(saves.pendingSnapshots()).toHaveLength(0);
  await controller.actions.selectFile('a.md'); expect(state.getState().activeContentState).toBe('invalid-encoding');
  await controller.actions.loadActiveContent(); expect(state.getState().activeContentState).toBe('invalid-encoding');
  io.valid.mockResolvedValue(true);
  await controller.actions.loadActiveContent(); expect(state.getState().activeContentState).toBe('ready');
});

function linkFixture() {
  io.create.mockReset().mockImplementation(async (root: string, rel: string) => ({ path: `${root}/${rel}`, relPath: rel, name: rel.split('/').pop()!.replace(/\.md$/, ''), ext: 'md', isMarkdown: true }));
  io.valid.mockResolvedValue(true);
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: '/vault', files: [], notes: {}, contentCache: {} }));
  state.setState({ fileFor: rel => state.getState().files.find(file => file.relPath === rel) });
  const controller = createDocumentController({ get: state.getState, set: state.setState, getGeneration: () => 1,
    textSaves: new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: async () => { } }), commitSettings: vi.fn(), reportingFailure: async (_, run) => run() });
  state.setState(controller.actions);
  return { state, controller };
}
it.each([['Note#Heading', 'Note.md', '# Note\n\n'], ['Folder/Note#^block', 'Folder/Note.md', '# Note\n\n'], ['Note|Alias', 'Note.md', '# Note\n\n']])(
  'creates the note named before the link fragment for %s', async (target, rel, content) => {
    const { state, controller } = linkFixture();
    await controller.actions.openTarget(target);
    expect(io.create).toHaveBeenCalledWith('/vault', rel, content);
    expect(state.getState().activePath).toBe(rel);
  });
it.each(['../outside', 'a/../../b', '.hidden/x', 'bad:name', '#Heading'])('refuses to create a linked note for %s', async (target) => {
  const { controller } = linkFixture();
  await controller.actions.openTarget(target);
  expect(io.create).not.toHaveBeenCalled();
});
