import { describe, it, expect } from "vitest";
import { TEXT_CACHE_BUDGET_CHARS, retainLazyTextCache } from "./textCachePlan";
import type { VaultFile } from "../types";

describe("retainLazyTextCache", () => {
  const cacheFile = (
    relPath: string,
    ext: string,
    isMarkdown = false
  ): VaultFile => ({
    path: "/vault/" + relPath,
    relPath,
    name: relPath,
    ext,
    isMarkdown,
  });

  it("evicts the oldest clean non-markdown entry and keeps markdown", () => {
    const files = [
      cacheFile("old.txt", "txt"),
      cacheFile("new.txt", "txt"),
      cacheFile("note.md", "md", true),
    ];
    const recency = new Map([
      ["old.txt", 1],
      ["new.txt", 2],
    ]);
    const cache = {
      "old.txt": "1234",
      "new.txt": "5678",
      "note.md": "markdown",
    };

    const bounded = retainLazyTextCache(
      cache,
      files,
      (candidate) => candidate.ext === "txt" || candidate.isMarkdown === true,
      recency,
      new Set(["new.txt"]),
      4
    );

    expect(bounded).toEqual({ "new.txt": "5678", "note.md": "markdown" });
    expect(recency.has("old.txt")).toBe(false);
  });

  it("allows pinned active content to exceed the budget rather than evict it", () => {
    const files = [cacheFile("active.txt", "txt")];
    const cache = { "active.txt": "x".repeat(TEXT_CACHE_BUDGET_CHARS + 1) };

    const bounded = retainLazyTextCache(
      cache,
      files,
      () => true,
      new Map(),
      new Set(["active.txt"])
    );

    expect(bounded).toBe(cache);
  });
});
