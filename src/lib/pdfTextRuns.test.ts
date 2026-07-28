import { describe, expect, it } from "vitest";
import {
  groupPdfTextRunsByPage,
  mergePdfTextRunSources,
  projectPdfTextRun,
  projectPdfTextRuns,
  type PdfTextRunSource,
} from "./pdfTextRuns";

/**
 * A verbatim copy of the previous implementation, which computed screen-space
 * geometry during extraction at the render scale. The projection must keep
 * reproducing it exactly, or hit boxes and replacement coordinates shift.
 */
function legacyRun(
  raw: { str: string; width?: number; height?: number; transform: number[] },
  viewportTransform: number[],
  renderScale: number,
  page: number
) {
  const value = raw.str.trim();
  const matrix = transform(viewportTransform, raw.transform);
  const cssHeight =
    Math.hypot(matrix[2], matrix[3]) ||
    Math.max(8, (raw.height ?? 10) * renderScale);
  const cssWidth = Math.max(8, (raw.width ?? value.length * 6) * renderScale);
  const pdfHeight = Math.max(6, raw.height ?? cssHeight / renderScale);
  const pdfWidth = Math.max(6, raw.width ?? cssWidth / renderScale);
  return {
    page,
    text: raw.str,
    left: matrix[4],
    top: matrix[5] - cssHeight,
    width: cssWidth,
    height: cssHeight,
    pdfX: raw.transform[4],
    pdfY: raw.transform[5] - pdfHeight * 0.22,
    pdfWidth,
    pdfHeight: pdfHeight * 1.15,
  };
}

