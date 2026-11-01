import { expect, it, vi } from "vitest";
import type { VaultFile } from "../types";
import { KNOWN_FOLDER_SCANS_BEFORE_SET, createFileIndex, createKnownFolderCheck, relPathsOf } from "./fileIndex";

const file = (relPath: string, path = `/v/${relPath}`): VaultFile => ({ path, relPath, name: relPath, ext: "md", isMarkdown: true });

it("rebuilds the lookup only when the files array identity changes", () => {
  const lookup = createFileIndex();
  const files = [file("a.md"), file("b.md")];
  const first = lookup(files);
  expect(first.get("b.md")).toBe(files[1]);
  // In-place edits are invisible until the array is replaced.
  files.push(file("c.md"));
  expect(lookup(files)).toBe(first);
  expect(lookup(files).has("c.md")).toBe(false);
  const replaced = [...files];
  const second = lookup(replaced);
  expect(second).not.toBe(first);
  expect(second.get("c.md")).toBe(replaced[2]);
});

it("keeps the first entry for a duplicated relPath, like Array.find", () => {
  const original = file("a.md", "/v/first");
  const index = createFileIndex()([original, file("a.md", "/v/second")]);
  expect(index.get("a.md")).toBe(original);
  expect(index.size).toBe(1);
});

it("caches relPath lists per array identity", () => {
  const files = [file("x.md"), file("y.md")];
  const list = relPathsOf(files);
  expect(list).toEqual(["x.md", "y.md"]);
  expect(relPathsOf(files)).toBe(list);
  expect(relPathsOf([...files])).not.toBe(list);
});

it("answers known-folder probes like a prefix scan before and after switching to a folder set", () => {
  const rels = ["notes/a.md", "notes/deep/b.md", "notesy.md", "/lead.md", "x//y.md", "Top.md"];
  const linear = (rel: string) => rels.some((known) => known.startsWith(`${rel}/`));
  const probes = ["notes", "notes/deep", "note", "notesy.md", "notes/a.md", "", "x", "x/", "Top.md", "NOTES", "deep"];
  const check = createKnownFolderCheck();
  // Run past the scan threshold so both answer paths are compared.
  for (let round = 0; round < 3 * KNOWN_FOLDER_SCANS_BEFORE_SET; round++) {
    const rel = probes[round % probes.length];
    expect(check(rels, rel)).toBe(linear(rel));
  }
  // A new list identity starts over from that list.
  const next = ["other/c.md"];
  expect(check(next, "notes")).toBe(false);
  expect(check(next, "other")).toBe(true);
});

it("builds the folder set after the scan threshold instead of scanning again", () => {
  const rels = ["a/b.md", "c/d.md"];
  const some = vi.spyOn(rels, "some");
  const check = createKnownFolderCheck();
  for (let i = 0; i < KNOWN_FOLDER_SCANS_BEFORE_SET + 10; i++) check(rels, "a");
  expect(some).toHaveBeenCalledTimes(KNOWN_FOLDER_SCANS_BEFORE_SET);
});
