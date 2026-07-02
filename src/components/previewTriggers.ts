import { getStore } from "../store";
import { fileKind, isTextExt } from "../lib/vault";
import { warmPdfThumb } from "../lib/pdfThumb";
import type { PreviewTarget } from "../types";

/**
 * Shared hover-to-preview triggers for any DOM element (sidebar files/folders,
 * tag chips). They drive the single global preview card in the store, honoring
 * the Settings → hover delay, and place the card beside the element, flipping /
 * clamping so it always stays on screen. The graph view manages its own hover
 * timing but renders the same <PreviewCard>.
 */
const CARD_W = 360;
const CARD_H = 300;

let timer: ReturnType<typeof setTimeout> | undefined;

function prewarmPreview(target: PreviewTarget): void {
  if (target.kind !== "note") return;
  const store = getStore();
  const file = store.files.find((f) => f.relPath === target.id);
  if (!file) return;
  const kind = fileKind(file.ext);
  if (kind === "pdf") {
    void warmPdfThumb(file.path);
    return;
  }
  if (file.isMarkdown || isTextExt(file.ext) || file.ext === "rtf") {
    // Byte-capped peek: warms exactly what the card will render, without
    // pulling a whole multi-MB file through IPC on every hover.
    void store.ensurePeek(file.relPath);
  }
}

export function previewEnter(target: PreviewTarget, rect: DOMRect): void {
  if (timer) clearTimeout(timer);
  prewarmPreview(target);
  const delay = getStore().settings.hoverDelayMs;
  timer = setTimeout(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    let x = rect.right + 10;
    if (x + CARD_W > w) x = rect.left - CARD_W - 10; // flip to the left side
    x = Math.max(8, Math.min(x, w - CARD_W - 8));
    let y = rect.top - 4;
    if (y + CARD_H > h) y = h - CARD_H - 10;
    y = Math.max(8, y);
    getStore().showHoverPreview(target, x, y);
  }, delay);
}

export function previewLeave(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  getStore().hideHoverPreview();
}
