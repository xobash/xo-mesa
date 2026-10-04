import { describe, it, expect } from "vitest";
import { fileComparator, folderComparator, type FolderAgg } from "./sort";
import type { VaultFile, NoteMeta } from "../types";

function vf(name: string, extra: Partial<VaultFile> = {}): VaultFile {
  return {
    path: "/v/" + name + ".md",
    relPath: name + ".md",
    name,
    ext: "md",
    isMarkdown: true,
    ...extra,
  };
}
const note = (rel: string, links: number): NoteMeta => ({
  relPath: rel,
  title: rel,
  rawLinks: Array(links).fill("x"),
  tags: [],
  aliases: [],
});

describe("fileComparator", () => {
  const a = vf("a", { mtime: 100, size: 10 });
  const b = vf("b", { mtime: 300, size: 5 });
  const c = vf("c", { mtime: 200, size: 50 });
  const notes = {
    "a.md": note("a.md", 5),
    "b.md": note("b.md", 1),
    "c.md": note("c.md", 9),
  };

  it("sorts by name", () => {
    expect([c, a, b].sort(fileComparator("name", notes)).map((f) => f.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
  it("sorts by modified (newest first)", () => {
    expect(
      [a, b, c].sort(fileComparator("modified", notes)).map((f) => f.name)
    ).toEqual(["b", "c", "a"]);
  });
  it("sorts by size (largest first)", () => {
    expect([a, b, c].sort(fileComparator("size", notes)).map((f) => f.name)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
  it("sorts by links (most first)", () => {
    expect([a, b, c].sort(fileComparator("links", notes)).map((f) => f.name)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});

describe("folderComparator", () => {
  const fa = (name: string, extra: Partial<FolderAgg> = {}): FolderAgg => ({
    name,
    mtime: 0,
    size: 0,
    links: 0,
    ...extra,
  });
  const docs = fa("docs", { mtime: 100, size: 10, links: 5 });
  const code = fa("code", { mtime: 300, size: 5, links: 1 });
  const misc = fa("misc", { mtime: 200, size: 50, links: 9 });

  it("sorts folders by name", () => {
    expect(
      [misc, docs, code].sort(folderComparator("name")).map((f) => f.name)
    ).toEqual(["code", "docs", "misc"]);
  });
  it("sorts folders by newest descendant", () => {
    expect(
      [docs, code, misc].sort(folderComparator("modified")).map((f) => f.name)
    ).toEqual(["code", "misc", "docs"]);
  });
  it("sorts folders by total size", () => {
    expect(
      [docs, code, misc].sort(folderComparator("size")).map((f) => f.name)
    ).toEqual(["misc", "docs", "code"]);
  });
  it("sorts folders by total links", () => {
    expect(
      [docs, code, misc].sort(folderComparator("links")).map((f) => f.name)
    ).toEqual(["misc", "docs", "code"]);
  });
  it("falls back to name for the type mode (folders have no extension)", () => {
    expect(
      [misc, docs, code].sort(folderComparator("type")).map((f) => f.name)
    ).toEqual(["code", "docs", "misc"]);
  });
});

describe("compareNames", () => {
  /**
   * `compareNames` is a shared Intl.Collator — it must be indistinguishable
   * from the `localeCompare(b, undefined, { numeric: true })` expression it
   * replaced (the per-call form re-resolves options: ~170 ms to sort the
   * measured 4,165-file vault, vs ~10 ms shared). Sign-equivalence is pinned
   * over names shaped like the real vault: numbered exports, dated notes,
   * hashes, case mixes, diacritics, and numeric runs of differing length.
   */
  it("orders exactly like localeCompare with numeric:true", async () => {
    const { compareNames } = await import("./sort");
    const names = [
      "EFTA00003176", "EFTA00003175", "efta00003175", "EFTA3176",
      "02-webview", "10-mesa", "2-webview", "note 2", "note 10", "Note 10",
      "local_5c13d687", "Ærø", "aero", "café", "cafe", "Zebra", "apple",
      "", " ", "a", "A", "10", "9", "0010", "10a", "9a",
    ];
    let seed = 424242;
    const rnd = (n: number) => {
      seed = (seed * 48271) % 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 5000; i++) {
      const a = names[rnd(names.length)];
      const b = names[rnd(names.length)];
      expect(Math.sign(compareNames(a, b))).toBe(
        Math.sign(a.localeCompare(b, undefined, { numeric: true }))
      );
    }
  });
});
