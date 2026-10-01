import { describe, expect, it } from "vitest";
import { pdfPagesToRender } from "./pdfRenderPlan";

describe("pdfPagesToRender", () => {
  const mounted = [1, 2, 3, 8];
  const paint = new Set([1, 2, 3]);

  it("selects only mounted, in-window, unpainted pages", () => {
    expect(pdfPagesToRender(mounted, paint, null, 8, new Map([[0, 1.2]]), 1.2))
      .toEqual([2, 3]);
  });

  it("honors page-scoped invalidation", () => {
    expect(pdfPagesToRender(mounted, paint, new Set([2]), 8, new Map(), 1.2))
      .toEqual([3]);
  });

  it("treats all-page invalidation like a full candidate set", () => {
    expect(pdfPagesToRender(mounted, paint, "all", 8, new Map(), 1.2))
      .toEqual([1, 2, 3]);
  });

  it("does work proportional to mounted pages, not document pages", () => {
    expect(
      pdfPagesToRender(
        [1, 500_000_000],
        new Set([1, 500_000_000]),
        null,
        1_000_000_000,
        new Map(),
        1.2
      )
    ).toEqual([1, 500_000_000]);
  });
});
