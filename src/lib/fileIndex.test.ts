import { expect, it } from "vitest";
import type { VaultFile } from "../types";
import { createFileIndex, relPathsOf } from "./fileIndex";

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
