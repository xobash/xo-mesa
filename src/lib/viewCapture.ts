// Rasterize what the user sees in the main workspace view for Pi's mesa_view tool.
// Only pixel layers (canvas, img) are composited; frames and text are reported, not drawn.

import { invoke } from "@tauri-apps/api/core";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ViewCaptureMeta {
  path: string | null;
  view: string;
  width: number;
  height: number;
  layers: number;
  notes: string[];
}

export interface ViewCapture {
  meta: ViewCaptureMeta;
  image: Blob | null;
}

/** Long-side pixel cap; larger images cost model context without adding legible detail. */
export const VIEW_CAPTURE_MAX_SIDE = 1568;

export function intersect(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

export function union(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.left + r.width));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  return { left, top, width: right - left, height: bottom - top };
}

/** Device pixels per CSS pixel for the output, capped at the long-side limit. */
export function captureScale(width: number, height: number, devicePixelRatio: number, maxSide = VIEW_CAPTURE_MAX_SIDE): number {
  const longSide = Math.max(width, height);
  if (longSide <= 0) return 0;
  return Math.min(Math.max(devicePixelRatio, 1), maxSide / longSide);
}

/** The box an image's content occupies inside its element for a given object-fit. */
export function contentBox(box: Rect, naturalWidth: number, naturalHeight: number, fit: string): Rect {
  if (naturalWidth <= 0 || naturalHeight <= 0 || (fit !== "contain" && fit !== "cover" && fit !== "scale-down")) return box;
  const ratio = fit === "cover"
    ? Math.max(box.width / naturalWidth, box.height / naturalHeight)
    : Math.min(box.width / naturalWidth, box.height / naturalHeight, fit === "scale-down" ? 1 : Infinity);
  const width = naturalWidth * ratio;
  const height = naturalHeight * ratio;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/** Map a visible part of a drawn box back to source pixels. */
export function sourceRect(visible: Rect, drawn: Rect, sourceWidth: number, sourceHeight: number): Rect {
  const sx = sourceWidth / drawn.width;
  const sy = sourceHeight / drawn.height;
  return {
    left: (visible.left - drawn.left) * sx,
    top: (visible.top - drawn.top) * sy,
    width: visible.width * sx,
    height: visible.height * sy,
  };
}

function toRect(r: DOMRect): Rect {
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** The part of an element not clipped by overflow ancestors up to and including the root. */
function visibleRect(el: Element, root: Element): Rect | null {
  let rect: Rect | null = toRect(el.getBoundingClientRect());
  for (let node = el.parentElement; node && rect; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node === root || style.overflow !== "visible" || style.overflowX !== "visible" || style.overflowY !== "visible") {
      rect = intersect(rect, toRect(node.getBoundingClientRect()));
    }
    if (node === root) break;
  }
  return rect && intersect(rect, { left: 0, top: 0, width: innerWidth, height: innerHeight });
}

function hidden(el: Element, root: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.getAttribute("aria-hidden") === "true") return true;
    const style = getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return true;
    if (node === root) break;
  }
  return false;
}

/** Reload an image in CORS mode (the asset protocol allows the app origin) and
 *  rasterize it at its natural size, so cropping works the same for SVG and bitmaps. */
async function drawableImage(img: HTMLImageElement): Promise<HTMLCanvasElement | null> {
  const copy = await new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = img.currentSrc || img.src;
  });
  if (!copy) return null;
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d")?.drawImage(copy, 0, 0, canvas.width, canvas.height);
  return canvas;
}

interface Layer {
  source: CanvasImageSource;
  sourceWidth: number;
  sourceHeight: number;
  drawn: Rect;
  visible: Rect;
}

