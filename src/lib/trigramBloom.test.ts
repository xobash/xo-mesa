import { expect, it } from "vitest";
import { trigramBit } from "./trigramBloom";

// The original substring hash; stored index blooms were written with it.
function substringBit(s: string, i: number): number {
  const t = s.slice(i, i + 3);
  let h = 2166136261;
  for (let j = 0; j < t.length; j++) h = Math.imul(h ^ t.charCodeAt(j), 16777619);
  return (h >>> 0) % 4096;
}

it("matches the stored substring hash for every trigram", () => {
  const text = "mesa vault ünïcödé 漢字 🙂 \uD800 lone [[link]] #tag";
  for (let i = 0; i + 2 < text.length; i++) expect(trigramBit(text, i)).toBe(substringBit(text, i));
  expect(trigramBit("abc", 0)).toBe(0x1a47e90b % 4096); // published FNV-1a("abc")
});
