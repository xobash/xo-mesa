// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { useAppStore, type AppState } from '../store';
import { TextSaveCoordinator } from '../lib/textSaveCoordinator';
import type { VaultFile } from '../types';
import { createVaultController } from './vault';
const io = vi.hoisted(() => ({ watch: vi.fn(), read: vi.fn(), bytes: vi.fn(), fullRead: vi.fn() }));
vi.mock('@tauri-apps/api/core', async original => ({ ...await original<object>(), invoke: async (command: string, args: { maxBytes?: number }) => command === 'vault_read_bytes' ? io.bytes(args) : undefined }));
vi.mock('@tauri-apps/plugin-fs', async original => ({ ...await original<object>(), stat: async () => ({ size: 1, mtime: null }) }));
vi.mock('../lib/vault', async original => ({ ...await original<object>(), IN_TAURI: true, authorizeVaultRoot: async () => {}, assertVaultRootAvailable: async () => {}, scanVault: async () => [], recoverWriteArtifacts: async () => ({ restored: [], removed: [] }), watchVault: io.watch, readNoteResult: io.fullRead, isValidUtf8Text: async () => true }));
vi.mock('../lib/vaultIndex', async original => ({ ...await original<object>(), loadIndexedNotes: async () => ({ notes: {}, cache: {}, read: 0, reused: 0, skipped: [], failed: [] }) }));
vi.mock('../lib/textRevisionHistory', async original => ({ ...await original<object>(), recordTextRevisionsAsync: async () => [true] }));
vi.mock('../lib/persistedUi', async original => ({ ...await original<object>(), rememberRecentVaultNative: async () => ({ recents: [], last: null }) }));

const file = (rel: string): VaultFile => ({ path: `/v/${rel}`, relPath: rel, name: rel, ext: 'log', isMarkdown: false });

it('does not re-read an 8 MiB or larger text file on every external change', async () => {
  let onChange!: (events: { paths: string[]; kind: string }[]) => void;
  io.watch.mockImplementation(async (_root: string, callback: typeof onChange) => { onChange = callback; return () => {}; });
  const state = createStore<AppState>(() => ({ ...useAppStore.getInitialState(), vaultPath: null, files: [], notes: {}, contentCache: {} }));
  const controller = createVaultController({ get: state.getState, set: state.setState,
    textSaves: new TextSaveCoordinator<VaultFile>({ delayMs: 500, write: async () => {} }), resetDocuments: vi.fn(),
    stopResearch: async () => {}, setupActivityBridge: async () => {}, ensureSyncEventBridge: async () => {},
    stopListening: async () => false, startListening: async () => {} });
  await controller.actions.openVault('/v');
  const big = file('server.log'); const small = file('notes.log');
  state.setState({ files: [big, small], openTabs: ['server.log'], contentCache: { 'server.log': 'old', 'notes.log': 'old' },
    fileFor: rel => state.getState().files.find(f => f.relPath === rel) });
  io.bytes.mockImplementation(async ({ maxBytes }: { maxBytes: number }) => new TextEncoder().encode('x'.repeat(maxBytes)).buffer);
  onChange([{ kind: 'modify', paths: ['/v/server.log'] }]);
  await vi.waitFor(() => expect(state.getState().status).toContain('server.log changed outside Mesa; it is 8 MiB or larger'));
  expect(state.getState().contentCache['server.log']).toBe('old');
  io.bytes.mockImplementation(async () => new TextEncoder().encode('new small text').buffer);
  onChange([{ kind: 'modify', paths: ['/v/notes.log'] }]);
  await vi.waitFor(() => expect(state.getState().contentCache['notes.log']).toBe('new small text'));
  expect(io.bytes).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 8 * 1024 * 1024 }));
  expect(io.fullRead).not.toHaveBeenCalled();
  controller.dispose();
});
