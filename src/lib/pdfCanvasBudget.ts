/** Bound retained canvas bytes as well as page distance.
 * Release pages outside keep, then trim the furthest retained pages first.
 * Pages in the paint band are exempt to avoid immediate repainting. */

/** Retained canvas byte budget. The visible paint band is exempt to avoid
 * releasing pages that the painter would immediately render again. */
export const PDF_CANVAS_BUDGET_BYTES = 96 * 1024 * 1024;

/** Bound paint-ahead page count by estimated bytes at the current scale.
 * Painter and releaser must use the same band to avoid repaint thrashing.
 * @param pageBytes bytes one page holds at the current render scale.
 * @param maxAhead the configured lookahead count.
 * @param budgetBytes ceiling for the whole painted band. */
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
