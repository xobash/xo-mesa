import { parseMarkdownBlocks, type MarkdownBlock } from './markdownParser';

/** One active parse and one replaceable queued source per mounted preview.
 * Obsolete replies never reach the DOM controller. Output is untrusted; only
 * markdownDom may sanitize and insert these blocks.
 */
export function createMarkdownRenderer(publish: (blocks: MarkdownBlock[]) => void, fail: (error: string) => void) {
  let worker: Worker | null = null;
  let disposed = false;
  let sequence = 0;
  let active = false;
  let queued: { id: number; source: string } | null = null;
  let current: { id: number; source: string } | null = null;
  const fallback = (job: { id: number; source: string }) => {
    if (disposed || job.id !== sequence) return;
    try { publish(parseMarkdownBlocks(job.source)); } catch (error) { fail(String(error)); }
  };
  const pump = () => {
    if (disposed || active || !queued) return;
    const job = queued; queued = null; current = job;
    if (!worker) { fallback(job); current = null; return; }
    active = true;
    try { worker.postMessage(job); } catch { broken(); }
  };
  const broken = () => {
    worker?.terminate(); worker = null; active = false;
    const latest = queued ?? current; queued = current = null;
    if (latest) fallback(latest);
  };
  try {
    worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; blocks: MarkdownBlock[]; error?: string }>) => {
      if (disposed || event.data.id !== current?.id) return;
      active = false;
      if (event.data.id === sequence) {
        try {
          if (event.data.error) fail(event.data.error);
          else publish(event.data.blocks);
        } catch (error) { fail(String(error)); }
      }
      current = null;
      pump();
    };
    worker.onerror = broken;
    worker.onmessageerror = broken;
  } catch { worker = null; }
  return {
    render(source: string) { queued = { id: ++sequence, source }; pump(); },
    dispose() { disposed = true; queued = current = null; worker?.terminate(); worker = null; },
  };
}
