/**
 * One abortable FIFO lane for Pi browse calls.
 *
 * The native activity bridge must keep spare request workers for rendered-DOM
 * snapshots. Serializing at the bundled client preserves the old queued
 * browse behavior without letting several long waits occupy that worker pool.
 */
export class AbortableSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const prior = this.tail.catch(() => undefined);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = prior.then(() => held);

    try {
      await waitForTurn(prior, signal);
      if (signal?.aborted) throw abortReason(signal);
      return await operation();
    } finally {
      release();
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Browse cancelled before it started.");
  error.name = "AbortError";
  return error;
}

function waitForTurn(
  prior: Promise<void>,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!signal) return prior;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<void>((resolve, reject) => {
    const cancelled = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", cancelled);
    signal.addEventListener("abort", cancelled, { once: true });
    void prior.then(() => {
      cleanup();
      if (signal.aborted) reject(abortReason(signal));
      else resolve();
    });
  });
}
