import { describe, expect, it } from "vitest";
import {
  buildCodeLineIndex,
  buildWrappedRowIndex,
  codeLineAt,
  shouldWindowCode,
  visibleCodeLineRange,
} from "./codeWindow";

describe("code viewer line index", () => {
  it("matches split line counts without allocating all line strings", () => {
    for (const text of ["", "one", "one\n", "one\ntwo", "one\r\ntwo\n"]) {
      const index = buildCodeLineIndex(text);
      expect(index.lineCount).toBe(text.split("\n").length);
    }
  });

  it("returns lines without newline terminators", () => {
    const text = "one\r\ntwo\nthree";
    const index = buildCodeLineIndex(text);
    expect(codeLineAt(text, 0, index)).toBe("one");
    expect(codeLineAt(text, 1, index)).toBe("two");
    expect(codeLineAt(text, 2, index)).toBe("three");
  });
});

describe("code viewer windowing", () => {
  it("uses the large-file path only above the product-level threshold", () => {
    expect(shouldWindowCode(10_000, 100)).toBe(false);
    expect(shouldWindowCode(250_000, 100)).toBe(true);
    expect(shouldWindowCode(10_000, 5_000)).toBe(true);
  });

  it("bounds mounted rows to the viewport plus overscan", () => {
    const range = visibleCodeLineRange(100_000, 20_000, 400, 20, 10);
    expect(range.start).toBe(990);
    expect(range.end - range.start).toBe(40);
  });

  it("renders every row when no viewport exists", () => {
    expect(visibleCodeLineRange(12, 0, Number.POSITIVE_INFINITY)).toEqual({
      start: 0,
      end: 12,
    });
  });
});

describe("buildWrappedRowIndex", () => {
  it("splits long lines into fixed-width rows and keeps line breaks", () => {
    const text = "abcdefg\r\n\nxy";
    const index = buildWrappedRowIndex(text, 3);
    const rows = Array.from(index.starts, (s, i) => text.slice(s, index.ends[i]));
    expect(rows).toEqual(["abc", "def", "g", "", "xy"]);
  });

  it("bounds a megabyte single line to short rows", () => {
    const index = buildWrappedRowIndex("x".repeat(1_000_000), 160);
    expect(index.rowCount).toBe(6250);
    expect(index.ends[0] - index.starts[0]).toBe(160);
  });

  it("keeps a surrogate pair in one row at the width boundary", () => {
    const text = "a".repeat(159) + "\u{1F600}";
    const index = buildWrappedRowIndex(text, 160);
    const rows = Array.from(index.starts, (s, i) => text.slice(s, index.ends[i]));
    expect(rows).toEqual(["a".repeat(159), "\u{1F600}"]);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const row of rows) expect(row).not.toMatch(loneSurrogate);
  });
});
