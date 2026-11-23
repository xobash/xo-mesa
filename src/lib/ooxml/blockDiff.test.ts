import { describe, expect, it } from "vitest";
import { diffBlocks } from "./blockDiff";

function lcsLength(a: readonly string[], b: readonly string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return row[b.length];
}

function checkMatch(a: readonly string[], b: readonly string[], maxEdits?: number) {
  const match = diffBlocks(a, b, maxEdits);
  let last = -1;
  let count = 0;
  match.beforeToAfter.forEach((j, i) => {
    if (j < 0) return;
    expect(a[i]).toBe(b[j]);
    expect(j).toBeGreaterThan(last);
    expect(match.afterToBefore[j]).toBe(i);
    last = j;
    count++;
  });
  return count;
}

describe("diffBlocks", () => {
  it("finds a longest common subsequence, in order, on varied inputs", () => {
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: next() % 12 }, () => String.fromCharCode(97 + (next() % 4)));
      const b = Array.from({ length: next() % 12 }, () => String.fromCharCode(97 + (next() % 4)));
      expect(checkMatch(a, b)).toBe(lcsLength(a, b));
    }
  });

  it("reports the whole middle as replaced past the edit bound, keeping prefix and suffix", () => {
    const a = ["head", ..."abcdefgh"], b = ["head", ..."hgfedcba"];
    const match = diffBlocks([...a, "tail"], [...b, "tail"], 2);
    expect(match.beforeToAfter[0]).toBe(0);
    expect(match.beforeToAfter[9]).toBe(9);
    expect([...match.beforeToAfter.slice(1, 9)].every((j) => j === -1)).toBe(true);
  });

  it("handles one change in a large sequence", () => {
    const a = Array.from({ length: 50_000 }, (_, i) => `p${i}`);
    const b = a.map((x, i) => (i === 25_000 ? "edited" : x));
    expect(checkMatch(a, b)).toBe(49_999);
  });
});
