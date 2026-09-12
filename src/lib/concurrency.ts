/**
 * Run an async task over every item without creating one live promise per item.
 * The worker loop preserves input coverage while bounding in-flight work and
 * its associated IPC payloads/buffers.
 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
  /** Stop scheduling new work. Already-started tasks are allowed to settle. */
  stopped?: () => boolean
): Promise<void> {
  if (!items.length) return;
  const limit = Math.max(1, Math.min(items.length, Math.trunc(concurrency) || 1));
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length && !stopped?.()) {
      const index = nextIndex++;
      await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
}
