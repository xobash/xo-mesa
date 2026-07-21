/**
 * Pure geometry for the Steam-overlay floating windows.
 *
 * The contract that matters: the STORED window geometry is the user's intent
 * and is never rewritten by viewport clamping. `fitWin` is a render-time
 * projection into the current viewport — a transiently tiny window (app
 * startup can report 0×0, a temporarily shrunken OS window, a small demo
 * pane) must not permanently squash every remembered window to the minimum
 * size. Only explicit user actions (drag, resize, open/close, layout reset)
 * change what is persisted.
 */

export interface OverlayWinRec {
  open: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayViewport {
  width: number;
  height: number;
}

/** Overlay chrome margins: side padding, clock header, dock footer. */
export const OVERLAY_PAD = 12;
export const OVERLAY_TOP = 56;
export const OVERLAY_BOTTOM = 96;
const MIN_W = 280;
const MIN_H = 220;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Project a window rect into the viewport for RENDERING. Pure — never write
 * the result back into persisted state.
 */
export function fitWin(rec: OverlayWinRec, viewport: OverlayViewport): OverlayWinRec {
  const maxW = Math.max(MIN_W, viewport.width - OVERLAY_PAD * 2);
  const maxH = Math.max(MIN_H, viewport.height - OVERLAY_TOP - OVERLAY_BOTTOM);
  const w = clamp(rec.w, Math.min(MIN_W, maxW), maxW);
  const h = clamp(rec.h, Math.min(MIN_H, maxH), maxH);
  return {
    ...rec,
    w,
    h,
    x: clamp(rec.x, OVERLAY_PAD, Math.max(OVERLAY_PAD, viewport.width - w - OVERLAY_PAD)),
    y: clamp(rec.y, OVERLAY_TOP, Math.max(OVERLAY_TOP, viewport.height - h - OVERLAY_BOTTOM)),
  };
}

const finite = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * Merge persisted geometry over the defaults VERBATIM — no viewport is
 * involved, so loading can never destroy the remembered layout. Non-finite
 * numbers (corrupt storage) fall back to that window's default.
 */
export function mergeStoredWins<Id extends string>(
  defaults: Record<Id, OverlayWinRec>,
  raw: unknown
): Record<Id, OverlayWinRec> {
  const stored = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    Partial<OverlayWinRec> | undefined
  >;
  const out = {} as Record<Id, OverlayWinRec>;
  for (const id of Object.keys(defaults) as Id[]) {
    const def = defaults[id];
    const rec = stored[id];
    out[id] = rec
      ? {
          open: typeof rec.open === "boolean" ? rec.open : def.open,
          x: finite(rec.x, def.x),
          y: finite(rec.y, def.y),
          w: finite(rec.w, def.w),
          h: finite(rec.h, def.h),
        }
      : { ...def };
  }
  return out;
}
