import { encodeDocument, type IndexedDocument } from './documentCodec';

/** One worker per build, bounded batches; terminate on completion/cancellation. */
export function createIndexCodec() {
  let worker: Worker | null = null;
  let nextId = 0;
  const pending = new Map<number, {
    resolve: (documents: IndexedDocument[]) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const stop = () => {
    worker?.terminate();
    worker = null;
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error('Index worker stopped'));
    }
    pending.clear();
  };

  try {
    if (typeof Worker !== 'undefined') {
      worker = new Worker(new URL('./indexCodec.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = event => {
        const job = pending.get(event.data.id);
        if (!job) return;
        pending.delete(event.data.id);
        clearTimeout(job.timer);
        if (event.data.error) job.reject(new Error(event.data.error));
        else job.resolve(event.data.documents);
      };
      worker.onerror = stop;
      worker.onmessageerror = stop;
    }
  } catch {
    stop();
  }

  return {
    async encode(texts: string[]): Promise<IndexedDocument[]> {
      if (!texts.length) return [];
      if (!worker) return texts.map(encodeDocument);
      const id = ++nextId;
      try {
        return await new Promise<IndexedDocument[]>((resolve, reject) => {
          const timer = setTimeout(stop, 30_000);
          pending.set(id, { resolve, reject, timer });
          try { worker!.postMessage({ id, texts }); }
          catch { stop(); }
        });
      } catch {
        // The cache is optional. Preserve exact text when workers are unavailable.
        return texts.map(encodeDocument);
      }
    },
    dispose: stop,
  };
}
