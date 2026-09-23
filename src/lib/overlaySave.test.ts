import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { VaultFile } from '../types';
const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), create: vi.fn() }));
vi.mock('./vault', async original => ({ ...await original<object>(), readNoteResult: io.read, writeNote: io.write, writeVaultTextFile: io.create }));
import { useAppStore } from '../store';
const initial = useAppStore.getState();
const file: VaultFile = { path: '/vault/Scratchpad/2026-09-14.md', relPath: 'Scratchpad/2026-09-14.md', name: '2026-09-14', ext: 'md', isMarkdown: true };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const binding = () => ({ root: '/vault', generation: useAppStore.getState().getVaultGeneration(), expected: 'disk' });
beforeEach(() => {
  vi.clearAllMocks();
  io.read.mockResolvedValue({ ok: true, text: 'disk' }); io.write.mockResolvedValue(undefined);
  useAppStore.setState({ ...initial, vaultPath: '/vault', files: [file], activePath: file.relPath, content: 'disk', contentCache: { [file.relPath]: 'disk' }, notes: {} });
});
afterEach(async () => { await useAppStore.getState().flushSave(); useAppStore.setState(initial); });
it('refuses an obsolete vault generation before starting IO', async () => {
  const result = await useAppStore.getState().saveOverlayArtifact('scratchpad', 'draft', '2026-09-14', { ...binding(), generation: binding().generation - 1 });
  expect(result).toBeNull(); expect(io.read).not.toHaveBeenCalled(); expect(io.write).not.toHaveBeenCalled();
});
it('does not write after the vault switches during a delayed read', async () => {
  const read = deferred<{ ok: true; text: string }>(); io.read.mockReturnValue(read.promise);
  const save = useAppStore.getState().saveOverlayArtifact('scratchpad', 'draft', '2026-09-14', binding());
  await vi.waitFor(() => expect(io.read).toHaveBeenCalled());
  useAppStore.setState({ vaultPath: '/other', content: 'other document' });
  read.resolve({ ok: true, text: 'disk' });
  expect(await save).toBeNull(); expect(io.write).not.toHaveBeenCalled(); expect(useAppStore.getState().content).toBe('other document');
});
it('refuses a changed disk baseline and keeps the editor untouched', async () => {
  io.read.mockResolvedValue({ ok: true, text: 'external change' });
  expect(await useAppStore.getState().saveOverlayArtifact('scratchpad', 'draft', '2026-09-14', binding())).toBeNull();
  expect(io.write).not.toHaveBeenCalled(); expect(useAppStore.getState().content).toBe('disk');
});
it('updates the clean editor after a verified overlay save', async () => {
  expect(await useAppStore.getState().saveOverlayArtifact('scratchpad', 'draft', '2026-09-14', binding())).toBe(file.relPath);
  expect(io.write).toHaveBeenCalledWith(file, 'draft', 'disk');
  expect(useAppStore.getState().content).toBe('draft');
});
it('does not replace editor typing that arrives during the baseline read', async () => {
  const read = deferred<{ ok: true; text: string }>(); io.read.mockReturnValue(read.promise);
  const save = useAppStore.getState().saveOverlayArtifact('scratchpad', 'overlay draft', '2026-09-14', binding());
  await vi.waitFor(() => expect(io.read).toHaveBeenCalled());
  useAppStore.getState().setContentFromEditor('new editor work');
  read.resolve({ ok: true, text: 'disk' });
  expect(await save).toBeNull();
  expect(useAppStore.getState().content).toBe('new editor work');
  await useAppStore.getState().flushSave();
  expect(io.write).toHaveBeenCalledWith(file, 'new editor work', 'disk');
  expect(io.write.mock.calls.some(call => call[1] === 'overlay draft')).toBe(false);
});
it('does not publish an older overlay snapshot over typing during the write', async () => {
  const write = deferred<void>(); io.write.mockReturnValueOnce(write.promise);
  const save = useAppStore.getState().saveOverlayArtifact('scratchpad', 'overlay draft', '2026-09-14', binding());
  await vi.waitFor(() => expect(io.write).toHaveBeenCalled());
  useAppStore.getState().setContentFromEditor('later editor work');
  write.resolve(); await save;
  expect(useAppStore.getState().content).toBe('later editor work');
  expect(useAppStore.getState().contentCache[file.relPath]).toBe('later editor work');
  expect(io.write).toHaveBeenLastCalledWith(file, 'later editor work', 'overlay draft');
});
