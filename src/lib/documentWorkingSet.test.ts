import { describe, expect, it } from 'vitest';
import { encodeDocument } from './documentCodec';
import { indexedContentCache, forkContentCache, workingSetStats, documentRevision, documentMayMatch } from './documentWorkingSet';
import { searchVault } from './search';
import { collectVaultTasks, resetVaultTaskMemo } from './tasks';

describe('indexed document working set', () => {
  it('evicts decoded documents without losing content, including empty and unfinished Unicode', () => {
    const texts = { a: 'alpha', b: 'bravo', empty: '', unicode: '雪\ud800' };
    const cache = indexedContentCache(Object.entries(texts).map(([k, v]) => [k, encodeDocument(v)]), 5);
    for (let round = 0; round < 5; round++) for (const [key, text] of Object.entries(texts)) {
      expect(cache[key]).toBe(text); expect(workingSetStats(cache).decodedChars).toBeLessThanOrEqual(5);
    }
  });
  it('forks edits and deletes without decoding the corpus or changing earlier search snapshots', () => {
    const original = indexedContentCache(Array.from({ length: 10000 }, (_, i) => [`${i}.md`, encodeDocument(`text ${i}`)]));
    const next = forkContentCache(original, { '17.md': 'unsaved', 'new.md': 'new' });
    delete next['18.md'];
    expect(workingSetStats(original).decodedChars).toBe(0);
    expect(next['17.md']).toBe('unsaved'); expect(original['17.md']).toBe('text 17');
    expect(next['18.md']).toBeUndefined(); expect(original['18.md']).toBe('text 18');
    expect(Object.keys(next)).toHaveLength(10000);
    expect(documentRevision(next, '20.md')).toBe(documentRevision(original, '20.md'));
  });
  it('preserves exact search ranking, snippets, phrase, Unicode and extension semantics', () => {
    const texts = { 'one.md': 'HELLO hello 雪山 İSTANBUL', 'two.md': 'hello world\n- [ ] task', 'three.txt': 'other hello world' };
    const files = Object.keys(texts).map(relPath => ({ relPath, name: relPath, ext: relPath.split('.').slice(-1)[0] }));
    const cache = indexedContentCache(Object.entries(texts).map(([k, v]) => [k, encodeDocument(v)]), 10);
    for (const query of ['hello', '"hello world"', 'ext:txt hello', '雪山', 'i', 'ext:md i', 'absent', 'type:md', 'one']) {
      expect(searchVault(files, cache, query)).toEqual(searchVault(files, texts, query));
    }
    expect(documentMayMatch(cache, 'one.md', 'zebra')).toBe(false);
  });
  it('keeps whole-vault tasks visible after decoded-text eviction and an unrelated edit', () => {
    resetVaultTaskMemo();
    const cache = indexedContentCache([['a', encodeDocument('- [ ] task a')], ['b', encodeDocument('- [x] task b')]], 1);
    const notes = { a: { title: 'A' }, b: { title: 'B' } };
    const tasks = collectVaultTasks(notes, cache, 'a');
    expect(tasks).toHaveLength(2);
    const next = forkContentCache(cache, { a: '- [x] task a' });
    expect(collectVaultTasks(notes, next, 'a').every(t => t.checked)).toBe(true);
    expect(workingSetStats(cache).decodedChars).toBe(0);
  });
});
