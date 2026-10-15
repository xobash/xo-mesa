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
    /** `markdown[i]` is false when `texts[i]` is another text file, not a Markdown note. */
    async encode(texts: string[], markdown: readonly boolean[] = []): Promise<IndexedDocument[]> {
      if (!texts.length) return [];
      const local = () => texts.map((text, i) => encodeDocument(text, markdown[i] ?? true));
      if (!worker) return local();
      const id = ++nextId;
      try {
        return await new Promise<IndexedDocument[]>((resolve, reject) => {
          const timer = setTimeout(stop, 30_000);
          pending.set(id, { resolve, reject, timer });
          try { worker!.postMessage({ id, texts, markdown }); }
          catch { stop(); }
        });
      } catch {
        // The cache is optional. Preserve exact text when workers are unavailable.
        return local();
      }
    },
    dispose: stop,
  };
}
