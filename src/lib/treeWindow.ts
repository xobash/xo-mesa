/**
 * Row-window arithmetic for the sidebar file tree.
 *
 * The tree mounts one component per vault entry, and a real vault has
 * thousands. Measured on a 4,165-file vault with every row live:
 * 13,102 DOM nodes and ~20,800 Zustand selectors, which made EVERY store
 * update in the app cost 2.9 ms of subscriber fan-out (0.10 ms with the rows
 * unmounted) — a tax paid by every keystroke, every activity blip, and every
 * PDF status change, whether or not the sidebar was even visible.
 *
 * Rows are a uniform height (one CSS rule sets the box for `.tree-file` and
 * `.tree-folder` alike), so the visible slice is pure arithmetic and lives
 * here rather than in the component.
 *
 * The focus range is what keeps windowing from *removing* keyboard
 * reachability: a row that has DOM focus, and its immediate neighbours, are
 * rendered even when scrolled far out of view, so Tab still walks from one row
 * to the next exactly as it did when every row was mounted.
 */

export interface RowRange {
  /** First row index in the range (inclusive). */
  start: number;
  /** One past the last row index (exclusive). */
  end: number;
}

/** Rows rendered beyond each edge of the viewport, so a scroll never exposes
 *  an unrendered gap before React commits the next window. */
export const ROW_OVERSCAN = 8;

/** Height of one tree row in CSS pixels, used until a real row is measured. */
export const DEFAULT_ROW_HEIGHT = 23;

const clamp = (n: number, lo: number, hi: number) =>
  n < lo ? lo : n > hi ? hi : n;

/**
 * The range of rows covering the viewport.
 *
 * `offset` is the distance from the top of the scroll container's content to
 * the top of the tree — the sidebar puts a header and the bookmarks list above
 * it — so `scrollTop - offset` is the tree-relative scroll position.
 *
 * A non-positive `rowHeight` or `viewportHeight` (a hidden or unmeasured
 * sidebar) yields an empty range rather than a division by zero; the caller
 * re-measures once the element has a box.
 */
export function visibleRowRange(
  rowCount: number,
  {
    scrollTop,
    offset,
    viewportHeight,
    rowHeight,
    overscan = ROW_OVERSCAN,
  }: {
    scrollTop: number;
    offset: number;
    viewportHeight: number;
    rowHeight: number;
    overscan?: number;
  }
): RowRange {
  if (rowCount <= 0 || rowHeight <= 0 || viewportHeight <= 0) {
    return { start: 0, end: 0 };
  }
  const top = scrollTop - offset;
  const first = Math.floor(top / rowHeight) - overscan;
  const last = Math.ceil((top + viewportHeight) / rowHeight) + overscan;
  return {
    start: clamp(first, 0, rowCount),
    end: clamp(last, 0, rowCount),
  };
}

/**
 * The range that must stay rendered to keep a focused row — and the rows Tab
 * and Shift+Tab move to next — reachable.
 */
export function focusRowRange(
  focusIndex: number | null,
  rowCount: number
): RowRange | null {
  if (focusIndex === null || focusIndex < 0 || focusIndex >= rowCount) {
    return null;
  }
  return {
    start: clamp(focusIndex - 1, 0, rowCount),
    end: clamp(focusIndex + 2, 0, rowCount),
  };
}

/**
 * Row indices to render, ascending and without duplicates.
 *
 * Two ranges are kept separate rather than merged: a focused row far outside
 * the viewport would otherwise force every row between them to render. Rows
 * are positioned by index, so a gap between the two blocks costs nothing.
 */
export function windowedRowIndices(
  main: RowRange,
  focus: RowRange | null
): number[] {
  const out: number[] = [];
  for (let i = main.start; i < main.end; i++) out.push(i);
  if (!focus) return out;
  for (let i = focus.start; i < focus.end; i++) {
    if (i < main.start || i >= main.end) out.push(i);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * The scroll position that brings row `index` into view, or `null` when it
 * already is. Mirrors `scrollIntoView({ block: "nearest" })`: a row above the
 * viewport scrolls to the top edge, one below scrolls to the bottom edge, and
 * a row already visible does not move the scroller at all.
 */
export function scrollTopForRow(
  index: number,
  {
    scrollTop,
    offset,
    viewportHeight,
    rowHeight,
  }: {
    scrollTop: number;
    offset: number;
    viewportHeight: number;
    rowHeight: number;
  }
): number | null {
  if (index < 0 || rowHeight <= 0 || viewportHeight <= 0) return null;
  const rowTop = offset + index * rowHeight;
  const rowBottom = rowTop + rowHeight;
  if (rowTop < scrollTop) return Math.max(0, rowTop);
  if (rowBottom > scrollTop + viewportHeight) {
    return Math.max(0, rowBottom - viewportHeight);
  }
  return null;
}
