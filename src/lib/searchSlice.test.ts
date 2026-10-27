import { describe, expect, it } from "vitest";
import {
  createSearchScan,
  searchVault,
  type SearchFile,
  type SearchPass,
} from "./search";

// A sliced pass must produce EXACTLY the pass the synchronous one produces —
// same hits, same order, same counts, same snippets, same candidate set. The
// slicing only changes when the loop yields, never what it computes.

function corpus(n: number): { files: SearchFile[]; cache: Record<string, string> } {
  const files: SearchFile[] = [];
  const cache: Record<string, string> = {};
  const words = ["alpha", "beta", "gamma", "budget", "Budget", "delta"];
  for (let i = 0; i < n; i++) {
    const ext = i % 5 === 0 ? "txt" : i % 3 === 0 ? "pdf" : "md";
    const rel = `folder${i % 7}/file-${i}.${ext}`;
    files.push({ relPath: rel, name: `file-${i}`, ext });
    if (ext !== "pdf") {
      const body: string[] = [];
      for (let w = 0; w <= i % 11; w++) body.push(words[(i + w) % words.length]);
      cache[rel] = `# file ${i}\n${body.join(" ")}\n`;
    }
  }
  return { files, cache };
}

const drain = (
  files: readonly SearchFile[],
  cache: Record<string, string>,
  query: string,
  budgetMs: number,
  previous?: SearchPass | null
): { pass: SearchPass; slices: number } => {
  const scan = createSearchScan(files, cache, query, previous);
  let slices = 0;
  while (!scan.advance(budgetMs)) {
    slices++;
    expect(slices).toBeLessThan(100_000); // progress is guaranteed
  }
  return { pass: scan.result(), slices: slices + 1 };
};

describe("createSearchScan", () => {
  const { files, cache } = corpus(900);

  it.each(["budget", "alpha", "be", "ext:txt budget", ".md", "zzzz"])(
    "matches searchVault exactly for %j",
    (query) => {
      const sync = searchVault(files, cache, query, null);
      const sliced = drain(files, cache, query, 0).pass;
      expect(sliced).toEqual(sync);
    }
  );

  it("yields more than once when the budget is tight", () => {
    // budget 0 forces a yield at every check interval.
    const { slices } = drain(files, cache, "alpha", 0);
    expect(slices).toBeGreaterThan(1);
  });

  it("completes in one slice when the budget is unbounded", () => {
    const { slices } = drain(files, cache, "alpha", Infinity);
    expect(slices).toBe(1);
  });

  it("reports remaining work and reaches zero", () => {
    const scan = createSearchScan(files, cache, "alpha", null);
    expect(scan.remaining).toBe(files.length);
    while (!scan.advance(0)) {
      expect(scan.remaining).toBeGreaterThanOrEqual(0);
    }
    expect(scan.remaining).toBe(0);
  });

  it("narrows from a previous pass identically when sliced", () => {
    const first = searchVault(files, cache, "al", null);
    const sync = searchVault(files, cache, "alph", first);
    const sliced = drain(files, cache, "alph", 0, first).pass;
    expect(sliced).toEqual(sync);
    // …and really did narrow rather than rescan the whole vault.
    expect(first.candidates!.length).toBeLessThan(files.length);
  });

  it("short-circuits a too-short term without scanning", () => {
    const scan = createSearchScan(files, cache, "a", null);
    expect(scan.remaining).toBe(0);
    expect(scan.advance(0)).toBe(true);
    expect(scan.result()).toEqual(searchVault(files, cache, "a", null));
  });

  it("result() finishes the pass if the caller stopped early", () => {
    const scan = createSearchScan(files, cache, "alpha", null);
    scan.advance(0); // one slice only
    expect(scan.result()).toEqual(searchVault(files, cache, "alpha", null));
  });

  it("is stable across repeated drains of separate scans", () => {
    const a = drain(files, cache, "budget", 0).pass;
    const b = drain(files, cache, "budget", 1).pass;
    expect(a).toEqual(b);
  });

  it("yields within one multi-megabyte file without changing its result", () => {
    const rel = "large.html";
    const files: SearchFile[] = [{ relPath: rel, name: "large", ext: "html" }];
    const cache = {
      [rel]: "x".repeat(3_899_000) + "PASSWORD" + "x".repeat(281),
    };
    const scan = createSearchScan(files, cache, "password", null);
    let slices = 0;
    while (!scan.advance(0)) slices++;
    // One file used to be one uninterruptible slice. The deterministic zero
    // budget now exposes the intra-file 64 KiB work units without a flaky
    // wall-clock assertion in CI.
    expect(slices).toBeGreaterThan(50);
    expect(scan.result()).toEqual(searchVault(files, cache, "password", null));
  });
});
