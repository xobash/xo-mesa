// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { useAppStore } from '../store';
import { TextSaveCoordinator } from '../lib/textSaveCoordinator';
import type { VaultFile } from '../types';
import { createVaultController } from './vault';
const io = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock('../lib/vault', async original => ({ ...await original<object>(), authorizeVaultRoot: async () => { }, assertVaultRootAvailable: async () => { }, scanVault: async () => [], recoverWriteArtifacts: async () => ({ restored: [], removed: [] }), watchVault: io.watch }));
vi.mock('../lib/vaultIndex', async original => ({ ...await original<object>(), loadIndexedNotes: async () => ({ notes: {}, cache: {}, read: 0, reused: 0, skipped: [], failed: [] }) }));
it('releases a watcher that finishes registration after controller disposal', async () => {
  let resolve!: (stop: () => void) => void;
  io.watch.mockReturnValue(new Promise(r => { resolve = r; }));
  const state = createStore(() => ({ ...useAppStore.getInitialState(), vaultPath: null, files: [], notes: {}, contentCache: {} }));
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
  const state = createStore(() => ({ ...useAppStore.getInitialState(), vaultPath: '/old', syncListening: true, files: [], notes: {}, contentCache: {} }));
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
