// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { useAppStore } from './store';
import { createNote, DEMO_ROOT, readNote } from './lib/vault';
import { findSyncConflicts } from './lib/syncConflicts';
import { clearTextRevisionsForTests, listTextRevisionsAsync } from './lib/textRevisionHistory';
import { indexedContentCache, isIndexedCache, workingSetStats } from './lib/documentWorkingSet';
import { encodeDocument } from './lib/documentCodec';
const initial = useAppStore.getState();
afterEach(() => { clearTextRevisionsForTests(); useAppStore.setState(initial); });
it('saves reviewed text through the real store and preserves both source versions', async () => {
  const original = await createNote(DEMO_ROOT, 'Review proof.md', 'local version');
  const copy = await createNote(DEMO_ROOT, 'Review proof (conflict from device 2026-09-08).md', 'remote version');
  useAppStore.setState({ vaultPath: DEMO_ROOT, files: [original, copy], notes: {}, contentCache: { [original.relPath]: 'local version' }, activePath: original.relPath, content: 'local version' });
  await useAppStore.getState().saveConflictReview(DEMO_ROOT, original.relPath, 'local version', 'reviewed version', copy.relPath);
  const reviewedCopy = useAppStore.getState().files.find(file => file.relPath.includes('(reviewed '))!;
  expect(await readNote(original)).toBe('reviewed version'); expect(await readNote(reviewedCopy)).toBe('remote version');
  const backup = useAppStore.getState().files.find(file => file.relPath.includes('(before sync review'))!;
  expect(backup).toBeDefined(); expect(await readNote(backup)).toBe('local version');
  expect(findSyncConflicts(useAppStore.getState().files)).toEqual([]);
  expect(useAppStore.getState().content).toBe('reviewed version'); expect(useAppStore.getState().textSaveState.pending).toBe(0);
});
it('stores and restores bounded local text revisions through the store', async () => {
  const note = await createNote(DEMO_ROOT, 'Revision proof.md', 'first version');
  useAppStore.setState({ vaultPath: DEMO_ROOT, files: [note], notes: {}, contentCache: { [note.relPath]: 'first version' }, activePath: note.relPath, content: 'first version' });

  useAppStore.getState().setContentFromEditor('second version');
  await useAppStore.getState().flushSave();
  const revision = (await listTextRevisionsAsync(DEMO_ROOT, note.relPath))[0];
  expect(revision.content).toBe('first version');

  await useAppStore.getState().restoreTextRevision(revision.id);
  expect(await readNote(note)).toBe('first version');
  expect(useAppStore.getState().content).toBe('first version');
});
it('keeps a verified save successful when local revision storage is full', async () => {
  const note = await createNote(DEMO_ROOT, 'Quota proof.md', 'first version');
  useAppStore.setState({ vaultPath: DEMO_ROOT, files: [note], notes: {}, contentCache: { [note.relPath]: 'first version' }, activePath: note.relPath, content: 'first version' });
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
  try {
    useAppStore.getState().setContentFromEditor('second version');
    await useAppStore.getState().flushSave();
    expect(await readNote(note)).toBe('second version');
    expect(useAppStore.getState().textSaveState.failed).toBe(0);
  } finally {
    Storage.prototype.setItem = original;
  }
});
it('keeps an indexed content cache indexed and undecoded when the reviewed copy moves', async () => {
  const original = await createNote(DEMO_ROOT, 'Indexed review.md', 'local version');
  const copy = await createNote(DEMO_ROOT, 'Indexed review (conflict from device 2026-09-08).md', 'remote version');
  const cache = indexedContentCache([
    [original.relPath, encodeDocument('local version')],
    [copy.relPath, encodeDocument('remote version')],
    ['Other.md', encodeDocument('unrelated text')],
  ]);
  useAppStore.setState({ vaultPath: DEMO_ROOT, files: [original, copy], notes: {}, contentCache: cache, activePath: original.relPath, content: 'local version' });
  await useAppStore.getState().saveConflictReview(DEMO_ROOT, original.relPath, 'local version', 'reviewed version', copy.relPath);
  const next = useAppStore.getState().contentCache;
  const reviewed = useAppStore.getState().files.find(file => file.relPath.includes('(reviewed '))!;
  expect(isIndexedCache(next)).toBe(true);
  expect(workingSetStats(next).decodedDocuments).toBe(0);
  expect(copy.relPath in next).toBe(false);
  expect(next[reviewed.relPath]).toBe('remote version');
  expect(next['Other.md']).toBe('unrelated text');
});
