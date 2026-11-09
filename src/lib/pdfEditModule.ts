// The one loader for pdf-lib edit transforms. Keeping it dynamic keeps pdf-lib
// out of every static chunk; a failed load clears the cache so the next call
// retries instead of replaying the rejection.
export type PdfEditModule = typeof import("./pdf");

let pdfEditModulePromise: Promise<PdfEditModule> | null = null;

export function loadPdfEditModule(): Promise<PdfEditModule> {
  if (!pdfEditModulePromise) {
    pdfEditModulePromise = import("./pdf").catch((error) => {
      pdfEditModulePromise = null;
      throw error;
    });
  }
  return pdfEditModulePromise;
}
