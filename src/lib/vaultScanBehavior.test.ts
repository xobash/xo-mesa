import { describe, expect, it } from "vitest";
import { isIndexableVaultRelPath, hasVaultMetadata } from "./vault";
import type { VaultFile } from "../types";

const file = (relPath: string, extra: Partial<VaultFile> = {}): VaultFile =>
  ({ relPath, path: `/v/${relPath}`, name: relPath, ext: "md", isMarkdown: true, ...extra }) as VaultFile;

describe("vault path indexing", () => {
  it("isIndexableVaultRelPath agrees with the walk rules it mirrors", () => {
    expect(isIndexableVaultRelPath("notes/a.md")).toBe(true);
    expect(isIndexableVaultRelPath(".git/index")).toBe(false);
    expect(isIndexableVaultRelPath("notes/.hidden.md")).toBe(false);
    expect(isIndexableVaultRelPath("node_modules/pkg/i.js")).toBe(false);
    expect(isIndexableVaultRelPath("a/node_modules/i.js")).toBe(false);
    expect(isIndexableVaultRelPath("")).toBe(false);
  });
});

describe("hasVaultMetadata", () => {
  it("is true only when every file carries size", () => {
    expect(hasVaultMetadata([file("a.md", { size: 1 }), file("b.md", { size: 0 })])).toBe(true);
    expect(hasVaultMetadata([file("a.md", { size: 1 }), file("b.md")])).toBe(false);
  });

  it("is false for an empty listing, so the fallback still hydrates", () => {
    expect(hasVaultMetadata([])).toBe(false);
  });

  it("treats size 0 as present (empty files are real)", () => {
    expect(hasVaultMetadata([file("empty.md", { size: 0 })])).toBe(true);
  });
});
