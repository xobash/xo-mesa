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
