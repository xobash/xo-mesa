import { describe, expect, it } from "vitest";
import { pdfPageWindow } from "./pdfPageWindow";
import {
  PDF_CANVAS_BUDGET_BYTES,
  pdfPaintAheadPages,
  planPdfCanvasRelease,
} from "./pdfCanvasBudget";

/**
 * Retained canvas pixels must be bounded in BYTES, not only in page count.
 *
 * Measured on the real vault: one US-Letter page of a 288-page manual holds
 * 1836x2376x4 = 16.6 MB of backing at 300% zoom. `pdfPageWindow`'s release band
 * spans 8 pages either side of every on-screen page (plus page 1), so ordinary
 * scrolling at that zoom is eligible to retain ~19 pages — about 330 MB of
 * pixels, almost none of them visible.
 */

/** The measured figure: US Letter at 300%, 4 bytes per pixel. */
const LETTER_AT_300 = 1836 * 2376 * 4;

const MB = (bytes: number) => Math.round(bytes / 1048576);

describe("retained canvas backing is bounded in bytes", () => {
  it("cuts the ~330 MB high-zoom scrolling tail down to the budget", () => {
    // Reader is on page 40 of a long manual, having scrolled there: every page
    // inside the release band still holds pixels from the way past.
    const window = pdfPageWindow(new Set([39]), 288, { ahead: 3, keep: 8 });
    const painted = [...window.keep].map((page) => page - 1);
    const before = painted.length * LETTER_AT_300;
    // 17 pages either side of page 40, plus the pinned page 1: ~299 MB held.
    expect(painted.length).toBe(18);
    expect(MB(before)).toBeGreaterThan(290); // the unbounded peak, reproduced

    const plan = planPdfCanvasRelease(painted, window, () => LETTER_AT_300);

    // The whole releasable tail goes: what remains is exactly the visible band
    // (37..43 plus the pinned page 1), which rule 2 exempts because
    // `pdfPagesToRender` repaints that band immediately — releasing from it
    // would thrash rather than save anything.
    const remaining = painted.length - plan.release.length;
    expect(remaining).toBe(window.paint.size);
    expect(MB(plan.retainedBytes)).toBe(MB(window.paint.size * LETTER_AT_300));
    // 299 MB -> 140 MB: the tail that no reader was looking at is gone.
    expect(MB(plan.retainedBytes)).toBeLessThan(150);
    expect(MB(before) - MB(plan.retainedBytes)).toBeGreaterThan(155);
  });

  it("never releases a page the reader is looking at", () => {
    const window = pdfPageWindow(new Set([39]), 288, { ahead: 3, keep: 8 });
    const painted = [...window.keep].map((page) => page - 1);
    const plan = planPdfCanvasRelease(painted, window, () => LETTER_AT_300);
    for (const pageIdx of plan.release) {
      expect(window.paint.has(pageIdx + 1)).toBe(false);
    }
    // The whole visible band survives, so nothing on screen repaints.
    for (const page of window.paint) {
      expect(plan.release).not.toContain(page - 1);
    }
  });

  it("releases the pages furthest from the visible band first", () => {
    const window = pdfPageWindow(new Set([39]), 288, { ahead: 3, keep: 8 });
    const painted = [...window.keep].map((page) => page - 1);
    const plan = planPdfCanvasRelease(painted, window, () => LETTER_AT_300);
    // `paint` spans 37..43 (plus the unconditionally pinned page 1), so the
    // releasable tail is 32..36 and 44..48. Its extremes must go before
    // anything adjacent to the visible band.
    const distance = (p: number) => (p < 37 ? 37 - p : p > 43 ? p - 43 : 0);
    const releasedPages = plan.release.map((i) => i + 1);
    const keptTail = [...window.keep].filter(
      (p) => !releasedPages.includes(p) && !window.paint.has(p)
    );
    const nearestReleased = Math.min(...releasedPages.map(distance));
    const furthestKeptTail = keptTail.length
      ? Math.max(...keptTail.map(distance))
      : 0;
    expect(nearestReleased).toBeGreaterThanOrEqual(furthestKeptTail);
  });

  it("leaves ordinary reading completely untouched", () => {
    // The measured ordinary case: a handful of pages, 13-30 MB total.
    const window = pdfPageWindow(new Set([2]), 288, { ahead: 3, keep: 8 });
    const painted = [...window.keep].map((page) => page - 1);
    const small = 3 * 1024 * 1024;
    const plan = planPdfCanvasRelease(painted, window, () => small);
    expect(plan.release).toEqual([]);
    expect(plan.retainedBytes).toBe(painted.length * small);
  });

  it("still applies the distance rule on its own", () => {
    const window = pdfPageWindow(new Set([39]), 288, { ahead: 3, keep: 8 });
    // Page 5 is far outside `keep` and must go regardless of the budget.
    const plan = planPdfCanvasRelease([4, 38, 39], window, () => 1024);
    expect(plan.release).toContain(4);
    expect(plan.release).not.toContain(38);
    expect(plan.release).not.toContain(39);
  });

  it("does not thrash when the visible band alone exceeds the budget", () => {
    // 7 painted pages at 300% is ~122 MB — over budget, but every one of them
    // is on screen or adjacent. Releasing any would repaint what is visible.
    const window = pdfPageWindow(new Set([39]), 288, { ahead: 3, keep: 8 });
    const paintOnly = [...window.paint].map((page) => page - 1);
    const plan = planPdfCanvasRelease(paintOnly, window, () => LETTER_AT_300);
    expect(plan.release).toEqual([]);
    expect(plan.retainedBytes).toBeGreaterThan(PDF_CANVAS_BUDGET_BYTES);
  });

  it("accounts for real per-page sizes rather than assuming uniformity", () => {
    // A fold-out map among letter pages: one page can dominate the budget.
    const window = pdfPageWindow(new Set([39]), 288, { ahead: 3, keep: 8 });
    const painted = [...window.keep].map((page) => page - 1);
    const huge = 120 * 1024 * 1024;
    const sizeOf = (pageIdx: number) => (pageIdx === 47 ? huge : 1024 * 1024);
    const plan = planPdfCanvasRelease(painted, window, sizeOf);
    // The oversized tail page is what must go, not a dozen small ones.
    expect(plan.release).toContain(47);
    expect(plan.retainedBytes).toBeLessThanOrEqual(PDF_CANVAS_BUDGET_BYTES);
  });

  it("handles an empty painted set", () => {
    const window = pdfPageWindow(new Set([0]), 10, { ahead: 3, keep: 8 });
    const plan = planPdfCanvasRelease([], window, () => LETTER_AT_300);
    expect(plan).toEqual({ release: [], retainedBytes: 0 });
  });
});

