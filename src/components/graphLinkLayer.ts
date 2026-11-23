/**
 * A cached bitmap of the plain links (draw batch 1) for heavy graphs.
 *
 * WebKit strokes canvas lines at a fixed cost per segment: 92,775 links took
 * about 45 ms per frame in Safari 27.2 whatever the resolution or batching,
 * while blitting a cached bitmap took 2 to 4 ms (Measured,
 * `tmp/qa/graphbench/heavydraw.html`). When link geometry is unchanged since
 * the last frame (panning, hover fades, activity flicker, idle redraws) the
 * layer is drawn once and then blitted at the current pan offset. When a
 * plain link moves (settling, worker states, zooming) the layer is redrawn
 * that frame, so the picture is never stale; links of a grabbed, hovered or
 * active node draw on top and never force a redraw. In Safari a 10,000-note
 * graph redrawn every frame ran at 40 fps, from the layer at 60 fps.
 * Living motion moves every link every frame and strokes directly.
 */

/** Below this many links direct strokes are cheap enough (5 ms in Chromium at 92,775). */
export const LINK_LAYER_MIN_LINKS = 20_000;

/**
 * Shortest gap between applied worker states while a heavy graph draws
 * through the layer. WebKit strokes off the timed call, so the gap there is
 * fixed: Safari 27.2 with 92,775 links ran at 41 fps taking 35 states/s and
 * 59 fps taking 20/s (Measured). Elsewhere, two draws' time, never over
 * 100 ms; a fast draw keeps every state.
 */
export function linkStateInterval(rasterMs: number, webkit: boolean): number {
  if (webkit) return 50;
  return rasterMs <= 8 ? 0 : Math.min(100, rasterMs * 2);
}

/** WKWebView, Safari and WebKitGTK; not Chromium-based webviews. */
export function isWebKitCanvas(userAgent: string): boolean {
  return /AppleWebKit/.test(userAgent) && !/Chrome|Chromium|Edg\//.test(userAgent);
}

export interface LinkLayerFrame {
  /** Everything batch 1 depends on except geometry, pan and zoom: size, style, exclusions. */
  key: string;
  /** Zoom (CSS px per world unit). */
  k: number;
  /** Pan offset, CSS px. */
  tx: number;
  ty: number;
  dpr: number;
  /** Batch 1's opacity (the highlight dim). */
  alpha: number;
}

export class LinkLayer {
  private canvas: HTMLCanvasElement | null = null;
  private key = "";
  private tx = 0;
  private ty = 0;
  private k = 1;
  private rasteredAt = -Infinity;
  /** Every link fell inside the bitmap, so any pan offset is still complete. */
  private complete = false;
  private valid = false;
  private links: unknown = null;
  /** Duration of the newest layer draw, ms. */
  lastRasterMs = 0;
  /** True while the newest frame drew links through this layer. */
  active = false;

  /** True when `links` is not the array the previous frame drew. */
  linksChanged(links: unknown): boolean {
    const changed = links !== this.links;
    this.links = links;
    return changed;
  }

  invalidate(): void {
    this.valid = false;
  }

  /** Gap to keep between worker states while this layer draws a heavy graph. */
  stateInterval(webkit: boolean): number {
    return this.active ? linkStateInterval(this.lastRasterMs, webkit) : 0;
  }

  /**
   * During a zoom ease, blit the newest complete layer scaled to this frame's
   * zoom if it was drawn less than `maxAgeMs` ago (a slight blur for a few
   * frames; the layer is redrawn sharp at most every `maxAgeMs` and when the
   * ease ends). False when the caller must draw the layer instead.
   */
  drawScaled(target: CanvasRenderingContext2D, frame: LinkLayerFrame, now: number, maxAgeMs: number): boolean {
    const width = target.canvas.width, height = target.canvas.height;
    // An incomplete layer still serves an ease: zooming in shows part of it; zooming
    // out may miss edge links for under `maxAgeMs` until the next sharp draw.
    if (!this.valid || this.key !== frame.key || !this.canvas || this.canvas.width !== width || this.canvas.height !== height) return false;
    if (now - this.rasteredAt >= maxAgeMs) return false;
    // Layer pixel p = dpr * (k0 * world + t0); this frame wants dpr * (k * world + t).
    const scale = frame.k / this.k;
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = frame.alpha;
    target.drawImage(this.canvas, frame.dpr * frame.tx - scale * frame.dpr * this.tx, frame.dpr * frame.ty - scale * frame.dpr * this.ty, width * scale, height * scale);
    target.restore();
    return true;
  }

  /** Free the bitmap (a light graph or an unmount). */
  release(): void {
    this.valid = false;
    this.lastRasterMs = 0;
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
    this.canvas = null;
  }

  /**
   * Blit batch 1 from the layer, drawing it first when needed. `raster` strokes
   * batch 1 into the given context (already transformed like the frame) and
   * reports whether any link was culled. Returns false when the layer cannot
   * be used (no 2D context); the caller then strokes directly.
   */
  draw(
    target: CanvasRenderingContext2D,
    frame: LinkLayerFrame,
    raster: (ctx: CanvasRenderingContext2D) => boolean,
    now: number
  ): boolean {
    const width = target.canvas.width, height = target.canvas.height;
    const moved = frame.tx !== this.tx || frame.ty !== this.ty;
    const usable = this.valid && this.key === frame.key && frame.k === this.k && this.canvas?.width === width && this.canvas.height === height && (!moved || this.complete);
    if (!usable) {
      const canvas = this.canvas ?? document.createElement("canvas");
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      this.canvas = canvas;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const started = performance.now();
      const culled = raster(ctx);
      this.lastRasterMs = performance.now() - started;
      this.key = frame.key;
      this.k = frame.k;
      this.rasteredAt = now;
      this.tx = frame.tx;
      this.ty = frame.ty;
      this.complete = !culled;
      this.valid = true;
    }
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = frame.alpha;
    target.drawImage(this.canvas!, (frame.tx - this.tx) * frame.dpr, (frame.ty - this.ty) * frame.dpr);
    target.restore();
    return true;
  }
}
