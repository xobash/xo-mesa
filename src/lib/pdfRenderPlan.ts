import type { StalePages } from "./pdfStalePages";

/**
 * Select the mounted pages that actually owe pixels.
 *
 * The caller already has the small mounted-page list and viewport window. Work
 * from those rather than allocating `[1..documentPages]` on every canvas/
 * observer update; a 748-page PDF usually has only 1-7 paint candidates.
 */
export function pdfPagesToRender(
  mountedPageNumbers: readonly number[],
  paintWindow: ReadonlySet<number>,
  stalePages: StalePages,
  pageCount: number,
  paintedPages: ReadonlyMap<number, number>,
  renderScale: number
): number[] {
  const scoped = stalePages instanceof Set ? stalePages : null;
  return mountedPageNumbers.filter((pageNumber) => {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
      return false;
    }
    if (!paintWindow.has(pageNumber)) return false;
    if (scoped && !scoped.has(pageNumber - 1)) return false;
    return paintedPages.get(pageNumber - 1) !== renderScale;
  });
}
