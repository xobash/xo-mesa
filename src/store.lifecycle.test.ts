// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ available: vi.fn(async (_root: string) => {}), scan: vi.fn(async (_root: string): Promise<never[]> => []), watch: vi.fn(async () => () => {}), read: vi.fn(async () => ({ ok: true, text: 'original' })), write: vi.fn(async () => {}), backup: vi.fn(async () => ({})) }));
vi.mock('./lib/vault', async original => ({ ...await original<object>(), assertVaultRootAvailable: io.available, scanVault: io.scan, watchVault: io.watch, readNoteResult: io.read, readReviewText: async () => (await io.read()).text, writeNote: io.write, writeVaultTextFile: io.backup, recoverWriteArtifacts: async () => ({ restored: [], removed: [] }) }));
import { useAppStore } from './store';
const initial = useAppStore.getState();
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
beforeEach(() => { vi.clearAllMocks(); io.scan.mockResolvedValue([]); io.available.mockResolvedValue(); useAppStore.setState(initial); });
afterEach(() => useAppStore.setState(initial));
describe('store interruption boundaries', () => {
  it('a slow earlier folder check cannot replace a more recently selected vault', async () => {
    const first = deferred(); io.available.mockImplementation(async root => { if (root === '/first') await first.promise; });
    const old = useAppStore.getState().openVault('/first'); await useAppStore.getState().openVault('/second'); first.resolve(); await old;
    expect(useAppStore.getState().vaultPath).toBe('/second'); expect(io.scan).not.toHaveBeenCalledWith('/first', expect.anything());
  });
  it('a failed folder check from an old request cannot overwrite a successful open', async () => {
    const first = deferred(); io.available.mockImplementation(async root => { if (root === '/first') { await first.promise; throw new Error('disconnected'); } });
    const old = useAppStore.getState().openVault('/first'); await useAppStore.getState().openVault('/second'); first.resolve(); await old;
    expect(useAppStore.getState().unavailableVault).toBeNull(); expect(useAppStore.getState().loading).toBe(false);
  });
  it('a disconnected scan keeps the old editor and restores its watcher', async () => {
    useAppStore.setState({ vaultPath: '/old', activePath: 'Note.md', content: 'kept' });
    io.scan.mockRejectedValueOnce(new Error('drive gone'));
    await useAppStore.getState().openVault('/new');
    expect(useAppStore.getState()).toMatchObject({ vaultPath: '/old', content: 'kept', loading: false, unavailableVault: { root: '/new' } });
    expect(io.watch).toHaveBeenCalledWith('/old', expect.any(Function));
  });
  it('restores the active watcher when a newer folder check fails during an older scan', async () => {
    useAppStore.setState({ vaultPath: '/old', activePath: 'Note.md', content: 'kept' });
    const scanning = deferred();
    const started = deferred();
    io.scan.mockImplementationOnce(async () => { started.resolve(); await scanning.promise; return []; });
    const oldRequest = useAppStore.getState().openVault('/slow');
    await started.promise;
    io.available.mockRejectedValueOnce(new Error('unavailable'));
    await useAppStore.getState().openVault('/missing');
    scanning.resolve(); await oldRequest;
    expect(useAppStore.getState()).toMatchObject({ vaultPath: '/old', loading: false });
    expect(io.watch).toHaveBeenCalledWith('/old', expect.any(Function));
  });
  it('refuses stale conflict-review text before making a backup or writing', async () => {
    useAppStore.setState({ vaultPath: '/vault', files: [{ relPath: 'Note.md', path: '/vault/Note.md', name: 'Note', ext: 'md', isMarkdown: true }] });
    await expect(useAppStore.getState().saveConflictReview('/vault', 'Note.md', 'stale', 'merged')).rejects.toThrow('original changed');
    expect(io.backup).not.toHaveBeenCalled(); expect(io.write).not.toHaveBeenCalled();
  });
  it('refuses to replace original text when the retained-copy write fails', async () => {
    useAppStore.setState({ vaultPath: '/vault', files: [{ relPath: 'Note.md', path: '/vault/Note.md', name: 'Note', ext: 'md', isMarkdown: true }] });
    io.backup.mockRejectedValueOnce(new Error('disk full'));
    await expect(useAppStore.getState().saveConflictReview('/vault', 'Note.md', 'original', 'merged')).rejects.toThrow('disk full');
    expect(io.write).not.toHaveBeenCalled();
  });
});
