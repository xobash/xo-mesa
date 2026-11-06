/**
 * Device pixel ratio and its changes: display scaling (125%, 150%, Retina),
 * moving a window to a monitor with another scale, and page zoom.
 * A `(resolution: Ndppx)` query fires once, when the ratio stops being N,
 * so each change re-arms a query for the new ratio.
 */
export function currentDevicePixelRatio(): number {
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export function onDevicePixelRatioChange(listener: (ratio: number) => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  let query: MediaQueryList | null = null;
  const arm = () => {
    query = matchMedia(`(resolution: ${currentDevicePixelRatio()}dppx)`);
    query.addEventListener("change", handler);
  };
  const handler = () => {
    query?.removeEventListener("change", handler);
    arm();
    listener(currentDevicePixelRatio());
  };
  arm();
  return () => {
    query?.removeEventListener("change", handler);
    query = null;
  };
}

/**
 * Backing-store multiplier for a canvas whose CSS box is
 * `cssWidth × cssHeight`: the device pixel ratio, so lines and text are sharp
 * at 125%, 150% and Retina scaling, reduced so the bitmap stays within
 * `maxPixels`. Never below 1: a canvas is never drawn coarser than its CSS
 * box, which is what it was drawn at before the ratio was honoured.
 */
export function canvasBackingScale(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixels: number
): number {
  if (!(devicePixelRatio > 1) || !Number.isFinite(devicePixelRatio)) return 1;
  const area = cssWidth * cssHeight;
  if (!(area > 0) || !Number.isFinite(area)) return 1;
  return Math.max(1, Math.min(devicePixelRatio, Math.sqrt(maxPixels / area)));
}
