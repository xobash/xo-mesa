import { expect, it, vi } from 'vitest';
import { forgetVaultIndex, indexReadBatches, loadIndexedNotes, type VaultIndexStorage } from './vaultIndex';
import { buildNotes } from './graph';
import type { VaultFile } from '../types';
const files: VaultFile[] = ['a.md', 'b.md'].map(relPath => ({ relPath, name: relPath.slice(0, -3), path: `/vault/${relPath}`, ext: 'md', isMarkdown: true }));
const sha = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
function fixture() {
  let snapshot: Parameters<VaultIndexStorage['save']>[0] | null = null;
  const texts: Record<string, string> = { 'a.md': '[[b]] #tag', 'b.md': '- [ ] task' };
  const storage: VaultIndexStorage = { load: async () => snapshot, save: async value => { snapshot = structuredClone(value); } };
  const read = vi.fn(async (group: VaultFile[]) => group.map(f => texts[f.relPath]));
  const fingerprints = vi.fn(async (rels: string[]) => Promise.all(rels.map(rel => sha(texts[rel]))));
  const options = { root: '/vault', files, read, fingerprints, stopped: () => false, storage };
  return { texts, read, options, storage, snapshot: () => snapshot! };
}
it('reuses unchanged documents and metadata without rereading text', async () => {
  const f = fixture(); const cold = await loadIndexedNotes(f.options);
  expect(cold.notes).toEqual(buildNotes(files, new Map(Object.entries(f.texts))));
  expect(cold.read).toBe(2); f.read.mockClear();
  const warm = await loadIndexedNotes(f.options);
  expect(warm.reused).toBe(2); expect(f.read).not.toHaveBeenCalled();
  expect(warm.cache['a.md']).toBe(f.texts['a.md']); expect(warm.notes).toEqual(cold.notes);
});
it('indexes supported text documents so their atomic links reach the graph', async () => {
  const textFiles: VaultFile[] = [
    { relPath: 'Guide.txt', name: 'Guide', path: '/vault/Guide.txt', ext: 'txt', isMarkdown: false },
    { relPath: 'Log.txt', name: 'Log', path: '/vault/Log.txt', ext: 'txt', isMarkdown: false },
  ];
  const text = { 'Guide.txt': '[[Log]]', 'Log.txt': '' };
  const indexed = await loadIndexedNotes({
    root: '/text-vault', files: textFiles,
    read: async group => group.map(file => text[file.relPath as keyof typeof text]),
    fingerprints: async () => [], stopped: () => false,
    storage: { load: async () => null, save: async () => undefined },
  });
  expect(indexed.notes['Guide.txt'].rawLinks).toEqual(['Log']);
  expect(buildNotes(textFiles, new Map(Object.entries(indexed.cache)))['Log.txt']).toBeDefined();
});
it('detects same-size external edits and drops deleted paths', async () => {
  const f = fixture(); await loadIndexedNotes(f.options);
  f.texts['a.md'] = '[[c]] #new';
  const opened = await loadIndexedNotes({ ...f.options, files: files.slice(0, 1) });
  expect(opened.read).toBe(1); expect(opened.notes['a.md'].rawLinks).toEqual(['c']); expect(opened.cache['b.md']).toBeUndefined();
});
it('rebuilds corrupted cached bytes and ignores unavailable persistence', async () => {
  const f = fixture(); await loadIndexedNotes(f.options);
  f.snapshot().entries[0][1].document.bytes[0] ^= 1;
  expect((await loadIndexedNotes(f.options)).read).toBe(1);
  f.storage.load = async () => { throw new Error('blocked'); }; f.storage.save = async () => { throw new Error('quota'); };
  expect((await loadIndexedNotes(f.options)).read).toBe(2);
});
it('does not publish a cancelled index or borrow a different vault snapshot', async () => {
  const f = fixture(); await loadIndexedNotes(f.options);
  const other = await loadIndexedNotes({ ...f.options, root: '/other' }); expect(other.reused).toBe(0);
  const save = vi.spyOn(f.storage, 'save'); save.mockClear();
  await loadIndexedNotes({ ...f.options, stopped: () => true }); expect(save).not.toHaveBeenCalled();
});
it('reuses note bytes while resolving newly available and renamed images from the current listing', async () => {
  const f = fixture(); f.texts['a.md'] = '![[picture.png]]';
  expect((await loadIndexedNotes(f.options)).notes['a.md'].firstImagePath).toBeUndefined();
  const asset = { relPath: 'picture.png', path: '/vault/picture.png', name: 'picture', ext: 'png', isMarkdown: false };
  const result = await loadIndexedNotes({ ...f.options, files: [...files, asset] });
  expect(result.reused).toBe(2); expect(result.notes['a.md'].firstImagePath).toBe('/vault/picture.png');
});
it('does not reuse metadata after a schema mismatch or a changed asset target', async () => {
  const f = fixture(); await loadIndexedNotes(f.options);
  f.snapshot().version = -1;
  expect((await loadIndexedNotes(f.options)).reused).toBe(0);
});
it('abandons a delayed batch when a newer vault request takes ownership', async () => {
  const f = fixture(); let stopped = false;
  f.read.mockImplementationOnce(async group => { stopped = true; return group.map(file => f.texts[file.relPath]); });
  const save = vi.spyOn(f.storage, 'save');
  const result = await loadIndexedNotes({ ...f.options, stopped: () => stopped });
  expect(save).not.toHaveBeenCalled(); expect(Object.keys(result.cache)).toHaveLength(0);
});

it('bounds small-file count and estimated bytes while isolating oversized documents', () => {
  const tiny = Array.from({ length: 130 }, (_, i) => ({ ...files[0], relPath: `${i}.md`, size: 1 }));
  expect(indexReadBatches(tiny).map(batch => batch.length)).toEqual([64, 64, 2]);
  const large = [1, 3, 9, 1].map(size => ({ ...files[0], size: size * 1024 * 1024 }));
  expect(indexReadBatches(large).map(batch => batch.length)).toEqual([2, 1, 1]);
});

it('forgetting a root prevents an already loading snapshot from being saved again', async () => {
  const f = fixture(); await loadIndexedNotes(f.options);
  const previous = f.snapshot();
  let resume!: () => void;
  f.storage.load = () => new Promise(resolve => { resume = () => resolve(previous); });
  const save = vi.spyOn(f.storage, 'save'); save.mockClear();
  const opening = loadIndexedNotes(f.options);
  await forgetVaultIndex(f.options.root);
  resume(); await opening;
  expect(save).not.toHaveBeenCalled();
});
