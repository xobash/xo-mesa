import { describe, it, expect } from "vitest";
import {
  splitRelPath,
  uniqueRelPath,
  duplicateRelPath,
  childRelPath,
  ancestorFolders,
  safeBaseName,
} from "./fsnames";

describe("safeBaseName", () => {
  it("keeps ordinary names, spaces, and unicode", () => {
    expect(safeBaseName("Meeting notes")).toBe("Meeting notes");
    expect(safeBaseName("Café plan — v2")).toBe("Café plan — v2");
    expect(safeBaseName(".gitignore")).toBe(".gitignore");
  });

  it("strips Windows-invalid characters", () => {
    expect(safeBaseName('plan: v2')).toBe("plan v2");
    expect(safeBaseName('a\\b/c:d*e?f"g<h>i|j')).toBe("abcdefghij");
  });

  it("strips trailing dots and spaces (Windows rejects them)", () => {
    expect(safeBaseName("note.")).toBe("note");
    expect(safeBaseName("note . .")).toBe("note");
  });

  it("refuses Windows reserved device names in any case", () => {
    for (const name of ["CON", "con", "PRN", "aux", "NUL", "COM1", "lpt9"]) {
      expect(safeBaseName(name)).toBe("");
    }
    // …but not names that merely contain them
    expect(safeBaseName("console")).toBe("console");
    expect(safeBaseName("com10")).toBe("com10");
  });

  it("returns empty when nothing usable remains", () => {
    expect(safeBaseName("")).toBe("");
    expect(safeBaseName("   ")).toBe("");
    expect(safeBaseName("::||??")).toBe("");
    expect(safeBaseName("...")).toBe("");
  });
});

describe("splitRelPath", () => {
  it("splits dir, base, and extension", () => {
    expect(splitRelPath("a/b/Note.md")).toEqual({ dir: "a/b/", base: "Note", ext: "md" });
    expect(splitRelPath("Note.md")).toEqual({ dir: "", base: "Note", ext: "md" });
    expect(splitRelPath("a/Folder")).toEqual({ dir: "a/", base: "Folder", ext: "" });
  });
  it("treats a leading dot as part of the base", () => {
    expect(splitRelPath(".gitignore")).toEqual({ dir: "", base: ".gitignore", ext: "" });
  });
  it("keeps only the last extension", () => {
    expect(splitRelPath("archive.tar.gz")).toEqual({ dir: "", base: "archive.tar", ext: "gz" });
  });
});

describe("uniqueRelPath", () => {
  it("returns the desired path when free", () => {
    expect(uniqueRelPath(["a.md"], "b.md")).toBe("b.md");
  });
  it("appends an incrementing suffix on collision", () => {
    expect(uniqueRelPath(["Untitled.md"], "Untitled.md")).toBe("Untitled 1.md");
    expect(uniqueRelPath(["Untitled.md", "Untitled 1.md"], "Untitled.md")).toBe("Untitled 2.md");
  });
  it("is case-insensitive", () => {
    expect(uniqueRelPath(["note.md"], "Note.md")).toBe("Note 1.md");
  });
  it("preserves the folder and extension", () => {
    expect(uniqueRelPath(["docs/x.png"], "docs/x.png")).toBe("docs/x 1.png");
  });
  it("works on extensionless folders", () => {
    expect(uniqueRelPath(["a/F"], "a/F")).toBe("a/F 1");
  });
});

describe("duplicateRelPath", () => {
  it("adds a ' copy' suffix before the extension", () => {
    expect(duplicateRelPath(["Note.md"], "Note.md")).toBe("Note copy.md");
  });
  it("increments when a copy already exists", () => {
    expect(duplicateRelPath(["Note.md", "Note copy.md"], "Note.md")).toBe("Note copy 1.md");
  });
  it("keeps the source folder", () => {
    expect(duplicateRelPath(["a/b/Pic.png"], "a/b/Pic.png")).toBe("a/b/Pic copy.png");
  });
});

describe("childRelPath", () => {
  it("creates a path inside the folder", () => {
    expect(childRelPath([], "Projects", "Untitled", "md")).toBe("Projects/Untitled.md");
  });
  it("dedupes against existing children", () => {
    expect(childRelPath(["Projects/Untitled.md"], "Projects", "Untitled", "md")).toBe(
      "Projects/Untitled 1.md"
    );
  });
  it("supports the vault root and extensionless (folder) names", () => {
    expect(childRelPath([], "", "Untitled", "md")).toBe("Untitled.md");
    expect(childRelPath(["New folder"], "", "New folder")).toBe("New folder 1");
  });
});

describe("ancestorFolders", () => {
  it("lists containing folders outermost first", () => {
    expect(ancestorFolders("a/b/c.md")).toEqual(["a", "a/b"]);
  });
  it("is empty for a root-level entry", () => {
    expect(ancestorFolders("Note.md")).toEqual([]);
  });
  it("treats a folder path's own segments as ancestors of its children", () => {
    expect(ancestorFolders("Projects/Sub")).toEqual(["Projects"]);
  });
});
