import { readFile } from "@tauri-apps/plugin-fs";
import { IN_TAURI, urlForPath } from "./vault";
import { lruGet, lruSet } from "./boundedLru";
import { LatestWinsQueue } from "./latestWinsQueue";
import { isNotAPdf, sanitizePdfBytes } from "./pdfBytes";
import { primePdfWorker } from "./pdfWorkerPool";
import { pdfThumbInvalidationVersion } from "./pdfThumbInvalidation";
import { backgroundWork } from "./backgroundWorkGovernor";
// `?url` resolves to the worker's asset URL string only — it does NOT pull the
// pdf.js engine into this module's chunk, so the static form is safe here and
// matches `usePdfEditor.ts`. Importing it dynamically instead made Rollup emit
// a separate chunk whose entire body was this one string, costing the first
// thumbnail an extra request.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

export interface PdfThumbSnapshot {
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
}

// A 320 px-wide Letter-page canvas is roughly 0.5 MiB decoded. Keep recent
// thumbnails instant without retaining one full RGBA canvas for every PDF the
// pointer has ever crossed during this process.
const MAX_CACHED_THUMBS = 24;
const thumbCache = new Map<string, Promise<PdfThumbSnapshot>>();
const thumbRenderQueue = new LatestWinsQueue<string, PdfThumbSnapshot>(1, true);

let pdfjsPromise: Promise<PdfJsModule> | null = null;

/**
 * One worker for every thumbnail, instead of one per thumbnail.
 *
 * `getDocument` without a `worker` makes pdf.js create its own and destroy it
 * with the document, so sweeping the pointer down a folder of PDFs booted and
 * tore down a full worker per card — measured at 7 worker boots for 6
 * thumbnails, ~358 ms each. Passing our own worker means pdf.js no longer owns
 * it, so `doc.destroy()` releases the document and leaves the worker warm.
 *
 * It is deliberately NOT the viewer's worker and never the pooled spare: a
 * malformed file that wedges thumbnailing must not be able to wedge the
 * document the user is reading. When one does wedge it, the worker is thrown
 * away so the next thumbnail starts from a clean one.
 */
let thumbWorker: import("pdfjs-dist/legacy/build/pdf.mjs").PDFWorker | null = null;

function thumbWorkerFor(pdfjs: PdfJsModule): import("pdfjs-dist/legacy/build/pdf.mjs").PDFWorker {
  if (!thumbWorker || thumbWorker.destroyed) {
    thumbWorker = new pdfjs.PDFWorker();
  }
  return thumbWorker;
}

function discardThumbWorker(): void {
  const worker = thumbWorker;
  thumbWorker = null;
  try {
    worker?.destroy();
  } catch {
    // Already gone; the next thumbnail builds a fresh one either way.
  }
}

function loadPdfjs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
    pdfjsPromise.catch(() => {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

async function loadPdfBytes(path: string): Promise<Uint8Array> {
  if (IN_TAURI) {
    return readFile(path);
  }
  const response = await fetch(urlForPath(path));
  return new Uint8Array(await response.arrayBuffer());
}

async function openThumbAttempt(
  pdfjs: PdfJsModule,
  source: { url: string; disableAutoFetch: true } | { data: Uint8Array }
) {
  const task = pdfjs.getDocument({ ...source, worker: thumbWorkerFor(pdfjs) });
  try {
    return await task.promise;
  } catch (error) {
    // A rejected parse still owns worker-side document state. In particular,
    // the native URL attempt must finish teardown before the byte fallback or
    // another hover can reuse this worker, even if sanitize rejects the bytes.
    try {
      await task.destroy();
    } catch {
      // Failed teardown leaves the shared worker's state uncertain. A retry
      // must claim a fresh worker, while the original parse error is preserved.
      discardThumbWorker();
    }
    throw error;
  }
}

/**
 * A thumbnail only rasterizes page 1. In Tauri, let pdf.js open the native
 * asset URL and use range requests where the protocol supports them. Streaming
 * remains enabled, so this does not guarantee partial loading or buffering.
 * A failed URL attempt falls back to the full file bytes and header sanitizing,
 * preserving support for protocol failures and junk before the %PDF header.
 */
async function openThumbDocument(pdfjs: PdfJsModule, path: string) {
  if (IN_TAURI) {
    try {
      return await openThumbAttempt(pdfjs, {
        url: urlForPath(path),
        disableAutoFetch: true,
      });
    } catch {
      // fall through to the byte-based path below
    }
  }
  // Validate before this byte attempt engages a worker. Any earlier URL
  // attempt has already finished teardown (or its worker was discarded), so
  // a rejection here leaves no failed document behind on the shared worker.
  const data = await loadPdfBytes(path);
  const clean = sanitizePdfBytes(data).slice(0);
  return openThumbAttempt(pdfjs, { data: clean });
}

async function renderPdfThumb(path: string): Promise<PdfThumbSnapshot> {
  const pdfjs = await loadPdfjs();
  let doc;
  try {
    doc = await openThumbDocument(pdfjs, path);
  } catch (err) {
    // Whatever this file did to the shared worker, the next thumbnail starts
    // from a clean one rather than inheriting a wedged thread — unless the
    // byte fallback rejected it after any earlier URL attempt was cleaned up.
    if (!isNotAPdf(err)) discardThumbWorker();
    throw err;
  }
  let failed = false;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = base.width > 0 ? 320 / base.width : 1;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext("2d");
    if (ctx) await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return { width: vp.width, height: vp.height, canvas };
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    // Only the document is released — pdf.js destroys just the worker it
    // created itself, so the one passed in above stays warm for the next card.
    // The document's teardown talks to that worker, so a discard has to wait
    // for the exchange to finish rather than stranding it.
    try {
      await Promise.resolve(doc.destroy());
    } catch {
      // A failed document teardown must not turn a finished thumbnail into a
      // user-visible preview error, but the next preview needs a fresh worker.
      failed = true;
    }
    if (failed) discardThumbWorker();
  }
}

/**
 * Start rendering a PDF's first page into a detached canvas. The promise is
 * cached so hover prewarm and the visible hover card share the same work.
 */
export function warmPdfThumb(path: string): Promise<PdfThumbSnapshot> {
  // Hovering a PDF is the earliest honest signal that one is about to be
  // opened, and the viewer's worker boot is the single largest term in that
  // open. Booting a spare here takes it off the click's critical path.
  void loadPdfjs()
    .then((pdfjs) => primePdfWorker(() => new pdfjs.PDFWorker()))
    .catch(() => undefined);
  // A cache hit can refer to work that is still queued. Re-prioritize it so
  // moving away and back before the active render completes still paints the
  // PDF the pointer ultimately settled on.
  thumbRenderQueue.prioritize(path);
  const version = pdfThumbInvalidationVersion(path);
  const cacheKey = `${path}\0${version}`;
  const cached = lruGet(thumbCache, cacheKey);
  if (cached) return cached;
  let promise: Promise<PdfThumbSnapshot>;
  promise = thumbRenderQueue.enqueue(path, () => backgroundWork.run("thumbnail", () => renderPdfThumb(path))).catch((err) => {
    // Invalidation followed by a fresh request can leave this older job
    // finishing late; never let its failure delete the replacement entry.
    if (thumbCache.get(cacheKey) === promise) thumbCache.delete(cacheKey);
    throw err;
  });
  lruSet(thumbCache, cacheKey, promise, MAX_CACHED_THUMBS);
  return promise;
}
