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

  await vi.advanceTimersByTimeAsync(600);
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
