/**
 * A byte ceiling for retained PDF canvas pixels.
 *
 * `pdfPageWindow` bounds how many pages may hold pixels, which is what stopped
 * a 357-page manual from retaining ~964 MB. But a page count is not a memory
 * bound: one page's backing is `width x height x scale^2 x 4`, and the viewer
 * lets the reader zoom to 3x. Measured on a real vault, one US-Letter page of a
 * 288-page manual holds 1836x2376x4 = **16.6 MB** at 300%, and the release band
 * (`keep`) spans 8 pages either side of every on-screen page plus page 1 — so
 * ordinary scrolling at high zoom can retain ~19 pages, about **330 MB** of
 * pixels, none of it visible. Large-format pages (maps, plans, scans) are
 * worse. On Windows this is the sharpest: canvas backing lives in the
 * compositor's image memory, and on the integrated GPUs most laptops ship it is
 * shared system RAM and VRAM at once.
 *
 * So `keep` decides what is ELIGIBLE to stay painted and this decides how much
 * of that is affordable. The rules, in order:
 *
 *  1. A page outside `keep` is released — the existing distance rule, unchanged.
 *  2. Pages in `paint` are never released here. They are what the reader is
 *     looking at (or is about to scroll into); dropping them would repaint the
 *     visible page and defeat the point. The budget is therefore a ceiling on
 *     the HYSTERESIS TAIL, and total retention can exceed it only when the
 *     visible band alone does.
 *  3. While the total is still over budget, release the eligible page furthest
 *     from the visible band first — the one whose repaint is least likely to be
 *     needed, and the last one a reader scrolling back would reach.
 *
 * Releasing a tail page is not a new behavior or a fidelity change: it is
 * exactly what already happens to a page that scrolls out of `keep`, and
 * scrolling back repaints it. This only makes distance stop being the sole
 * trigger. Ordinary documents at ordinary zoom never reach the budget, so their
 * behavior is byte-for-byte what it was.
 *
 * This mirrors the byte bound `pdfHistory` already applies to undo snapshots,
 * for the same reason: the count of retained things was never the quantity that
 * had to stay bounded.
 */

/** Ceiling on total retained canvas backing, in bytes.
 *
 *  Chosen against measurement rather than taste: ordinary reading on the real
 *  vault retains 13-30 MB, and even 300% zoom with a full visible band measured
 *  66.6 MB, so nothing a reader normally does is affected. It is the ~330 MB
 *  scrolling tail that is cut. 96 MiB also leaves the 3x visible band (7 pages,
 *  ~122 MB at Letter/300%) able to exceed it via rule 2 without thrashing,
 *  which is the case the exemption exists for. */
export const PDF_CANVAS_BUDGET_BYTES = 96 * 1024 * 1024;

/**
 * How many pages either side of the visible ones are worth pre-rendering.
 *
 * `PAINT_AHEAD_PAGES` is a count, and a count stops describing the same amount
 * of work once zoom is involved. At 120% a US-Letter page is ~1.7 viewport
 * heights, so painting 3 ahead is ~5 screens of lookahead — reasonable. At 300%
 * the same page is ~4.2 viewport heights, so the SAME 3 pages become ~12.7
 * screens of lookahead and ~116 MB of pixels, for a viewport showing about a
 * quarter of one page. The reader cannot scroll far enough to need it before it
 * is repainted anyway.
 *
 * So the band is expressed in pages but bounded in bytes: keep the full count
 * while the band is affordable, and shrink it only when a single page has grown
 * expensive. Painter and releaser both derive their window from this one
 * number, so they cannot disagree about which pages should hold pixels — the
 * property that keeps a trimmed band from thrashing against its own repaint.
 *
 * At ordinary sizes this returns `maxAhead` unchanged, so normal reading keeps
 * exactly today's lookahead.
 *
 * @param pageBytes bytes one page holds at the current render scale.
 * @param maxAhead the configured band (`PAINT_AHEAD_PAGES`).
 * @param budgetBytes ceiling for the whole painted band.
 */
export function pdfPaintAheadPages(
  pageBytes: number,
  maxAhead: number,
  budgetBytes: number = PDF_CANVAS_BUDGET_BYTES
): number {
  if (!(pageBytes > 0) || !Number.isFinite(pageBytes)) return maxAhead;
  // The band is the centre page plus `ahead` on each side.
  const affordable = Math.floor((budgetBytes / pageBytes - 1) / 2);
  // Never below 1: dropping to zero lookahead would repaint on every scroll
  // step, which costs more than the pixels it saves.
  return Math.max(1, Math.min(maxAhead, affordable));
}

export interface PdfCanvasReleasePlan {
  /** 0-based page indices whose pixels should be handed back, in release order. */
  release: number[];
  /** Retained bytes once `release` is applied. */
  retainedBytes: number;
}

/**
 * @param painted 0-based page indices currently holding pixels.
 * @param window `paint`/`keep` bands from `pdfPageWindow` (1-based page numbers).
 * @param backingBytes bytes a given 0-based page index currently holds.
 * @param budgetBytes ceiling for the total; defaults to `PDF_CANVAS_BUDGET_BYTES`.
 */
export function planPdfCanvasRelease(
  painted: Iterable<number>,
  window: { paint: ReadonlySet<number>; keep: ReadonlySet<number> },
  backingBytes: (pageIdx: number) => number,
  budgetBytes: number = PDF_CANVAS_BUDGET_BYTES
): PdfCanvasReleasePlan {
  const release: number[] = [];
  /** Still painted after the distance rule, and not pinned by `paint`. */
  const tail: number[] = [];
  let retained = 0;

  for (const pageIdx of painted) {
    if (!window.keep.has(pageIdx + 1)) {
      release.push(pageIdx);
      continue;
    }
    retained += backingBytes(pageIdx);
    if (!window.paint.has(pageIdx + 1)) tail.push(pageIdx);
  }

  if (retained <= budgetBytes || tail.length === 0) {
    return { release, retainedBytes: retained };
  }

  // Distance from the visible band, so the pages a reader would reach last go
  // first. `paint` is contiguous around the on-screen pages, so its numeric
  // bounds are the band; ties break on the higher page index for determinism.
  let low = Infinity;
  let high = -Infinity;
  for (const page of window.paint) {
    if (page < low) low = page;
    if (page > high) high = page;
  }
  const distance = (pageIdx: number): number => {
    const page = pageIdx + 1;
    if (page < low) return low - page;
    if (page > high) return page - high;
    return 0;
  };
  tail.sort((a, b) => distance(b) - distance(a) || b - a);

  for (const pageIdx of tail) {
    if (retained <= budgetBytes) break;
    release.push(pageIdx);
    retained -= backingBytes(pageIdx);
  }
  return { release, retainedBytes: retained };
}
