const thumbInvalidations = new Map<string, number>();

export function pdfThumbInvalidationVersion(path: string): number {
  return thumbInvalidations.get(path) ?? 0;
}

/** Mark a PDF thumbnail stale without importing the pdf.js thumbnail renderer. */
export function invalidatePdfThumb(path: string): void {
  thumbInvalidations.set(path, pdfThumbInvalidationVersion(path) + 1);
}
