import { describe, expect, it } from "vitest";
import { applyTextDiffChoice, diffTextLines } from "./textDiff";

describe("conflict text diffs", () => {
  it("groups changed lines and applies the conflict side to a draft", () => {
    const parts = diffTextLines("a\nlocal\nc\n", "a\nremote\nc\n");
    expect(parts).toEqual([
      { kind: "same", lines: ["a\n"] },
      { kind: "change", original: ["local\n"], other: ["remote\n"] },
      { kind: "same", lines: ["c\n"] },
    ]);
    expect(applyTextDiffChoice("a\nlocal\nc\n", parts[1], "other")).toBe("a\nremote\nc\n");
  });

  it("can keep the original side after a draft edit", () => {
    const part = diffTextLines("old\n", "new\n")[0];
    expect(applyTextDiffChoice("old\nextra\n", part, "original")).toBe("old\nextra\n");
  });
});
