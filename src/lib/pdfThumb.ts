import { readFile } from "@tauri-apps/plugin-fs";
import { IN_TAURI, urlForPath } from "./vault";
import { sanitizePdfBytes } from "./pdfBytes";

type PdfJsModule = typeof import("pdfjs-dist");

export interface PdfThumbSnapshot {
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
}

const thumbCache = new Map<string, Promise<PdfThumbSnapshot>>();
const MAX_ACTIVE_THUMB_RENDERS = 1;
let activeThumbRenders = 0;
const thumbQueue: Array<() => void> = [];

function enqueueThumbRender<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeThumbRenders++;
      task()
        .then(resolve, reject)
        .finally(() => {
          activeThumbRenders--;
          // LIFO: newest request first. Sweeping the pointer down the sidebar
          // queues a prewarm per file — the PDF actually being hovered is the
          // most recent one, so it must not wait behind stale prewarms.
          thumbQueue.pop()?.();
        });
    };
    if (activeThumbRenders < MAX_ACTIVE_THUMB_RENDERS) run();
    else thumbQueue.push(run);
  });
}

let pdfjsPromise: Promise<PdfJsModule> | null = null;

function loadPdfjs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url"))
        .default;
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
  const cached = thumbCache.get(path);
  if (cached) return cached;
  const promise = enqueueThumbRender(() => renderPdfThumb(path)).catch((err) => {
    thumbCache.delete(path);
    throw err;
  });
  thumbCache.set(path, promise);
  return promise;
}

/** Drop a cached thumbnail after the file changed on disk, so the next hover
 *  renders the current bytes instead of a stale first page. */
export function invalidatePdfThumb(path: string): void {
  thumbCache.delete(path);
}
