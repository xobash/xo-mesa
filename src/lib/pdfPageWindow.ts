/** Choose a required paint band and a wider permitted keep band.
 * The gap provides hysteresis when scrolling across page boundaries. */
export interface PdfPageWindowOptions {
  /** Pages painted on each side of the on-screen band. */
  ahead: number;
  /** Pages retained on each side before painted pixels are released. */
  keep: number;
}

export interface PdfPageWindow {
  /** 1-based page numbers that should hold painted pixels. */
  paint: Set<number>;
  /** 1-based page numbers allowed to keep painted pixels. Superset of `paint`. */
  keep: Set<number>;
}

/**
 * @param onscreen 0-based page indices the viewer reports as on/near screen, or
 *   null when it has not reported yet. Null means "page 1 only", never "all
 *   pages" — an unanswered observer must not cost a full-document rasterize.
 * @param totalPages page count of the document.
 */
export function pdfPageWindow(
  onscreen: ReadonlySet<number> | null,
  totalPages: number,
  { ahead, keep }: PdfPageWindowOptions
): PdfPageWindow {
  const result: PdfPageWindow = { paint: new Set(), keep: new Set() };
  if (totalPages <= 0) return result;

  const clamp = (page: number) => page >= 1 && page <= totalPages;
  // Page 1 is unconditional: it retires the warm-start native view and it is the
  // page the blank-paint check runs on.
  if (clamp(1)) {
    result.paint.add(1);
    result.keep.add(1);
  }

  const centers = onscreen && onscreen.size > 0 ? [...onscreen] : [0];
  for (const zeroBased of centers) {
    const center = zeroBased + 1;
    for (let page = center - ahead; page <= center + ahead; page++) {
      if (clamp(page)) result.paint.add(page);
    }
    for (let page = center - keep; page <= center + keep; page++) {
      if (clamp(page)) result.keep.add(page);
    }
  }
  return result;
}
