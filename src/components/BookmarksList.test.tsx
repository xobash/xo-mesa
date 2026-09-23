import { describe, expect, it } from "vitest";
import { resolveBookmarkItems } from "./BookmarksList";
import type { VaultFile } from "../types";

function file(relPath: string): VaultFile {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return {
    path: `/vault/${relPath}`,
    relPath,
    name: base.replace(/\.[^.]+$/, ""),
    ext,
    isMarkdown: ext === "md" || ext === "markdown",
  };
}

describe("resolveBookmarkItems", () => {
  it("resolves files, ancestor folders, and explicit empty folders without stale rows", () => {
    const items = resolveBookmarkItems(
      [
        "Projects/Alpha.md",
        "Projects",
        "Projects/Nested",
        "Empty folder",
        "Missing",
      ],
      [file("Projects/Alpha.md"), file("Projects/Nested/Beta.pdf")],
      ["Empty folder"]
    );

    expect(items).toEqual([
      { rel: "Projects/Alpha.md", isFile: true, isFolder: false },
      { rel: "Projects", isFile: false, isFolder: true },
      { rel: "Projects/Nested", isFile: false, isFolder: true },
      { rel: "Empty folder", isFile: false, isFolder: true },
    ]);
  });

  it("reads the file list once instead of scanning it for each bookmark", () => {
    let relPathReads = 0;
    const files = Array.from({ length: 12_000 }, (_unused, i) => {
      const entry = file(`Folder ${i % 1_800}/Sub ${i % 37}/Note ${i}.md`);
      return {
        get relPath() {
          relPathReads++;
          return entry.relPath;
        },
      };
    });
    const bookmarks = Array.from({ length: 5_000 }, (_unused, i) =>
      i % 3 === 0 ? `Folder ${i % 1_800}/Sub ${i % 37}/Note ${i}.md` : `Folder ${i % 1_800}`
    );

    const items = resolveBookmarkItems(bookmarks, files, []);

    expect(items).toHaveLength(bookmarks.length);
    expect(relPathReads).toBe(files.length);
  });
});
