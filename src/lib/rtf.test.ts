import { describe, it, expect } from "vitest";
import { rtfToText } from "./rtf";

const SAMPLE = [
  "{\\rtf1\\ansi\\ansicpg1252\\cocoartf2639",
  "{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}",
  "{\\colortbl;\\red255\\green255\\blue255;}",
  "\\f0\\fs24 \\cf0 Hello \\b world\\b0 .\\",
  " Second line\\par",
  "Tab\\tab here\\par}",
].join("\n");

describe("rtfToText", () => {
  it("renders readable text, dropping styling + tables", () => {
    const t = rtfToText(SAMPLE);
    expect(t).toContain("Hello world.");
    expect(t).toContain("Second line");
    expect(t).toContain("\t");
    expect(t).not.toMatch(/fonttbl|colortbl|Helvetica/);
  });
  it("decodes \\'xx hex and \\uN unicode escapes", () => {
    expect(rtfToText("{\\rtf1 caf\\'e9}")).toContain("café");
    expect(rtfToText("{\\rtf1 \\u233 ?}").trim()).toContain("é");
  });
  it("passes non-RTF through unchanged", () => {
    expect(rtfToText("just text")).toBe("just text");
  });
});

it("handles long whitespace runs without repeated scans", () => {
  const spaces = " ".repeat(40000);
  const start = performance.now();
  expect(rtfToText(`{\\rtf1 ${spaces}x}`)).toBe("x");
  expect(rtfToText(`{\\rtf1 a${spaces}\\par b}`)).toBe("a\nb");
  expect(performance.now() - start).toBeLessThan(500);
});

it("preserves whitespace cleanup across spaces, tabs, and paragraphs", () => {
  for (const gap of ["", " ", "\t", " \t ", "\t".repeat(20)]) {
    for (const tail of ["b", "\\par b", "\\par\\par\\par b"]) {
      const decoded = `a${gap}${tail.replace(/\\par ?/g, "\n")}`;
      const expected = decoded.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      expect(rtfToText(`{\\rtf1 a${gap}${tail}}`)).toBe(expected);
    }
  }
});
