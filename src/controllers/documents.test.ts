// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { useAppStore, type AppState } from '../store';
import { TextSaveCoordinator } from '../lib/textSaveCoordinator';
import type { VaultFile } from '../types';
import { createDocumentController } from './documents';
const io = vi.hoisted(() => ({ read: vi.fn(), valid: vi.fn() }));
vi.mock('../lib/vault', async original => ({ ...await original<object>(), readNoteResult: io.read, isValidUtf8Text: io.valid }));
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
