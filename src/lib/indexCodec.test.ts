import { afterEach, expect, it, vi } from 'vitest';
import { createIndexCodec } from './indexCodec';
import { indexedContentCache } from './documentWorkingSet';
class BrokenWorker {
  static latest: BrokenWorker;
  onerror?: () => void;
  onmessageerror?: () => void;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { BrokenWorker.latest = this; }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(['onerror', 'onmessageerror'] as const)('preserves exact text after %s and releases the worker', async event => {
  vi.stubGlobal('Worker', BrokenWorker);
  const codec = createIndexCodec();
  const pending = codec.encode(['\ufeff雪\ud800']);
  BrokenWorker.latest[event]?.();
  const documents = await pending;
  expect(indexedContentCache([['a', documents[0]]]).a).toBe('\ufeff雪\ud800');
  expect(BrokenWorker.latest.terminate).toHaveBeenCalledOnce();
});
it('recovers from a worker that never replies and cancels its timeout', async () => {
  vi.useFakeTimers(); vi.stubGlobal('Worker', BrokenWorker);
  const codec = createIndexCodec(), pending = codec.encode(['retained']);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(indexedContentCache([['a', (await pending)[0]]]).a).toBe('retained');
  expect(vi.getTimerCount()).toBe(0);
  expect(BrokenWorker.latest.terminate).toHaveBeenCalledOnce();
});
it('disposal releases pending work without losing its input', async () => {
  vi.stubGlobal('Worker', BrokenWorker);
  const codec = createIndexCodec(), pending = codec.encode(['draft']); codec.dispose();
  expect(indexedContentCache([['a', (await pending)[0]]]).a).toBe('draft');
});
