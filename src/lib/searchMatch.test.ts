import { beforeEach, describe, it, expect } from "vitest";
import {
  buildRawMatcher,
  scanRaw,
  canScanRaw,
  canScanRawFor,
  resetSearchEligibility,
  LENGTH_CHANGING_CHAR,
} from "./searchMatch";

/** The exact predicate the fast path must reproduce. */
function legacy(raw: string, termLower: string): { first: number; count: number } {
  const text = raw.toLowerCase();
  const first = text.indexOf(termLower);
  const re = new RegExp(termLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  return { first, count: (text.match(re) || []).length };
}

/** Fast path, with the same fallback rule `searchVault` applies. */
function fast(raw: string, termLower: string): { first: number; count: number } {
  const re = buildRawMatcher(termLower);
  if (!re || !canScanRaw(raw)) return legacy(raw, termLower);
  return scanRaw(raw, re, termLower.length);
}

describe("the Unicode facts the fast path depends on", () => {
  it("U+212A is the ONLY non-ASCII code point that lowercases into ASCII", () => {
    const found: string[] = [];
    for (let c = 0x80; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      const lo = ch.toLowerCase();
      // eslint-disable-next-line no-control-regex
      if (lo !== ch && /^[\x00-\x7f]+$/.test(lo)) {
        found.push("U+" + c.toString(16).toUpperCase().padStart(4, "0"));
      }
    }
    expect(found).toEqual(["U+212A"]);
  });

  it("U+0130 is the ONLY code point whose lowercase changes length", () => {
    const found: string[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      if (ch.toLowerCase().length !== 1) {
        found.push("U+" + c.toString(16).toUpperCase().padStart(4, "0"));
      }
    }
    expect(found).toEqual(["U+0130"]);
    expect(String.fromCharCode(0x130)).toBe(LENGTH_CHANGING_CHAR);
  });
});

describe("fast path parity with toLowerCase()", () => {
  const cases: [string, string, string][] = [
    ["plain hit", "the quick brown fox", "quick"],
    ["case-insensitive", "The Quick BROWN Fox", "brown"],
    ["phrase with a space", "find hidden assumptions here", "hidden assumptions"],
    ["repeated term", "aaa bbb aaa ccc aaa", "aaa"],
    ["no hit", "nothing to see", "zebra"],
    ["term at start", "budget report", "budget"],
    ["term at end", "report budget", "budget"],
    ["regex metacharacters", "cost is $5.00 (net)", "$5.00"],
    ["brackets", "an [[wiki link]] here", "[[wiki"],
    ["plus and star", "a+b*c", "a+b*c"],
    ["kelvin sign in text", "temperature 300K today", "k"],
    ["kelvin uppercase query source", "300K", "k"],
    ["ascii k still matches", "a Kilogram of K", "k"],
    ["overlapping-ish", "aaaa", "aa"],
    ["unicode text ascii term", "café serves coffee", "coffee"],
    ["cjk body ascii term", "日本語 test テキスト", "test"],
    ["newlines", "line one\nline two\nline one", "line one"],
    ["tab separated", "a\tbudget\tb", "budget"],
    ["empty text", "", "term"],
    ["dotted capital I present", `Bu ${LENGTH_CHANGING_CHAR}stanbul k`, "k"],
    ["dotted capital I with i term", `${LENGTH_CHANGING_CHAR}stanbul`, "i"],
  ];

  for (const [name, raw, term] of cases) {
    it(`matches legacy: ${name}`, () => {
      expect(fast(raw, term)).toEqual(legacy(raw, term));
    });
  }

  it("returns the RAW index, so snippets slice correctly", () => {
    const raw = "0123456789BUDGET";
    const re = buildRawMatcher("budget")!;
    const { first } = scanRaw(raw, re, 6);
    expect(first).toBe(10);
    expect(raw.slice(first, first + 6)).toBe("BUDGET");
  });

  it("falls back for a non-ASCII term", () => {
    expect(buildRawMatcher("café")).toBeNull();
    expect(fast("a café here", "café")).toEqual(legacy("a café here", "café"));
  });

  it("refuses the fast path on text containing U+0130", () => {
    expect(canScanRaw(`x${LENGTH_CHANGING_CHAR}y`)).toBe(false);
    expect(canScanRaw("ordinary text")).toBe(true);
  });

  it("one matcher can be reused across many texts", () => {
    const re = buildRawMatcher("note")!;
    expect(scanRaw("a note", re, 4)).toEqual({ first: 2, count: 1 });
    expect(scanRaw("NOTE note", re, 4)).toEqual({ first: 0, count: 2 });
    expect(scanRaw("nothing", re, 4)).toEqual({ first: -1, count: 0 });
  });

  it("matches legacy across randomized text and terms", () => {
    let seed = 0x9e3779b9;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0xffffffff;
    };
    const alphabet = "abcABC kKK .$[]* \nİé";
    for (let trial = 0; trial < 400; trial++) {
      let raw = "";
      const len = Math.floor(rand() * 40);
      for (let i = 0; i < len; i++) {
        raw += alphabet[Math.floor(rand() * alphabet.length)];
      }
      let term = "";
      const tlen = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < tlen; i++) {
        term += alphabet[Math.floor(rand() * alphabet.length)];
      }
      term = term.toLowerCase();
      expect(fast(raw, term)).toEqual(legacy(raw, term));
    }
  });
});

