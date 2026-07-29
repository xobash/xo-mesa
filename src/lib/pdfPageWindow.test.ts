import { describe, expect, it } from "vitest";
import { pdfPageWindow } from "./pdfPageWindow";

const opts = { ahead: 3, keep: 8 };

describe("pdfPageWindow", () => {
  it("treats 'no report yet' as page 1, never as the whole document", () => {
    const window = pdfPageWindow(null, 748, opts);
    expect([...window.paint].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(window.paint.size).toBeLessThan(748);
    expect(window.keep.size).toBeLessThan(748);
  });

  it("always paints page 1, whatever is on screen", () => {
    // Page 1 retires the native warm-start view and carries the blank-paint
    // check, so it can never be scrolled out of the paint set.
    const window = pdfPageWindow(new Set([400]), 748, opts);
    expect(window.paint.has(1)).toBe(true);
    expect(window.keep.has(1)).toBe(true);
  });

  it("paints a band around every on-screen page", () => {
    const window = pdfPageWindow(new Set([9, 10]), 748, opts);
    // 0-based 9 and 10 are pages 10 and 11; ahead=3 covers 7..14.
    for (let page = 7; page <= 14; page++) expect(window.paint.has(page)).toBe(true);
    expect(window.paint.has(6)).toBe(false);
    expect(window.paint.has(15)).toBe(false);
  });

  it("keeps a strictly wider band than it paints, so scrolling cannot thrash", () => {
    const window = pdfPageWindow(new Set([100]), 748, opts);
    for (const page of window.paint) expect(window.keep.has(page)).toBe(true);
    expect(window.keep.size).toBeGreaterThan(window.paint.size);
    // A page one step outside the paint band is still retained, so stepping
    // back onto it finds pixels instead of a repaint.
    expect(window.paint.has(105)).toBe(false);
    expect(window.keep.has(105)).toBe(true);
  });

  it("clamps to the document instead of running off either end", () => {
    const start = pdfPageWindow(new Set([0]), 5, opts);
    expect([...start.paint].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect([...start.keep].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);

    const end = pdfPageWindow(new Set([4]), 5, opts);
    expect([...end.paint].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns nothing for an empty document", () => {
    const window = pdfPageWindow(new Set([0]), 0, opts);
    expect(window.paint.size).toBe(0);
    expect(window.keep.size).toBe(0);
  });

  it("bounds painted pages by the window, not by the page count", () => {
    const small = pdfPageWindow(new Set([300]), 500, opts);
    const huge = pdfPageWindow(new Set([300]), 5000, opts);
    expect(small.paint.size).toBe(huge.paint.size);
    expect(huge.paint.size).toBe(2 * opts.ahead + 1 + 1); // band + page 1
  });
});
