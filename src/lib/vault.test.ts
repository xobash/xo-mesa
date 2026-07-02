import { describe, expect, it } from "vitest";
import { canonicalRoot, decodePeekBytes, normalizeVaultRelPath } from "./vault";

describe("normalizeVaultRelPath", () => {
  it("keeps direct vault-relative paths", () => {
    expect(normalizeVaultRelPath("Notes/idea.md", "/vault")).toBe("Notes/idea.md");
  });

  it("strips the vault root from absolute paths", () => {
    expect(normalizeVaultRelPath("/vault/Notes/idea.md", "/vault")).toBe(
      "Notes/idea.md"
    );
  });

  it("accepts file URLs and dot-prefixed paths", () => {
    expect(normalizeVaultRelPath("file:///vault/Notes/idea.md", "/vault")).toBe(
      "Notes/idea.md"
    );
    expect(normalizeVaultRelPath("./Notes/idea.md", "/vault")).toBe(
      "Notes/idea.md"
    );
  });

  it("falls back to a known relPath suffix on absolute aliases", () => {
    expect(
      normalizeVaultRelPath(
        "/private/var/folders/x/alias/vault/Notes/idea.md",
        "/vault",
        ["Notes/idea.md"]
      )
    ).toBe("Notes/idea.md");
  });

  it("returns empty when it cannot safely map a path", () => {
    expect(normalizeVaultRelPath("/elsewhere/Notes/idea.md", "/vault")).toBe("");
  });

  it("does not treat a sibling folder with a shared prefix as inside the vault", () => {
    expect(normalizeVaultRelPath("/vault2/Notes/idea.md", "/vault")).toBe("");
    expect(normalizeVaultRelPath("C:/Vault Backup/idea.md", "C:/Vault")).toBe("");
  });

  it("maps Windows backslash paths against a forward-slash root", () => {
    expect(
      normalizeVaultRelPath("C:\\Users\\Xo\\Vault\\Notes\\idea.md", "C:/Users/Xo/Vault")
    ).toBe("Notes/idea.md");
  });

  it("matches Windows paths case-insensitively while keeping the reported casing", () => {
    expect(
      normalizeVaultRelPath("c:\\users\\xo\\vault\\Notes\\Idea.md", "C:/Users/Xo/Vault")
    ).toBe("Notes/Idea.md");
  });

  it("accepts Windows drive-letter file URLs", () => {
    expect(
      normalizeVaultRelPath("file:///C:/Users/Xo/Vault/Notes/idea.md", "C:/Users/Xo/Vault")
    ).toBe("Notes/idea.md");
  });

  it("accepts Windows UNC file URLs", () => {
    expect(
      normalizeVaultRelPath("file://server/share/Vault/Notes/idea.md", "//server/share/Vault")
    ).toBe("Notes/idea.md");
  });

  it("falls back to known relPaths case-insensitively for absolute aliases", () => {
    expect(
      normalizeVaultRelPath("D:\\Mirror\\vault\\notes\\idea.md", "C:/Vault", [
        "Notes/idea.md",
      ])
    ).toBe("Notes/idea.md");
  });
});

describe("canonicalRoot", () => {
  it("normalizes slashes and trailing separators", () => {
    expect(canonicalRoot("C:\\Users\\Xo\\Vault\\")).toBe("C:/Users/Xo/Vault");
  });

  it("uppercases Windows drive letters so one folder has one spelling", () => {
    expect(canonicalRoot("c:/Users/Xo/Vault")).toBe("C:/Users/Xo/Vault");
    expect(canonicalRoot("c:\\Users\\Xo\\Vault")).toBe("C:/Users/Xo/Vault");
  });

  it("leaves POSIX paths untouched", () => {
    expect(canonicalRoot("/Users/xo/vault")).toBe("/Users/xo/vault");
    expect(canonicalRoot("mesa://demo")).toBe("mesa://demo");
  });
});

describe("decodePeekBytes", () => {
  it("decodes plain UTF-8", () => {
    const bytes = new TextEncoder().encode("# Hello\nworld");
    expect(decodePeekBytes(bytes)).toBe("# Hello\nworld");
  });

  it("drops a trailing partial multi-byte character at the cap boundary", () => {
    // "é" is 2 bytes (0xC3 0xA9); cut the peek mid-character.
    const full = new TextEncoder().encode("café");
    const cut = full.subarray(0, full.length - 1);
    expect(decodePeekBytes(cut)).toBe("caf");
  });

  it("drops a truncated 4-byte emoji but keeps earlier ones intact", () => {
    const full = new TextEncoder().encode("ok \u{1F600}\u{1F600}");
    const cut = full.subarray(0, full.length - 2); // mid-emoji
    expect(decodePeekBytes(cut)).toBe("ok \u{1F600}");
  });

  it("keeps legitimate replacement chars that are not at the end", () => {
    const bytes = new Uint8Array([0xff, 0x61, 0x62]); // bad byte, then "ab"
    expect(decodePeekBytes(bytes)).toBe("�ab");
  });

  it("handles empty input", () => {
    expect(decodePeekBytes(new Uint8Array(0))).toBe("");
  });
});