describe("canScanRawFor: memoized eligibility", () => {
  beforeEach(() => resetSearchEligibility());

  it("returns exactly what canScanRaw returns, memoized or not", () => {
    const plain = "ordinary text";
    const dotted = `x${LENGTH_CHANGING_CHAR}y`;
    // cold, then warm — the answer must not drift
    expect(canScanRawFor("a.md", plain)).toBe(canScanRaw(plain));
    expect(canScanRawFor("a.md", plain)).toBe(canScanRaw(plain));
    expect(canScanRawFor("b.md", dotted)).toBe(canScanRaw(dotted));
    expect(canScanRawFor("b.md", dotted)).toBe(canScanRaw(dotted));
  });

  it("re-derives when the same key's text changes", () => {
    // The whole safety argument: an edited file is a different string instance,
    // so a memo entry can never answer for text it was not computed from.
    expect(canScanRawFor("note.md", "clean")).toBe(true);
    expect(canScanRawFor("note.md", `now ${LENGTH_CHANGING_CHAR} dirty`)).toBe(false);
    expect(canScanRawFor("note.md", "clean again")).toBe(true);
  });

  it("keeps separate answers per key", () => {
    expect(canScanRawFor("clean.md", "abc")).toBe(true);
    expect(canScanRawFor("dirty.md", LENGTH_CHANGING_CHAR)).toBe(false);
    expect(canScanRawFor("clean.md", "abc")).toBe(true);
    expect(canScanRawFor("dirty.md", LENGTH_CHANGING_CHAR)).toBe(false);
  });

  it("does not answer from a previous vault after a reset", () => {
    expect(canScanRawFor("Note.md", LENGTH_CHANGING_CHAR)).toBe(false);
    resetSearchEligibility();
    // Same key, different vault, different text.
    expect(canScanRawFor("Note.md", "fresh vault text")).toBe(true);
  });

  it("agrees with canScanRaw over a randomized corpus", () => {
    let seed = 20260728;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0xffffffff;
    };
    const alphabet = `abc İé K\n.`;
    for (let trial = 0; trial < 400; trial++) {
      let raw = "";
      const len = Math.floor(rand() * 30);
      for (let i = 0; i < len; i++) raw += alphabet[Math.floor(rand() * alphabet.length)];
      const key = `f${trial % 17}.md`;
      expect(canScanRawFor(key, raw)).toBe(canScanRaw(raw));
    }
  });
});
