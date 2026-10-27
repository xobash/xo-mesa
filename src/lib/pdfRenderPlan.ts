import type { StalePages } from "./pdfStalePages";

/** Select mounted pages that need pixels. Work stays proportional to mounted
 * pages rather than the document page count. */
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
