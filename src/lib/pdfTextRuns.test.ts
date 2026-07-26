import { describe, expect, it } from "vitest";
import { groupPdfTextRunsByPage } from "./pdfTextRuns";

describe("groupPdfTextRunsByPage", () => {
  it("groups by page without changing document order or object identity", () => {
    const first = { page: 2, text: "first" };
    const second = { page: 0, text: "second" };
    const third = { page: 2, text: "third" };

    const grouped = groupPdfTextRunsByPage([first, second, third]);

    expect(grouped.get(0)).toEqual([second]);
    expect(grouped.get(2)).toEqual([first, third]);
    expect(grouped.get(2)?.[0]).toBe(first);
    expect(grouped.get(1)).toBeUndefined();
  });

  it("handles an empty document", () => {
    expect(groupPdfTextRunsByPage([]).size).toBe(0);
  });
});
