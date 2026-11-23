import { afterEach, expect, it, vi } from 'vitest';
import { createIndexSearch } from './indexSearch';
import { encodeDocument } from './documentCodec';
import { indexedContentCache, forkContentCache } from './documentWorkingSet';
class FakeWorker {
  static latest: FakeWorker;
  messages: Record<string, unknown>[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  terminate = vi.fn();
  constructor() { FakeWorker.latest = this; }
  postMessage(message: Record<string, unknown>) { this.messages.push(message); }
  reply(result: unknown) { const id = this.messages[this.messages.length - 1].id; this.onmessage?.({ data: { id, result } }); }
}
afterEach(() => vi.unstubAllGlobals());
it('transports only changed document revisions, including deletion, and disposes ownership', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const files = [{ relPath: 'a', name: 'A', ext: 'md' }, { relPath: 'b', name: 'B', ext: 'md' }];
  const cache = indexedContentCache([['a', encodeDocument('alpha')], ['b', encodeDocument('beta')]]);
  const search = createIndexSearch(cache)!;
  const first = search.run(files, cache, 'alpha'); FakeWorker.latest.reply({ hits: [] }); await first;
  const second = search.run(files, cache, 'beta');
  expect(FakeWorker.latest.messages.slice(-1)[0]).toMatchObject({ changes: [], files: undefined });
  FakeWorker.latest.reply({ hits: [] }); await second;
  const edited = forkContentCache(cache, { a: 'edited' }); delete edited.b;
  const third = search.run(files.slice(0, 1), edited, 'edited');
  expect(FakeWorker.latest.messages.slice(-1)[0]).toMatchObject({ changes: [{ rel: 'a', text: 'edited' }], removed: ['b'] });
  FakeWorker.latest.reply({ hits: [] }); await third;
  search.dispose(); expect(FakeWorker.latest.terminate).toHaveBeenCalledOnce();
});
it('rejects superseded work and ignores late replies', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const cache = indexedContentCache([]), search = createIndexSearch(cache)!;
  const first = search.run([], cache, 'first'); const oldId = FakeWorker.latest.messages.slice(-1)[0].id;
  const rejected = expect(first).rejects.toThrow('superseded');
  const second = search.run([], cache, 'second'); await rejected;
  FakeWorker.latest.onmessage?.({ data: { id: oldId, result: { hits: ['stale'] } } });
  FakeWorker.latest.reply({ hits: ['current'] }); expect(await second).toMatchObject({ hits: ['current'] });
  search.dispose();
});
it('does not create a worker for the compatibility cache', () => {
  vi.stubGlobal('Worker', vi.fn()); expect(createIndexSearch({ a: 'plain' })).toBeNull(); expect(Worker).not.toHaveBeenCalled();
});
it('lets two surfaces share the worker without rejecting each other', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const { acquireSharedIndexSearch } = await import('./indexSearch');
  const cache = indexedContentCache([]);
  const palette = acquireSharedIndexSearch(cache, 'turns')!, pane = acquireSharedIndexSearch(cache, 'turns')!;
  const fromPalette = palette.run([], cache, 'palette');
  const paneOld = pane.run([], cache, 'pane-1');
  const rejected = expect(paneOld).rejects.toThrow('superseded');
  const paneNew = pane.run([], cache, 'pane-2'); // replaces only the pane's own search
  await rejected;
  // The palette's search runs first, then the pane's newest.
  expect(FakeWorker.latest.messages.slice(-1)[0]).toMatchObject({ query: 'palette' });
  FakeWorker.latest.reply({ hits: ['p'] });
  expect(await fromPalette).toMatchObject({ hits: ['p'] });
  await Promise.resolve();
  expect(FakeWorker.latest.messages.slice(-1)[0]).toMatchObject({ query: 'pane-2' });
  FakeWorker.latest.reply({ hits: ['q'] });
  expect(await paneNew).toMatchObject({ hits: ['q'] });
  pane.cancel(); palette.release(); pane.release();
});

it('settles queued and later searches once a vault switch disposes the shared worker', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const { acquireSharedIndexSearch } = await import('./indexSearch');
  const cache = indexedContentCache([]);
  const palette = acquireSharedIndexSearch(cache, 'vault-a')!, pane = acquireSharedIndexSearch(cache, 'vault-a')!;
  const running = palette.run([], cache, 'palette');
  const queued = pane.run([], cache, 'pane');
  const settled = Promise.allSettled([running, queued]);
  acquireSharedIndexSearch(cache, 'vault-b')!.release();
  const outcomes = await settled;
  expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
  await expect(pane.run([], cache, 'again')).rejects.toThrow('disposed');
  palette.release(); pane.release();
});
