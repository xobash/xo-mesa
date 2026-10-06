// Geometry and occlusion helpers for the native harness slot.

export interface HarnessRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** DOMRect (CSS px, viewport-relative — which for Mesa's unscrolled app shell
 * equals window-content coordinates) → integer rect for the native webview. */
export function roundRect(r: {
  left: number;
  top: number;
  width: number;
  height: number;
}): HarnessRect {
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.max(0, Math.round(r.width)),
    h: Math.max(0, Math.round(r.height)),
  };
}

/** Did the rect move/resize enough to bother the native side? Sub-pixel
 * CSS-transition jitter stays below `eps` and is ignored. */
export function rectsDiffer(
  a: HarnessRect | null,
  b: HarnessRect,
  eps = 1
): boolean {
  if (!a) return true;
  return (
    Math.abs(a.x - b.x) >= eps ||
    Math.abs(a.y - b.y) >= eps ||
    Math.abs(a.w - b.w) >= eps ||
    Math.abs(a.h - b.h) >= eps
  );
}

/** A rect the native webview can actually render into. Zero-area rects happen
 * mid-mount and mid-slide-animation; pushing them flickers the webview. */
export function rectUsable(r: HarnessRect): boolean {
  return r.w >= 40 && r.h >= 40;
}

/** True when two viewport rectangles overlap by a meaningful amount on both
 * axes. A small threshold prevents shared borders and rounded-position jitter
 * from flickering the native child webview on and off. */
export function rectsOverlap(
  a: HarnessRect,
  b: HarnessRect,
  minOverlap = 2
): boolean {
  const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapW >= minOverlap && overlapH >= minOverlap;
}

/** Does any visible Mesa surface intersect the native browser slot? The DOM
 * collector lives in BrowserHarness; this pure half keeps the geometry rule
 * deterministic and easy to test. */
export function harnessOccluded(
  slot: HarnessRect,
  occluders: readonly HarnessRect[]
): boolean {
  return occluders.some(
    (rect) => rectUsable(rect) && rectsOverlap(slot, rect)
  );
}
