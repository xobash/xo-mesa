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
