import { describe, it, expect } from "vitest";
import { langForExt, tokenize, parseDelimited, type Token } from "./highlight";

const typesOf = (toks: Token[], t: Token["type"]) =>
  toks.filter((x) => x.type === t).map((x) => x.value);
// reconstructing the source from tokens must be lossless
const join = (toks: Token[]) => toks.map((t) => t.value).join("");

describe("langForExt", () => {
  it("maps known extensions and falls back to text", () => {
    expect(langForExt("ts")).toBe("js");
    expect(langForExt("YML")).toBe("yaml");
    expect(langForExt("ps1")).toBe("powershell");
    expect(langForExt("bat")).toBe("bat");
    expect(langForExt("whatever")).toBe("text");
  });
});

describe("tokenize", () => {
  it("is lossless (tokens rejoin to the original)", () => {
    const src = `const x = "hi"; // note\nfoo(1, 2)`;
    expect(join(tokenize(src, "js"))).toBe(src);
  });

  it("highlights strings, numbers, keywords and line comments", () => {
    const src = `const n = 42 // tail`;
    const toks = tokenize(src, "js");
    expect(typesOf(toks, "keyword")).toContain("const");
    expect(typesOf(toks, "number")).toContain("42");
    expect(typesOf(toks, "comment")).toContain("// tail");
  });

  it("handles block comments and template strings", () => {
    const src = "/* a */ `multi\nline`";
    const toks = tokenize(src, "js");
    expect(typesOf(toks, "comment")).toContain("/* a */");
    expect(typesOf(toks, "string").some((s) => s.includes("\n"))).toBe(true);
  });

  it("treats bat REM as a comment only at line start, not mid-word", () => {
    const toks = tokenize("rem hello\nremix = 1", "bat");
    expect(typesOf(toks, "comment")).toEqual(["rem hello"]);
    // "remix" must NOT be swallowed as a comment
    expect(join(toks)).toContain("remix");
  });

  it("does not treat digits inside identifiers as numbers", () => {
    const toks = tokenize("var x1 = 9", "js");
    expect(typesOf(toks, "number")).toEqual(["9"]);
  });
});

describe("parseDelimited", () => {
  it("parses simple CSV rows", () => {
    expect(parseDelimited("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("honours quoted fields with commas, newlines and escaped quotes", () => {
    const csv = `name,note\n"Doe, Jane","line1\nline2"\n"a ""quote""",x`;
    expect(parseDelimited(csv)).toEqual([
      ["name", "note"],
      ["Doe, Jane", "line1\nline2"],
      ['a "quote"', "x"],
    ]);
  });

  it("supports a tab delimiter", () => {
    expect(parseDelimited("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});
