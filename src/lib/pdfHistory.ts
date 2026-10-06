/** Bound PDF undo/redo retention by bytes as well as entry count, since each
 * entry contains a complete document. Preserve the newest entry for one undo. */

export interface PdfHistoryLimits {
  maxEntries: number;
  maxBytes: number;
}

export const PDF_HISTORY_LIMITS: PdfHistoryLimits = {
  /** Entry cap for small-document history. */
  maxEntries: 200,
  /** Total snapshot bytes Mesa is willing to hold for undo/redo. */
  maxBytes: 128 * 1024 * 1024,
};

/** Total bytes held by a snapshot stack. */
export function pdfHistoryBytes(snapshots: readonly Uint8Array[]): number {
  let total = 0;
  for (const s of snapshots) total += s.byteLength;
  return total;
}

/** Trim oldest snapshots by count and combined retained bytes, including otherBytes.
 * Keep the newest snapshot even if it alone exceeds the budget. */
export function trimPdfHistory(
  snapshots: readonly Uint8Array[],
  otherBytes = 0,
  limits: PdfHistoryLimits = PDF_HISTORY_LIMITS
): Uint8Array[] {
  const out = snapshots.slice();
  let total = pdfHistoryBytes(out);
  while (out.length > 1 && out.length > limits.maxEntries) {
    total -= out[0].byteLength;
    out.shift();
  }
  while (out.length > 1 && total + otherBytes > limits.maxBytes) {
    total -= out[0].byteLength;
    out.shift();
  }
  return out;
}
