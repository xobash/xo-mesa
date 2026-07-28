import { describe, expect, it } from "vitest";
import {
  PDF_HISTORY_LIMITS,
  pdfHistoryBytes,
  trimPdfHistory,
} from "./pdfHistory";

const snap = (size: number, fill = 0) => new Uint8Array(size).fill(fill);

describe("trimPdfHistory", () => {
  it("leaves an ordinary document's history completely alone", () => {
    // A 36 KiB PDF edited 40 times is nowhere near either bound.
    const history = Array.from({ length: 40 }, () => snap(36 * 1024));
    expect(trimPdfHistory(history)).toHaveLength(40);
  });

  it("drops the oldest snapshots first, keeping the newest", () => {
    const history = [snap(4, 1), snap(4, 2), snap(4, 3)];
    const trimmed = trimPdfHistory(history, 0, { maxEntries: 2, maxBytes: 1e9 });
    expect(trimmed).toHaveLength(2);
    expect(trimmed[0][0]).toBe(2);
    expect(trimmed[1][0]).toBe(3);
  });

  it("bounds retention by bytes for large documents", () => {
    const mib = 1024 * 1024;
    // Ten 52 MiB snapshots is the measured 521 MiB runaway.
    const history = Array.from({ length: 10 }, () => snap(52 * mib));
    expect(pdfHistoryBytes(history)).toBe(520 * mib);
    const trimmed = trimPdfHistory(history, 0, {
      maxEntries: 200,
      maxBytes: 128 * mib,
    });
    expect(pdfHistoryBytes(trimmed)).toBeLessThanOrEqual(128 * mib);
    expect(trimmed.length).toBeGreaterThan(0);
  });

  it("counts bytes the caller holds elsewhere against the same budget", () => {
    const history = [snap(40), snap(40), snap(40)];
    const alone = trimPdfHistory(history, 0, { maxEntries: 99, maxBytes: 120 });
    expect(alone).toHaveLength(3);
    // With the current bytes and the redo stack also in hand, less fits.
    const shared = trimPdfHistory(history, 80, { maxEntries: 99, maxBytes: 120 });
    expect(shared).toHaveLength(1);
  });

  it("never drops the last snapshot, even one larger than the whole budget", () => {
    const huge = [snap(300)];
    expect(trimPdfHistory(huge, 0, { maxEntries: 200, maxBytes: 100 })).toEqual(huge);
    // One undo stays possible after an edit to an oversized document.
    const two = [snap(300, 1), snap(300, 2)];
    const trimmed = trimPdfHistory(two, 0, { maxEntries: 200, maxBytes: 100 });
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0][0]).toBe(2);
  });

  it("handles an empty stack", () => {
    expect(trimPdfHistory([])).toEqual([]);
  });

  it("does not mutate the input stack", () => {
    const history = [snap(4, 1), snap(4, 2)];
    trimPdfHistory(history, 0, { maxEntries: 1, maxBytes: 1e9 });
    expect(history).toHaveLength(2);
  });

  it("ships bounds that keep small PDFs effectively unlimited", () => {
    expect(PDF_HISTORY_LIMITS.maxEntries).toBeGreaterThanOrEqual(100);
    // A 1 MiB PDF must still get a deep history under the byte budget.
    const oneMib = 1024 * 1024;
    const history = Array.from({ length: 60 }, () => snap(oneMib));
    expect(trimPdfHistory(history)).toHaveLength(60);
  });
});
