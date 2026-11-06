import { describe, expect, it } from "vitest";
import { applyTextDiffChoice, diffTextLines, lineEndingOnlyLines } from "./textDiff";

describe("conflict text diffs", () => {
  const reference = (original: string[], other: string[]) => {
    const dp: number[][] = Array.from({ length: original.length + 1 }, () => Array(other.length + 1).fill(0));
    for (let i = original.length - 1; i >= 0; i--) {
      for (let j = other.length - 1; j >= 0; j--) {
        dp[i][j] = original[i] === other[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const parts: ReturnType<typeof diffTextLines> = [];
    let i = 0, j = 0;
    while (i < original.length || j < other.length) {
      let part: ReturnType<typeof diffTextLines>[number];
      if (i < original.length && j < other.length && original[i] === other[j]) {
        part = { kind: "same", lines: [original[i++]] }; j++;
      } else if (j >= other.length || (i < original.length && dp[i + 1][j] >= dp[i][j + 1])) {
        part = { kind: "change", original: [original[i++]], other: [] };
      } else {
        part = { kind: "change", original: [], other: [other[j++]] };
      }
      const last = parts[parts.length - 1];
      if (last?.kind === "same" && part.kind === "same") last.lines.push(...part.lines);
      else if (last?.kind === "change" && part.kind === "change") {
        last.original.push(...part.original); last.other.push(...part.other);
      } else parts.push(part);
    }
    return parts;
  };

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

  it("keeps identical documents as one unchanged section", () => {
    const text = Array.from({ length: 4000 }, (_, i) => `line ${i}\n`).join("");
    expect(diffTextLines(text, text)).toEqual([
      { kind: "same", lines: text.match(/[^\n]*\n/g) },
    ]);
  });

  it("diffs a late edit after a long shared prefix", () => {
    const prefix = Array.from({ length: 4000 }, (_, i) => `line ${i}\n`).join("");
    const parts = diffTextLines(`${prefix}local\nend\n`, `${prefix}remote\nend\n`);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ kind: "same" });
    expect(parts[1]).toEqual({ kind: "change", original: ["local\n"], other: ["remote\n"] });
    expect(parts[2]).toEqual({ kind: "same", lines: ["end\n"] });
  });

  it("matches the original tie choices for repeated lines", () => {
    let seed = 123456789;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % 4);
    for (let caseNo = 0; caseNo < 500; caseNo++) {
      const a = Array.from({ length: random() + random() }, () => `${random()}\n`);
      const b = Array.from({ length: random() + random() }, () => `${random()}\n`);
      expect(diffTextLines(a.join(""), b.join(""))).toEqual(reference(a, b));
    }
  });

  it("treats CRLF and LF lines as the same line and counts them", () => {
    const parts = diffTextLines("a\r\nmine\r\nc\r\n", "a\ntheirs\nc\n");
    expect(parts).toEqual([
      { kind: "same", lines: ["a\r\n"], lineEndingOnly: 1 },
      { kind: "change", original: ["mine\r\n"], other: ["theirs\n"] },
      { kind: "same", lines: ["c\r\n"], lineEndingOnly: 1 },
    ]);
    expect(lineEndingOnlyLines(parts)).toBe(2);
  });

  it("reports a pure line-ending conversion as unchanged text", () => {
    const parts = diffTextLines("one\r\ntwo\r\n", "one\ntwo\n");
    expect(parts).toEqual([{ kind: "same", lines: ["one\r\n", "two\r\n"], lineEndingOnly: 2 }]);
  });

  it("still shows an added or removed final newline as a change", () => {
    expect(diffTextLines("x\r\n", "x")).toEqual([{ kind: "change", original: ["x\r\n"], other: ["x"] }]);
  });

  it("splits classic-Mac CR text into lines", () => {
    expect(diffTextLines("a\rb\r", "a\rc\r")).toEqual([
      { kind: "same", lines: ["a\r"] },
      { kind: "change", original: ["b\r"], other: ["c\r"] },
    ]);
  });

  it("applies a conflict change with the draft's own line endings", () => {
    const parts = diffTextLines("a\r\nmine\r\nc\r\n", "a\ntheirs\nmore\nc\n");
    expect(applyTextDiffChoice("a\r\nmine\r\nc\r\n", parts[1], "other")).toBe("a\r\ntheirs\r\nmore\r\nc\r\n");
  });
});
