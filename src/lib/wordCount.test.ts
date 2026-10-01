import { describe, it, expect } from "vitest";
import { countWords, isMarkdownWhitespace } from "./wordCount";

/** The exact expression `StatusBar` used before `countWords` existed. */
function legacyWordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** Every code point the ECMAScript `\s` class matches. */
const WHITESPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028,
  0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

describe("isMarkdownWhitespace", () => {
  it("matches the ECMAScript \\s class exactly across the BMP", () => {
    const expected = new Set(WHITESPACE);
    const mismatches: number[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const viaRegex = /\s/.test(String.fromCharCode(code));
      if (viaRegex !== isMarkdownWhitespace(code)) mismatches.push(code);
      // The regex is the authority; the table above must agree with it too.
      if (viaRegex !== expected.has(code)) mismatches.push(code);
    }
    expect(mismatches).toEqual([]);
  });
});

describe("countWords", () => {
  const cases: [string, string][] = [
    ["empty", ""],
    ["only spaces", "     "],
    ["only newlines", "\n\n\n"],
    ["single word", "hello"],
    ["single word padded", "   hello   "],
    ["two words", "hello world"],
    ["collapsed runs", "a    b\t\tc\n\n\nd"],
    ["leading and trailing mix", "\n\t  alpha beta \r\n "],
    ["punctuation is not a separator", "one, two; three -- four"],
    ["markdown syntax", "# Heading\n\n- [ ] task **bold** `code`\n"],
    ["non-breaking space", "alpha beta"],
    ["unicode spaces", "a b c　d"],
    ["line + paragraph separators", "a b c"],
    ["bom between words", "a﻿b"],
    ["cjk without spaces", "日本語のテキスト"],
    ["emoji", "🎉 party 🎉 time"],
    ["surrogate pair alone", "😀"],
    ["windows line endings", "a\r\nb\r\nc"],
  ];

  for (const [name, input] of cases) {
    it(`matches the legacy expression: ${name}`, () => {
      expect(countWords(input)).toBe(legacyWordCount(input));
    });
  }

  it("matches the legacy expression on a large generated document", () => {
    const unit =
      "## Section\n\nSome **prose** with a [[Wiki Link]] and `code`.\n\n- item one\n- item two\n\n";
    let doc = "";
    while (doc.length < 200_000) doc += unit;
    expect(countWords(doc)).toBe(legacyWordCount(doc));
  });

  it("matches the legacy expression on randomized whitespace soup", () => {
    let seed = 0x2545f491;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0xffffffff;
    };
    for (let trial = 0; trial < 200; trial++) {
      let s = "";
      const len = Math.floor(rand() * 60);
      for (let i = 0; i < len; i++) {
        if (rand() < 0.45) {
          s += String.fromCharCode(
            WHITESPACE[Math.floor(rand() * WHITESPACE.length)]
          );
        } else {
          s += String.fromCharCode(0x61 + Math.floor(rand() * 26));
        }
      }
      expect(countWords(s)).toBe(legacyWordCount(s));
    }
  });
});
