import { readFile } from "@tauri-apps/plugin-fs";
import { IN_TAURI, urlForPath } from "./vault";
import { lruGet, lruSet } from "./boundedLru";
import { LatestWinsQueue } from "./latestWinsQueue";
import { sanitizePdfBytes } from "./pdfBytes";
// `?url` resolves to the worker's asset URL string only — it does NOT pull the
// pdf.js engine into this module's chunk, so the static form is safe here and
// matches `usePdfEditor.ts`. Importing it dynamically instead made Rollup emit
// a separate chunk whose entire body was this one string, costing the first
// thumbnail an extra request.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

type PdfJsModule = typeof import("pdfjs-dist");

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
const thumbRenderQueue = new LatestWinsQueue<string, PdfThumbSnapshot>(1);

let pdfjsPromise: Promise<PdfJsModule> | null = null;

function loadPdfjs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
    pdfjsPromise.catch(() => {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

/** Idle-time warmup: import pdf.js before the first hover needs it, so module
 *  parse never lands on the interaction path. Safe to call repeatedly. */
export function warmPdfEngine(): void {
  void loadPdfjs().catch(() => undefined);
}

async function loadPdfBytes(path: string): Promise<Uint8Array> {
  if (IN_TAURI) {
    return readFile(path);
  }
  const response = await fetch(urlForPath(path));
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * A thumbnail only rasterizes page 1, so it should never pull the whole file
 * through IPC and parse every object. In Tauri, hand pdf.js the asset-protocol
 * URL: with auto-fetch disabled it range-requests just the chunks page 1 needs
 * (header, xref, one page tree branch) — on a multi-hundred-MB scan that is the
 * difference between milliseconds and seconds. Files with junk before the
 * %PDF header (or a protocol quirk) fall back to the full-bytes + sanitize path.
 */
async function openThumbDocument(pdfjs: PdfJsModule, path: string) {
  if (IN_TAURI) {
    try {
      return await pdfjs.getDocument({
        url: urlForPath(path),
        disableAutoFetch: true,
      }).promise;
    } catch {
      // fall through to the byte-based path below
    }
  }
  const data = await loadPdfBytes(path);
  return pdfjs.getDocument({ data: sanitizePdfBytes(data).slice(0) }).promise;
}

async function renderPdfThumb(path: string): Promise<PdfThumbSnapshot> {
  const pdfjs = await loadPdfjs();
  const doc = await openThumbDocument(pdfjs, path);
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
  } finally {
    doc.destroy();
  }
}

/**
 * Start rendering a PDF's first page into a detached canvas. The promise is
 * cached so hover prewarm and the visible hover card share the same work.
 */
export function warmPdfThumb(path: string): Promise<PdfThumbSnapshot> {
  // A cache hit can refer to work that is still queued. Re-prioritize it so
  // moving away and back before the active render completes still paints the
  // PDF the pointer ultimately settled on.
  thumbRenderQueue.prioritize(path);
  const cached = lruGet(thumbCache, path);
  if (cached) return cached;
  let promise: Promise<PdfThumbSnapshot>;
  promise = thumbRenderQueue.enqueue(path, () => renderPdfThumb(path)).catch((err) => {
    // Invalidation followed by a fresh request can leave this older job
    // finishing late; never let its failure delete the replacement entry.
    if (thumbCache.get(path) === promise) thumbCache.delete(path);
    throw err;
  });
  lruSet(thumbCache, path, promise, MAX_CACHED_THUMBS);
  return promise;
}

/** Drop a cached thumbnail after the file changed on disk, so the next hover
 *  renders the current bytes instead of a stale first page. */
export function invalidatePdfThumb(path: string): void {
  thumbCache.delete(path);
}