/** pdf.js's Util.transform — matrix multiply of two 2x3 affine matrices. */
function transform(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** The viewport transform pdf.js builds for an unrotated page. */
function viewportTransform(scale: number, pageHeight: number): number[] {
  return [scale, 0, 0, -scale, 0, pageHeight * scale];
}

function sourceFor(
  raw: { str: string; width?: number; height?: number; transform: number[] },
  pageHeight: number,
  page = 0
): PdfTextRunSource {
  const m = transform(viewportTransform(1, pageHeight), raw.transform);
  return {
    page,
    text: raw.str,
    unitLeft: m[4],
    unitTop: m[5],
    unitHeight: Math.hypot(m[2], m[3]),
    rawWidth: raw.width,
    rawHeight: raw.height,
    fallbackWidth: raw.str.trim().length * 6,
    pdfX: raw.transform[4],
    pdfYBase: raw.transform[5],
  };
}

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

describe("mergePdfTextRunSources", () => {
  const runOn = (page: number, text: string): PdfTextRunSource => ({
    page,
    text,
    unitLeft: 1,
    unitTop: 2,
    unitHeight: 3,
    fallbackWidth: 6,
    pdfX: 4,
    pdfYBase: 5,
  });

  it("replaces only the named pages and keeps the rest", () => {
    const previous = [runOn(0, "a0"), runOn(1, "OLD"), runOn(2, "a2")];
    const merged = mergePdfTextRunSources(
      previous,
      [runOn(1, "NEW"), runOn(1, "NEW2")],
      new Set([1])
    );
    expect(merged.map((r) => `${r.page}:${r.text}`)).toEqual([
      "0:a0",
      "1:NEW",
      "1:NEW2",
      "2:a2",
    ]);
  });

  it("produces page-ascending order like a full extraction", () => {
    const previous = [runOn(2, "c"), runOn(0, "a")];
    const merged = mergePdfTextRunSources(previous, [runOn(1, "b")], new Set([1]));
    expect(merged.map((r) => r.page)).toEqual([0, 1, 2]);
  });

  it("drops a replaced page's runs when the new extraction finds none", () => {
    // Erasing the only text on a page must not leave its old hit boxes behind.
    const previous = [runOn(0, "keep"), runOn(1, "erased")];
    const merged = mergePdfTextRunSources(previous, [], new Set([1]));
    expect(merged.map((r) => `${r.page}:${r.text}`)).toEqual(["0:keep"]);
  });

  it("ignores replacements for pages outside the replaced set", () => {
    // A stale run for an unrelated page must never slip in.
    const previous = [runOn(0, "a"), runOn(1, "b")];
    const merged = mergePdfTextRunSources(
      previous,
      [runOn(0, "STALE"), runOn(1, "fresh")],
      new Set([1])
    );
    expect(merged.map((r) => `${r.page}:${r.text}`)).toEqual(["0:a", "1:fresh"]);
  });

  it("does not mutate the previous array", () => {
    const previous = [runOn(0, "a"), runOn(1, "b")];
    mergePdfTextRunSources(previous, [runOn(1, "c")], new Set([1]));
    expect(previous.map((r) => r.text)).toEqual(["a", "b"]);
  });
});

describe("projectPdfTextRun", () => {
  const PAGE_HEIGHT = 792;
  const cases: {
    label: string;
    raw: { str: string; width?: number; height?: number; transform: number[] };
  }[] = [
    {
      label: "ordinary run",
      raw: { str: "Hello world", width: 64, height: 12, transform: [12, 0, 0, 12, 72, 700] },
    },
    {
      label: "no reported extents",
      raw: { str: "estimate me", transform: [10, 0, 0, 10, 100, 400] },
    },
    {
      label: "sub-8px run (clamped after scaling, not before)",
      raw: { str: "x", width: 2, height: 1.5, transform: [1.5, 0, 0, 1.5, 20, 20] },
    },
    {
      label: "degenerate transform (zero height)",
      raw: { str: "flat", width: 20, height: 9, transform: [0, 0, 0, 0, 30, 300] },
    },
    {
      label: "skewed / rotated text matrix",
      raw: { str: "angled", width: 40, height: 11, transform: [8, 6, -6, 8, 200, 500] },
    },
  ];

  for (const { label, raw } of cases) {
    it(`matches the pre-refactor geometry — ${label}`, () => {
      const source = sourceFor(raw, PAGE_HEIGHT);
      for (const scale of [0.5, 1, 1.2, 2.5, 4]) {
        const expected = legacyRun(raw, viewportTransform(scale, PAGE_HEIGHT), scale, 0);
        const actual = projectPdfTextRun(source, scale);
        for (const field of [
          "left",
          "top",
          "width",
          "height",
          "pdfX",
          "pdfY",
          "pdfWidth",
          "pdfHeight",
        ] as const) {
          expect(actual[field], `${field} @ scale ${scale}`).toBeCloseTo(
            expected[field],
            9
          );
        }
        expect(actual.text).toBe(expected.text);
        expect(actual.page).toBe(expected.page);
      }
    });
  }

  it("keeps PDF-space coordinates identical across zoom levels", () => {
    // These feed replaceText, so a zoom-dependent value would place the
    // replacement box wrong.
    const source = sourceFor(
      { str: "anchor", width: 40, height: 11, transform: [11, 0, 0, 11, 90, 600] },
      PAGE_HEIGHT
    );
    const at1 = projectPdfTextRun(source, 1);
    for (const scale of [0.5, 1.2, 2.5, 4]) {
      const at = projectPdfTextRun(source, scale);
      expect(at.pdfX).toBe(at1.pdfX);
      expect(at.pdfY).toBe(at1.pdfY);
      expect(at.pdfWidth).toBe(at1.pdfWidth);
      expect(at.pdfHeight).toBe(at1.pdfHeight);
    }
  });

  it("scales screen geometry linearly with zoom", () => {
    const source = sourceFor(
      { str: "grow", width: 40, height: 11, transform: [11, 0, 0, 11, 90, 600] },
      PAGE_HEIGHT
    );
    const at1 = projectPdfTextRun(source, 1);
    const at2 = projectPdfTextRun(source, 2);
    expect(at2.left).toBeCloseTo(at1.left * 2, 9);
    expect(at2.height).toBeCloseTo(at1.height * 2, 9);
    expect(at2.width).toBeCloseTo(at1.width * 2, 9);
  });

  it("projects a whole document and preserves order", () => {
    const runs = projectPdfTextRuns(
      [
        sourceFor({ str: "a", width: 10, height: 9, transform: [9, 0, 0, 9, 10, 700] }, PAGE_HEIGHT, 0),
        sourceFor({ str: "b", width: 10, height: 9, transform: [9, 0, 0, 9, 10, 680] }, PAGE_HEIGHT, 1),
      ],
      1.2
    );
    expect(runs.map((r) => r.text)).toEqual(["a", "b"]);
    expect(runs.map((r) => r.page)).toEqual([0, 1]);
  });
});
