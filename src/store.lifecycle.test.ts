// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ available: vi.fn(async (_root: string) => {}), scan: vi.fn(async (_root: string): Promise<never[]> => []), watch: vi.fn(async () => () => {}), read: vi.fn(async () => ({ ok: true, text: 'original' })), write: vi.fn(async () => {}), backup: vi.fn(async () => ({})), create: vi.fn(), folder: vi.fn(), copy: vi.fn(), import: vi.fn(), readText: vi.fn() }));
vi.mock('./lib/vault', async original => ({ ...await original<object>(), assertVaultRootAvailable: io.available, scanVault: io.scan, watchVault: io.watch, readNoteResult: io.read, readReviewText: async () => (await io.read()).text, writeNote: io.write, writeVaultTextFile: io.backup, createNote: io.create, createFolder: io.folder, copyVaultFile: io.copy, importDroppedPaths: io.import, readNote: io.readText, recoverWriteArtifacts: async () => ({ restored: [], removed: [] }) }));
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
  it('does not carry the side-by-side file path into another vault', async () => {
    useAppStore.setState({ vaultPath: '/old', activePath: 'Live.md', docSplit: { active: 'doc2', other: 'README.md' } });
    await useAppStore.getState().openVault('/new');
    expect(useAppStore.getState()).toMatchObject({ vaultPath: '/new', docSplit: { active: 'doc2', other: null } });
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


it.each((['newNote', 'createChildNote', 'openDailyNote', 'addCalendarEvent', 'addPersonalTask', 'createChildFolder', 'duplicateEntry', 'importDropped'] as const)
  .flatMap(action => [[action, '/new'], [action, '/old']] as const))(
  'does not publish a completed %s into the vault opened at %s', async (action, nextRoot) => {
    const held = deferred();
    const created = { relPath: 'New.md', path: '/old/New.md', name: 'New', ext: 'md', isMarkdown: true };
    const oldFile = { ...created, relPath: 'Old.md', path: '/old/Old.md' };
    useAppStore.setState({ vaultPath: '/old', files: [oldFile], notes: {}, contentCache: {}, openTabs: [], activePath: null });
    io.create.mockImplementation(async () => { await held.promise; return created; });
    io.folder.mockImplementation(async () => held.promise);
    io.copy.mockImplementation(async () => { await held.promise; return created; });
    io.import.mockImplementation(async () => { await held.promise; return { created: [created], failures: [], cancelled: false }; });
    const state = useAppStore.getState();
    const pending = action === 'createChildNote' ? state.createChildNote('Folder')
      : action === 'createChildFolder' ? state.createChildFolder('Folder')
      : action === 'openDailyNote' ? state.openDailyNote('2026-10-13')
      : action === 'addCalendarEvent' ? state.addCalendarEvent('2026-10-13', 'Meeting')
      : action === 'addPersonalTask' ? state.addPersonalTask('Task')
      : action === 'duplicateEntry' ? state.duplicateEntry('Old.md')
      : action === 'importDropped' ? state.importDropped(['/incoming/New.md']) : state.newNote();
    await state.openVault(nextRoot);
    const current = useAppStore.getState();
    held.resolve();
    await pending;
    expect(useAppStore.getState()).toMatchObject({
      vaultPath: nextRoot, files: current.files, contentCache: current.contentCache,
      notes: current.notes, activePath: current.activePath, emptyFolders: current.emptyFolders,
      calendarEvents: current.calendarEvents, status: current.status,
    });
    expect(io.write).not.toHaveBeenCalled();
  });

it.each(['addCalendarEvent', 'removeCalendarEvent', 'addPersonalTask', 'updateTask'] as const)(
  'does not apply a delayed %s to the next vault with the same file name', async (action) => {
    const held = deferred();
    const relPath = action.includes('Calendar') ? 'calendar.json' : 'Tasks.md';
    const file = { relPath, path: `/old/${relPath}`, name: relPath, ext: relPath.split('.').pop()!, isMarkdown: relPath.endsWith('.md') };
    useAppStore.setState({ vaultPath: '/old', files: [file], contentCache: {}, notes: {},
      ensureContent: async () => { await held.promise; return '- [ ] old task'; } });
    const state = useAppStore.getState();
    const pending = action === 'addCalendarEvent' ? state.addCalendarEvent('2026-10-13', 'Meeting')
      : action === 'removeCalendarEvent' ? state.removeCalendarEvent('2026-10-13', 'Meeting')
      : action === 'addPersonalTask' ? state.addPersonalTask('new task') : state.updateTask(relPath, 0, { checked: true });
    useAppStore.setState({ vaultPath: '/new', files: [{ ...file, path: `/new/${relPath}` }], contentCache: { [relPath]: '- [ ] new vault task' }, status: 'new workspace' });
    held.resolve();
    await pending;
    expect(useAppStore.getState().contentCache[relPath]).toBe('- [ ] new vault task');
    expect(useAppStore.getState().status).toBe('new workspace');
    expect(io.write).not.toHaveBeenCalled();
  });

it('preserves edits and new catalog entries while imported Markdown is being read', async () => {
  const held = deferred();
  const started = deferred();
  const imported = { relPath: 'Imported.md', path: '/vault/Imported.md', name: 'Imported', ext: 'md', isMarkdown: true };
  const existing = { ...imported, relPath: 'Existing.md', path: '/vault/Existing.md' };
  const added = { ...imported, relPath: 'Added.md', path: '/vault/Added.md' };
  useAppStore.setState({ vaultPath: '/vault', files: [existing], notes: {}, contentCache: { 'Existing.md': 'before edit' }, selectFile: vi.fn() });
  io.import.mockResolvedValue({ created: [imported], failures: [], cancelled: false });
  io.readText.mockImplementation(async () => { started.resolve(); await held.promise; return 'imported text'; });
  const pending = useAppStore.getState().importDropped(['/incoming/Imported.md']);
  await started.promise;
  useAppStore.setState({ files: [existing, added], contentCache: { 'Existing.md': 'new edit', 'Added.md': 'new note' } });
  held.resolve();
  await pending;
  expect(useAppStore.getState().contentCache).toMatchObject({ 'Existing.md': 'new edit', 'Added.md': 'new note', 'Imported.md': 'imported text' });
  expect(useAppStore.getState().files.map(file => file.relPath)).toEqual(['Added.md', 'Existing.md', 'Imported.md']);
});
