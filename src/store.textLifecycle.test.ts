// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VaultFile, NoteMeta } from './types';

const io = vi.hoisted(() => ({
  scan: vi.fn(), read: vi.fn(), write: vi.fn(), index: vi.fn(), watch: vi.fn(), history: vi.fn(),
}));
vi.mock('./lib/vault', async original => ({
  ...await original<object>(),
  assertVaultRootAvailable: async () => {},
  scanVault: io.scan,
  readNoteResult: io.read,
  writeNote: io.write,
  watchVault: io.watch,
  recoverWriteArtifacts: async () => ({ restored: [], removed: [] }),
}));
vi.mock('./lib/textRevisionHistory', async original => ({ ...await original<object>(), recordTextRevisionAsync: io.history }));
vi.mock('./lib/vaultIndex', async original => ({ ...await original<object>(), loadIndexedNotes: io.index }));
import { useAppStore } from './store';
const initial = useAppStore.getState();
const file = (root: string, relPath: string): VaultFile => ({
  path: `${root}/${relPath}`, relPath, name: relPath.split('/').pop()!,
  ext: relPath.split('.').pop()!, isMarkdown: relPath.endsWith('.md'),
});
const metadata = (relPath: string): NoteMeta => ({
  relPath, title: relPath, rawLinks: [], tags: [], aliases: [], firstImagePath: undefined,
});
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
type Indexed = Awaited<ReturnType<typeof import('./lib/vaultIndex').loadIndexedNotes>>;
const indexed = (root: string, text: string): Indexed => ({
  notes: { 'Note.md': metadata('Note.md') }, cache: { 'Note.md': text, 'Code.py': `source from ${root}` },
  reused: 0, read: 2, skipped: [], failed: [],
});
beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState(initial);
  io.scan.mockImplementation(async (root: string) => [file(root, 'Note.md'), file(root, 'Code.py')]);
  io.read.mockResolvedValue({ ok: true, text: 'original' });
  io.write.mockResolvedValue(undefined);
  io.watch.mockResolvedValue(() => {});
  io.history.mockResolvedValue({ id: 'revision' });
  io.index.mockResolvedValue(indexed('/vault', 'original'));
});
afterEach(async () => { await useAppStore.getState().flushSave(); useAppStore.setState(initial); });

it('opens and saves the selected document while unrelated indexing is held', async () => {
  const held = deferred<Indexed>(); io.index.mockReturnValueOnce(held.promise);
  await useAppStore.getState().openVault('/vault');
  expect(useAppStore.getState()).toMatchObject({ activePath: 'Note.md', content: 'original', activeContentState: 'ready', indexingTextFiles: 2 });
  useAppStore.getState().setContentFromEditor('edited');
  await useAppStore.getState().flushSave();
  expect(io.write).toHaveBeenCalledWith(expect.objectContaining({ relPath: 'Note.md' }), 'edited', 'original');
  held.resolve(indexed('/vault', 'old index value'));
  await vi.waitFor(() => expect(useAppStore.getState().indexingTextFiles).toBe(0));
  expect(useAppStore.getState().contentCache['Note.md']).toBe('edited');
  expect(useAppStore.getState().contentCache['Code.py']).toBe('source from /vault');
});

it('keeps a failed read out of the save baseline and retries successfully', async () => {
  const held = deferred<Indexed>(); io.index.mockReturnValueOnce(held.promise);
  io.read.mockResolvedValueOnce({ ok: false, text: '' }).mockResolvedValue({ ok: true, text: 'recovered' });
  await useAppStore.getState().openVault('/vault');
  expect(useAppStore.getState().activeContentState).toBe('failed');
  expect(useAppStore.getState().contentCache['Note.md']).toBeUndefined();
  useAppStore.getState().setContentFromEditor('wrong empty save');
  await useAppStore.getState().flushSave();
  expect(io.write).not.toHaveBeenCalled();
  await useAppStore.getState().loadActiveContent();
  expect(useAppStore.getState()).toMatchObject({ content: 'recovered', activeContentState: 'ready' });
  held.resolve(indexed('/vault', 'stale'));
  await vi.waitFor(() => expect(useAppStore.getState().indexingTextFiles).toBe(0));
  expect(useAppStore.getState().contentCache['Note.md']).toBe('recovered');
});

it('does not publish an obsolete index after a vault switch', async () => {
  const old = deferred<Indexed>(); io.index.mockReturnValueOnce(old.promise);
  await useAppStore.getState().openVault('/first');
  await useAppStore.getState().openVault('/second');
  old.resolve(indexed('/first', 'old content'));
  await Promise.resolve(); await Promise.resolve();
  expect(useAppStore.getState().vaultPath).toBe('/second');
  expect(useAppStore.getState().contentCache['Code.py']).toBe('source from /vault');
});