/** US Letter at 120%, the default zoom: the ordinary case. */
const LETTER_AT_120 = Math.round(612 * 1.2) * Math.round(792 * 1.2) * 4;

describe("the pre-render band is bounded in bytes, not just pages", () => {
  it("leaves the configured lookahead alone at ordinary zoom", () => {
    // ~2.8 MB a page: the whole band is affordable many times over.
    expect(pdfPaintAheadPages(LETTER_AT_120, 3)).toBe(3);
  });

  it("shrinks the band when a single page has become expensive", () => {
    // 16.6 MB a page at 300%: 7 pages would be ~116 MB of lookahead for a
    // viewport showing about a quarter of one page.
    const ahead = pdfPaintAheadPages(LETTER_AT_300, 3);
    expect(ahead).toBeLessThan(3);
    const bandBytes = (2 * ahead + 1) * LETTER_AT_300;
    expect(bandBytes).toBeLessThanOrEqual(PDF_CANVAS_BUDGET_BYTES);
  });

  it("never drops below one page of lookahead", () => {
    // A single fold-out map page can exceed the whole budget by itself;
    // zero lookahead would repaint on every scroll step.
    expect(pdfPaintAheadPages(500 * 1024 * 1024, 3)).toBe(1);
  });

  it("falls back to the configured band when no page size is known yet", () => {
    // The first paint runs before the background measure pass has sized
    // anything, and must behave exactly as it did before.
    expect(pdfPaintAheadPages(0, 3)).toBe(3);
    expect(pdfPaintAheadPages(Number.NaN, 3)).toBe(3);
    expect(pdfPaintAheadPages(Number.POSITIVE_INFINITY, 3)).toBe(3);
  });

  it("keeps the whole painted band inside the budget at high zoom", () => {
    // End to end: the trimmed band feeds the window that BOTH the painter and
    // the release planner read, so they cannot disagree.
    const ahead = pdfPaintAheadPages(LETTER_AT_300, 3);
    const window = pdfPageWindow(new Set([39]), 288, { ahead, keep: 8 });
    const painted = [...window.keep].map((page) => page - 1);
    const plan = planPdfCanvasRelease(painted, window, () => LETTER_AT_300);
    expect(MB(plan.retainedBytes)).toBeLessThanOrEqual(96 + MB(LETTER_AT_300));
    // Comfortably under the ~299 MB the same scroll position held before.
    expect(MB(plan.retainedBytes)).toBeLessThan(110);
  });
});
