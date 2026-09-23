import { describe, expect, it } from "vitest";
import { addStalePages, stalePageNumbers } from "./pdfStalePages";

describe("addStalePages", () => {
  it("records the first scoped edit", () => {
    expect(addStalePages(null, new Set([2]))).toEqual(new Set([2]));
  });

  it("MERGES successive scoped edits instead of replacing them", () => {
    // The regression this type exists for: two quick annotations on different
    // pages must both be redone, not just the last one.
    const first = addStalePages(null, new Set([0]));
    expect(addStalePages(first, new Set([2]))).toEqual(new Set([0, 2]));
  });

  it("lets 'all' win over a pending scoped set", () => {
    expect(addStalePages(new Set([1]), "all")).toBe("all");
  });

  it("never narrows back down once everything is suspect", () => {
    // Undo/redo/reload mark "all"; a later scoped edit must not shrink that.
    expect(addStalePages("all", new Set([1]))).toBe("all");
  });

  it("does not alias the caller's set", () => {
    const incoming = new Set([1]);
    const result = addStalePages(null, incoming) as Set<number>;
    incoming.add(9);
    expect(result).toEqual(new Set([1]));
  });

  it("does not mutate the previous accumulator", () => {
    const previous = new Set([1]);
    addStalePages(previous, new Set([4]));
    expect(previous).toEqual(new Set([1]));
  });
});

describe("stalePageNumbers", () => {
  it("asks for the whole document when nothing is recorded", () => {
    expect(stalePageNumbers(null, 3)).toBeNull();
  });

  it("asks for the whole document when everything is suspect", () => {
    expect(stalePageNumbers("all", 3)).toBeNull();
  });

  it("converts a scoped set to sorted 1-based page numbers", () => {
    expect(stalePageNumbers(new Set([2, 0]), 3)).toEqual([1, 3]);
  });

  it("drops pages the document no longer has", () => {
    expect(stalePageNumbers(new Set([0, 7]), 3)).toEqual([1]);
  });

  it("drops negative and non-integer pages", () => {
    expect(stalePageNumbers(new Set([-1, 1.5, 1]), 3)).toEqual([2]);
  });

  it("can legitimately resolve to no work at all", () => {
    expect(stalePageNumbers(new Set([9]), 3)).toEqual([]);
  });
});
