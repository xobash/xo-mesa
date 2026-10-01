// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VaultFile, NoteMeta } from './types';

const io = vi.hoisted(() => ({
  scan: vi.fn(), read: vi.fn(), write: vi.fn(), index: vi.fn(), watch: vi.fn(),
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
