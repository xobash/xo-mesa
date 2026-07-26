export class SupersededTaskError extends Error {
  constructor() {
    super("A newer interaction superseded this queued task.");
    this.name = "SupersededTaskError";
  }
}

interface QueuedTask<K, V> {
  id: number;
  key: K;
  run: () => Promise<V>;
  resolve: (value: V) => void;
  reject: (reason: unknown) => void;
}

/**
 * Serial interaction queue that lets active work finish but skips stale queued
 * work. Useful for previews where the newest pointer target is the only result
 * that can still become visible.
 */
export class LatestWinsQueue<K, V> {
  private active = 0;
  private sequence = 0;
  private latestId = 0;
  private readonly queued: QueuedTask<K, V>[] = [];

  constructor(private readonly concurrency = 1) {}

  prioritize(key: K): void {
    for (let i = this.queued.length - 1; i >= 0; i--) {
      if (this.queued[i].key === key) {
        this.latestId = this.queued[i].id;
        return;
      }
    }
    // The requested value is already active or cached. No queued task is
    // needed anymore, so advance beyond every queued generation.
    this.latestId = ++this.sequence;
  }

  enqueue(key: K, run: () => Promise<V>): Promise<V> {
    const id = ++this.sequence;
    this.latestId = id;
    const promise = new Promise<V>((resolve, reject) => {
      this.queued.push({ id, key, run, resolve, reject });
    });
    this.drain();
    return promise;
  }

  private drain(): void {
    const limit = Math.max(1, Math.trunc(this.concurrency));
    while (this.active < limit && this.queued.length) {
      const next = this.queued.pop()!;
      if (next.id !== this.latestId) {
        next.reject(new SupersededTaskError());
        continue;
      }
      this.active++;
      void next
        .run()
        .then(next.resolve, next.reject)
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }
}
