import { describe, expect, it } from "vitest";
import { relBase, relDir, toVaultFile } from "./vaultPaths";

describe("toVaultFile", () => {
  // The watcher, external registration, native scan and demo vault all build
  // catalogue entries here, so a watched file matches its rescan entry.
  it.each([
    ["/v", "Note.md", { path: "/v/Note.md", name: "Note", ext: "md", isMarkdown: true }],
    ["/v/", "a/b/Deep.MARKDOWN", { path: "/v/a/b/Deep.MARKDOWN", name: "Deep", ext: "markdown", isMarkdown: true }],
    ["D:/", "img/x.PNG", { path: "D:/img/x.PNG", name: "x", ext: "png", isMarkdown: false }],
    ["/v", "dir/no-ext", { path: "/v/dir/no-ext", name: "no-ext", ext: "", isMarkdown: false }],
  ])("%s + %s", (root, rel, expected) => {
    expect(toVaultFile(root, rel)).toEqual({ relPath: rel, ...expected });
  });

  it("takes the name from the last segment even when a folder name has a newline", () => {
    expect(toVaultFile("/v", "a\nb/c.md").name).toBe("c");
  });
});

describe("vault-relative segments", () => {
  it("splits on the last forward slash only", () => {
    expect(relDir("a/b/c.md")).toBe("a/b");
    expect(relDir("c.md")).toBe("");
    expect(relBase("a/b/c.md")).toBe("c.md");
    expect(relBase("c.md")).toBe("c.md");
    expect(relBase("a/x\\y.md")).toBe("x\\y.md");
  });
});
