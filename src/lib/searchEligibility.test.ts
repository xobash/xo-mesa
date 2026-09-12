import { afterEach, describe, expect, it, vi } from "vitest";
import { createSearchScan, searchVault, type SearchFile } from "./search";
import {
  canScanRawFor,
  LENGTH_CHANGING_CHAR,
  resetSearchEligibility,
} from "./searchMatch";

afterEach(() => vi.restoreAllMocks());

const file = (relPath: string): SearchFile => ({
  relPath,
  name: relPath.split("/").pop()!.replace(/\.[^.]+$/, ""),
  ext: relPath.split(".").pop()!,
});

describe("stateless search eligibility", () => {
  it("checks repeated calls instead of reusing source-keyed answers", () => {
    const raw = "ordinary text".repeat(1000);
    const check = vi.spyOn(String.prototype, "indexOf");
    for (let i = 0; i < 3; i++) expect(canScanRawFor("same.txt", raw)).toBe(true);
    // Every call reaches the predicate. No remembered source is needed to
    // answer a repeated key, even when a caller keeps exactly the same text.
    expect(check).toHaveBeenCalledTimes(3);
    expect(check).toHaveBeenNthCalledWith(1, LENGTH_CHANGING_CHAR);
  });

  it("uses only the current source across repeated changes and reused paths", () => {
    const sources = ["", "clean", "İstanbul", "clean again", "I and K", "xİy"];
    for (let cycle = 0; cycle < 4; cycle++) {
      for (const raw of sources) {
        expect(canScanRawFor("same.txt", raw)).toBe(!raw.includes("İ"));
        expect(canScanRawFor(`new-${cycle}.txt`, raw)).toBe(!raw.includes("İ"));
      }
    }
  });

  it("preserves reset compatibility without changing subsequent answers", () => {
    expect(canScanRawFor("same.txt", "İ")).toBe(false);
    expect(resetSearchEligibility()).toBeUndefined();
    expect(resetSearchEligibility()).toBeUndefined();
    expect(canScanRawFor("same.txt", "İ")).toBe(false);
    expect(canScanRawFor("same.txt", "plain")).toBe(true);
  });

  it("searches full large sources and substring values without a size cutoff", () => {
    const backing = "A".repeat(4 * 1024 * 1024) + "İ";
    const sources = [backing, backing.slice(-128)];
    for (const source of sources) {
      const hits = searchVault([file("large.txt")], { "large.txt": source }, "ext:txt i").hits;
      expect(hits).toHaveLength(1);
      expect(hits[0].rel).toBe("large.txt");
      expect(hits[0].snippet).toContain("İ");
    }
  });
});

describe("search results across corpus changes", () => {
  it("preserves exact Unicode results when files are removed and replaced", () => {
    const files = [file("removed.txt"), file("kept.txt"), file("other.md")];
    const original = {
      "removed.txt": "İstanbul",
      "kept.txt": "plain uppercase I and K",
      "other.md": "İ and café",
    };
    const expected = searchVault(files, original, "ext:txt i");
    expect(expected.hits.map((h) => h.rel)).toEqual(["kept.txt", "removed.txt"]);
    expect(searchVault(files, original, "ext:txt i")).toEqual(expected);

    const currentFiles = files.slice(1);
    const current = { "kept.txt": "no match", "other.md": original["other.md"] };
    expect(searchVault(currentFiles, current, "ext:txt i").hits).toEqual([]);
    expect(searchVault(currentFiles, current, "ext:md i").hits.map((h) => h.rel))
      .toEqual(["other.md"]);
    expect(searchVault(currentFiles, current, "café").hits.map((h) => h.rel))
      .toEqual(["other.md"]);
  });

  it("keeps canceled and interleaved scans independent", () => {
    const files = [file("same.txt")];
    const oldCache = { "same.txt": "İ" + "a".repeat(200_000) };
    const newCache = { "same.txt": "no match" };
    const expectedOld = searchVault(files, oldCache, "ext:txt i");
    const oldScan = createSearchScan(files, oldCache, "ext:txt i");
    expect(oldScan.advance(0)).toBe(false);
    // A canceled caller abandons this scan after its initial work unit.
    const canceled = createSearchScan(files, oldCache, "ext:txt i");
    expect(canceled.advance(0)).toBe(false);
    const newScan = createSearchScan(files, newCache, "ext:txt i");
    resetSearchEligibility();
    while (!newScan.advance(0)) { /* complete the replacement search */ }
    while (!oldScan.advance(0)) { /* interleaved older caller */ }
    expect(newScan.result().hits).toEqual([]);
    expect(oldScan.result()).toEqual(expectedOld);
    expect(searchVault(files, newCache, "ext:txt i").hits).toEqual([]);
  });
});