it('requires a deliberate load for an over-limit document', async () => {
  io.scan.mockImplementation(async (root: string) => [{ ...file(root, 'Note.md'), size: 9 * 1024 * 1024 }]);
  const held = deferred<Indexed>(); io.index.mockReturnValueOnce(held.promise);
  await useAppStore.getState().openVault('/vault');
  expect(useAppStore.getState().activeContentState).toBe('size-limit');
  expect(io.read).not.toHaveBeenCalled();
  await useAppStore.getState().loadActiveContent();
  expect(useAppStore.getState().activeContentState).toBe('ready');
  expect(useAppStore.getState().content).toBe('original');
  held.resolve({ ...indexed('/vault', 'stale'), skipped: ['Note.md'], cache: {} });
});

async function modifyFromOutside() {
  const callback = io.watch.mock.lastCall?.[1] as (events: Array<{ kind: string; paths: string[] }>) => Promise<void>;
  callback([{ kind: 'modify', paths: ['/vault/Note.md'] }]);
  await vi.waitFor(() => expect(useAppStore.getState().status).toContain('File changed outside Mesa'));
}
it('preserves the known clean text in history before publishing an external edit', async () => {
  await useAppStore.getState().openVault('/vault');
  await vi.waitFor(() => expect(useAppStore.getState().indexingTextFiles).toBe(0));
  io.read.mockResolvedValue({ ok: true, text: 'external edit' });
  await modifyFromOutside();
  expect(io.history).toHaveBeenCalledWith('/vault', 'Note.md', 'original');
  expect(useAppStore.getState().content).toBe('external edit');
  expect(useAppStore.getState().status).toContain('Previous text kept in document history');
});
it('keeps unsaved text and its original save precondition when Pi edits the same file', async () => {
  await useAppStore.getState().openVault('/vault');
  await vi.waitFor(() => expect(useAppStore.getState().indexingTextFiles).toBe(0));
  useAppStore.getState().setContentFromEditor('local edit');
  io.read.mockResolvedValue({ ok: true, text: 'Pi edit' });
  await modifyFromOutside();
  expect(useAppStore.getState().content).toBe('local edit');
  expect(useAppStore.getState().status).toContain('unsaved text was kept');
  expect(io.history).not.toHaveBeenCalled();
  await useAppStore.getState().flushSave();
  expect(io.write).toHaveBeenCalledWith(expect.objectContaining({ relPath: 'Note.md' }), 'local edit', 'original');
});
it('reports unavailable history while still showing a successful external read', async () => {
  await useAppStore.getState().openVault('/vault');
  await vi.waitFor(() => expect(useAppStore.getState().indexingTextFiles).toBe(0));
  io.history.mockResolvedValue(null);
  io.read.mockResolvedValue({ ok: true, text: 'external edit' });
  await modifyFromOutside();
  expect(useAppStore.getState().content).toBe('external edit');
  expect(useAppStore.getState().status).toContain('history is unavailable');
});

it('keeps text typed while external-change history storage is still pending', async () => {
  await useAppStore.getState().openVault('/vault');
  await vi.waitFor(() => expect(useAppStore.getState().indexingTextFiles).toBe(0));
  const held = deferred<{ id: string }>();
  io.history.mockReturnValueOnce(held.promise);
  io.read.mockResolvedValue({ ok: true, text: 'external edit' });
  io.watch.mock.lastCall![1]([{ kind: 'modify', paths: ['/vault/Note.md'] }]);
  await vi.waitFor(() => expect(io.history).toHaveBeenCalledOnce());
  useAppStore.getState().setContentFromEditor('new local typing');
  held.resolve({ id: 'retained' });
  await vi.waitFor(() => expect(useAppStore.getState().status).toContain('unsaved text was kept'));
  expect(useAppStore.getState().content).toBe('new local typing');
});
it('does not publish an old vault refresh after pending history finishes', async () => {
  await useAppStore.getState().openVault('/vault');
  await vi.waitFor(() => expect(useAppStore.getState().indexingTextFiles).toBe(0));
  const held = deferred<{ id: string }>();
  io.history.mockReturnValueOnce(held.promise);
  io.read.mockResolvedValueOnce({ ok: true, text: 'obsolete external edit' });
  io.watch.mock.lastCall![1]([{ kind: 'modify', paths: ['/vault/Note.md'] }]);
  await vi.waitFor(() => expect(io.history).toHaveBeenCalledOnce());
  await useAppStore.getState().openVault('/second');
  held.resolve({ id: 'retained' });
  await Promise.resolve(); await Promise.resolve();
  expect(useAppStore.getState().vaultPath).toBe('/second');
  expect(useAppStore.getState().content).toBe('original');
});