/** Composite the visible canvas and image layers inside root into one JPEG. */
export async function captureView(root: Element, path: string | null, view: string): Promise<ViewCapture> {
  const notes: string[] = [];
  const layers: Layer[] = [];
  for (const el of Array.from(root.querySelectorAll("canvas, img, iframe, video"))) {
    if (hidden(el, root)) continue;
    const visible = visibleRect(el, root);
    if (!visible) continue;
    if (el instanceof HTMLCanvasElement) {
      if (el.width > 0 && el.height > 0) {
        layers.push({ source: el, sourceWidth: el.width, sourceHeight: el.height, drawn: toRect(el.getBoundingClientRect()), visible });
      }
    } else if (el instanceof HTMLImageElement) {
      const image = el.complete && el.naturalWidth > 0 ? await drawableImage(el) : null;
      if (!image) {
        notes.push("An image in the view could not be captured.");
        continue;
      }
      const drawn = contentBox(toRect(el.getBoundingClientRect()), el.naturalWidth, el.naturalHeight, getComputedStyle(el).objectFit);
      const shown = intersect(visible, drawn);
      if (shown) layers.push({ source: image, sourceWidth: image.width, sourceHeight: image.height, drawn, visible: shown });
    } else if (el instanceof HTMLIFrameElement) {
      notes.push("The view contains an embedded page or native PDF frame whose pixels Mesa cannot capture; for web pages use browse_read.");
    } else {
      notes.push("The view contains a video whose frame was not captured.");
    }
  }
  const bounds = union(layers.map((layer) => layer.visible));
  if (!bounds) {
    notes.push(path
      ? `No rendered pixel layers are visible. If this is a text document, read ${path} directly.`
      : "No document is open in the Mesa view.");
    return { meta: { path, view, width: 0, height: 0, layers: 0, notes: [...new Set(notes)] }, image: null };
  }
  const scale = captureScale(bounds.width, bounds.height, devicePixelRatio);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bounds.width * scale));
  canvas.height = Math.max(1, Math.round(bounds.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is unavailable");
  // JPEG has no alpha; fill with the view's own background so gaps match the screen.
  const background = getComputedStyle(root).backgroundColor;
  ctx.fillStyle = background && background !== "rgba(0, 0, 0, 0)" ? background : "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const layer of layers) {
    const src = sourceRect(layer.visible, layer.drawn, layer.sourceWidth, layer.sourceHeight);
    ctx.drawImage(
      layer.source,
      src.left, src.top, src.width, src.height,
      (layer.visible.left - bounds.left) * scale, (layer.visible.top - bounds.top) * scale,
      layer.visible.width * scale, layer.visible.height * scale,
    );
  }
  const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!image) throw new Error("The view could not be encoded");
  return { meta: { path, view, width: canvas.width, height: canvas.height, layers: layers.length, notes: [...new Set(notes)] }, image };
}

/** The region to capture: the live document pane, else the center view unless it is Pi itself. */
export function viewCaptureRoot(doc: Document, centerView: string): Element | null {
  const live = doc.querySelector('[data-mesa-view-root="live-doc"]');
  if (live?.parentElement) return live.parentElement;
  return centerView === "agent" ? null : doc.querySelector(".center-body");
}

/** Metadata travels as URI-encoded JSON so the native bridge can pass it in an ASCII header. */
export function encodeViewMeta(meta: ViewCaptureMeta): string {
  const notes = meta.notes.slice(0, 8).map((note) => note.slice(0, 300));
  return encodeURIComponent(JSON.stringify({ ...meta, path: meta.path?.slice(0, 1024) ?? null, notes }));
}

/** Answer one native mesa_view request. A failed capture still answers, with the reason. */
export async function answerViewRequest(requestId: string, path: string | null, centerView: string): Promise<void> {
  const root = viewCaptureRoot(document, centerView);
  let capture: ViewCapture;
  try {
    capture = root
      ? await captureView(root, path, centerView)
      : { meta: { path, view: centerView, width: 0, height: 0, layers: 0, notes: ["No document view is visible in the Mesa workspace."] }, image: null };
  } catch (error) {
    capture = { meta: { path, view: centerView, width: 0, height: 0, layers: 0, notes: [`Capture failed: ${String(error)}`] }, image: null };
  }
  const bytes = capture.image ? new Uint8Array(await capture.image.arrayBuffer()) : new Uint8Array(0);
  await invoke("activity_view_respond", bytes, {
    headers: {
      "x-mesa-view-request": requestId,
      "x-mesa-view-meta": encodeViewMeta(capture.meta),
      "x-mesa-view-mime": capture.image ? capture.image.type || "image/jpeg" : "none",
    },
  });
}
