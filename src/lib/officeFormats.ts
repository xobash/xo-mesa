// Office file routing. Kept tiny: the main pane imports it; the viewers and
// package layer it routes to load lazily. Fallback reasons live in
// `officeFallbackReason.ts`, which only the lazy fallback view loads.

/** OOXML presentations Mesa renders (`.pptm` stays read-only by the capability gate). */
export function isPresentationExt(ext: string): boolean {
  return /^(pptx|ppsx|pptm)$/i.test(ext);
}

/** OpenDocument packages Mesa opens (templates read-only by the package gate). */
export function isOpenDocumentExt(ext: string): boolean {
  return /^(odt|ods|odp|ott|ots|otp)$/i.test(ext);
}
