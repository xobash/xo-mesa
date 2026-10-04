import { expect, it, vi } from 'vitest';
import { createDocumentDeltaReader, indexedContentCache, forkContentCache, putIndexedDocument } from './documentWorkingSet';
import { encodeDocument } from './documentCodec';
it('query-only dispatch never enumerates document buckets', () => {
  const cache = indexedContentCache(Array.from({ length: 10000 }, (_, i) => [String(i), encodeDocument('text')] as const));
  const reader = createDocumentDeltaReader();
  expect(reader.read(cache).changes).toHaveLength(10000);
  const walk = vi.spyOn(Map.prototype, Symbol.iterator);
  const next = reader.read(cache);
  const walks = walk.mock.calls.length;
  walk.mockRestore();
  expect(walks).toBe(0);
  expect(next).toEqual({ changes: [], removed: [] });
});
it('tracks same-proxy writes, skipped forks, removals, branches and fresh inventories', () => {
  const reader = createDocumentDeltaReader();
  const base = indexedContentCache([['a', encodeDocument('a')], ['b', encodeDocument('b')]]);
  reader.read(base);
  base.a = 'direct'; delete base.b;
  expect(reader.read(base)).toMatchObject({ changes: [{ rel: 'a', text: 'direct' }], removed: ['b'] });
  const next = forkContentCache(forkContentCache(base, { b: 'restored' }), { c: 'new' });
  expect(reader.read(next).changes.map(item => item.rel).sort()).toEqual(['b', 'c']);
  expect(reader.read(base).removed.sort()).toEqual(['b', 'c']);
  putIndexedDocument(base, 'a', encodeDocument('encoded replacement'));
  expect(reader.read(base).changes).toHaveLength(1);
  expect(reader.read(indexedContentCache([])).removed).toEqual(['a']);
  reader.reset();
  expect(reader.read(next).changes).toHaveLength(3);
});
