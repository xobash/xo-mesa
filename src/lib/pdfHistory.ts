/**
 * Retention bounds for the PDF undo/redo stacks.
 *
 * A PDF edit is a byte-in/byte-out transform, so every history entry is a FULL
 * copy of the document. That is unbounded by default: measured on the test
 * corpus, ten highlight edits on a 52 MiB image-heavy PDF retain 625.6 MiB
 * across history + current + baseline, and it keeps growing linearly — thirty
 * edits is roughly 1.8 GiB, which the webview does not survive.
 *
 * Bounding by BYTES rather than depth is what keeps this honest: ordinary
 * documents are unaffected (a 36 KiB note-sized PDF still gets the full entry
 * cap, ~3,600 steps' worth of budget), and only documents big enough to
 * threaten the process trade undo depth for staying alive.
 */

export interface PdfHistoryLimits {
  maxEntries: number;
  maxBytes: number;
}

export const PDF_HISTORY_LIMITS: PdfHistoryLimits = {
  /** Deeper than any realistic editing session; bounds tiny-document growth. */
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

/**
 * Drop the OLDEST snapshots until the stack fits the budget.
 *
 * `otherBytes` is what the caller already holds elsewhere (the opposite
 * stack, the current bytes, the saved baseline), so the bound covers real
 * retention rather than one stack in isolation.
 *
 * The newest entry is never dropped: one undo — or one redo — must stay
 * possible even for a document larger than the whole budget, and the caller is
 * holding a copy of that size regardless.
 */
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
