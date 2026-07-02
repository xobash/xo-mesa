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
          thumbQueue.shift()?.();
        });
    };
    if (activeThumbRenders < MAX_ACTIVE_THUMB_RENDERS) run();
    else thumbQueue.push(run);
  });
}

async function loadPdfjs(): Promise<PdfJsModule> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs;
}

async function loadPdfBytes(path: string): Promise<Uint8Array> {
  if (IN_TAURI) {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    return readFile(path);
  }
  const response = await fetch(urlForPath(path));
  return new Uint8Array(await response.arrayBuffer());
}

async function renderPdfThumb(path: string): Promise<PdfThumbSnapshot> {
  const pdfjs = await loadPdfjs();
  const data = await loadPdfBytes(path);
  const doc = await pdfjs.getDocument({ data: sanitizePdfBytes(data).slice(0) }).promise;
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
