// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { useAppStore, type AppState } from '../store';
import { TextSaveCoordinator } from '../lib/textSaveCoordinator';
import type { VaultFile } from '../types';
import { createDocumentController } from './documents';
const io = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../lib/vault', async original => ({ ...await original<object>(), readNoteResult: io.read }));
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
