import { afterEach, expect, it, vi } from 'vitest';
const codec = vi.hoisted(() => ({ encode: vi.fn() }));
vi.mock('./documentCodec', async original => {
  const actual = await original<typeof import('./documentCodec')>();
  codec.encode.mockImplementation(actual.encodeDocument);
  return { ...actual, encodeDocument: codec.encode };
});
import { encodeDocument } from './documentCodec';
import { documentEntries, forkContentCache, indexedContentCache } from './documentWorkingSet';

afterEach(() => { vi.useRealTimers(); });

it('compacts only the latest revision of a typing burst while older forks keep their text', async () => {
  vi.useFakeTimers();
  const forks = [indexedContentCache([['note.md', encodeDocument('start')]])];
  for (let i = 1; i <= 200; i++) forks.push(forkContentCache(forks[i - 1], { 'note.md': `revision ${i}` }));
  codec.encode.mockClear();

  await vi.advanceTimersByTimeAsync(2100);
  vi.useRealTimers();
  await vi.waitFor(() => expect([...documentEntries(forks[200])][0].document).toBeDefined());

  expect(codec.encode).toHaveBeenCalledTimes(1);
  expect(codec.encode).toHaveBeenCalledWith('revision 200', true);
  const latest = [...documentEntries(forks[200])][0];
  expect(latest.document).toBeDefined();
  expect(forks[200]['note.md']).toBe('revision 200');
  expect(forks[1]['note.md']).toBe('revision 1');
  expect(forks[0]['note.md']).toBe('start');
});

it('waits for a quiet period before encoding, so steady typing encodes once', async () => {
  vi.useFakeTimers();
  let cache = indexedContentCache([['draft.md', encodeDocument('start')]]);
  codec.encode.mockClear();
  // One keystroke-sized revision every 700 ms for 7 seconds.
  for (let i = 1; i <= 10; i++) {
    cache = forkContentCache(cache, { 'draft.md': `typing ${i}` });
    await vi.advanceTimersByTimeAsync(700);
  }
  expect(codec.encode).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1400);
  vi.useRealTimers();
  await vi.waitFor(() => expect([...documentEntries(cache)][0].document).toBeDefined());
  expect(codec.encode).toHaveBeenCalledTimes(1);
  expect(codec.encode).toHaveBeenCalledWith('typing 10', true);
  expect(cache['draft.md']).toBe('typing 10');
});

it('reuses one codec worker across compactions and releases it when idle', async () => {
  const workers: { terminated: boolean }[] = [];
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    record = { terminated: false };
    constructor() { workers.push(this.record); }
    postMessage(data: { id: number; texts: string[]; markdown: boolean[] }) {
      queueMicrotask(() => this.onmessage?.({ data: { id: data.id, documents: data.texts.map((text, i) => encodeDocument(text, data.markdown[i] ?? true)) } }));
    }
    terminate() { this.record.terminated = true; }
  }
  vi.stubGlobal('Worker', FakeWorker);
  try {
    vi.useFakeTimers();
    let cache = indexedContentCache([['a.md', encodeDocument('a')]]);
    cache = forkContentCache(cache, { 'a.md': 'first' });
    await vi.advanceTimersByTimeAsync(2100);
    cache = forkContentCache(cache, { 'a.md': 'second' });
    await vi.advanceTimersByTimeAsync(2100);
    expect([...documentEntries(cache)][0].document).toBeDefined();
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(workers[0].terminated).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});
