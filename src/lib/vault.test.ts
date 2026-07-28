import { describe, expect, it } from "vitest";
import demoPdfSource from "../../public/mesa-pdf-tour.pdf?raw";
import {
  DEMO_ROOT,
  canonicalRoot,
  decodePeekBytes,
  flushableNoteText,
  isTextualVaultFile,
  normalizeVaultRelPath,
  readNote,
  scanVault,
  urlForPath,
  writeNote,
} from "./vault";
import type { VaultFile } from "../types";

function demoFile(rel: string, ext: string, isMarkdown = false): VaultFile {
  return {
    path: `${DEMO_ROOT}/${rel}`,
    relPath: rel,
    name: rel.replace(/\.[^.]+$/, ""),
    ext,
    isMarkdown,
  };
}

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

describe("browser demo document fixtures", () => {
  it("includes a real local PDF that the browser regression workflow can open", async () => {
    const files = await scanVault(DEMO_ROOT);
    const pdf = files.find((file) => file.relPath === "Mesa PDF Tour.pdf");
    expect(pdf).toMatchObject({
      ext: "pdf",
      isMarkdown: false,
      path: `${DEMO_ROOT}/Mesa PDF Tour.pdf`,
    });

    expect(urlForPath(pdf!.path)).toBe("/mesa-pdf-tour.pdf");
    const bytes = new TextEncoder().encode(demoPdfSource);
    expect(new TextDecoder("latin1").decode(bytes.subarray(0, 5))).toBe("%PDF-");
    expect(new TextDecoder("latin1").decode(bytes.subarray(-16))).toContain("%%EOF");
  });

  it("keeps the existing demo image asset path unchanged", () => {
    expect(urlForPath(`${DEMO_ROOT}/assets/spark.svg`)).toMatch(
      /^data:image\/svg\+xml/
    );
  });
});

// Regression net for the "opening a PDF then losing window focus wiped the
// file" data loss: the crash-safety flush wrote `contentCache[active] ?? ""`
// for WHATEVER file was active, on window blur/hide/quit. A PDF (or any other
// binary) is never read as text, so its cache entry is always undefined — the
// flush therefore replaced the real document with zero bytes, with no edit,
// no Save, and no agent involved. Two gates keep that impossible.
describe("isTextualVaultFile", () => {
  it("accepts the files Mesa edits as text", () => {
    expect(isTextualVaultFile(demoFile("Note.md", "md", true))).toBe(true);
    expect(isTextualVaultFile(demoFile("notes.txt", "txt"))).toBe(true);
    expect(isTextualVaultFile(demoFile("data.json", "json"))).toBe(true);
    expect(isTextualVaultFile(demoFile("page.html", "html"))).toBe(true);
    expect(isTextualVaultFile(demoFile("icon.svg", "svg"))).toBe(true);
    // rtf renders in its own viewer but is still read/written as text.
    expect(isTextualVaultFile(demoFile("letter.rtf", "rtf"))).toBe(true);
    expect(isTextualVaultFile(demoFile("letter.RTF", "RTF"))).toBe(true);
  });

  it("rejects binary files, which have no text representation", () => {
    expect(isTextualVaultFile(demoFile("Report.pdf", "pdf"))).toBe(false);
    expect(isTextualVaultFile(demoFile("Scan.PDF", "PDF"))).toBe(false);
    expect(isTextualVaultFile(demoFile("photo.png", "png"))).toBe(false);
    expect(isTextualVaultFile(demoFile("clip.mp4", "mp4"))).toBe(false);
    expect(isTextualVaultFile(demoFile("archive.zip", "zip"))).toBe(false);
    expect(isTextualVaultFile(demoFile("book.epub", "epub"))).toBe(false);
    expect(isTextualVaultFile(demoFile("noext", ""))).toBe(false);
  });
});

describe("flushableNoteText", () => {
  it("flushes the cached text of a note, including a deliberately emptied one", () => {
    const note = demoFile("Note.md", "md", true);
    expect(flushableNoteText(note, "# Hello")).toBe("# Hello");
    // The user selected all and deleted: an empty CACHED string is a real edit.
    expect(flushableNoteText(note, "")).toBe("");
  });

  it("never flushes a note whose content has not been loaded yet", () => {
    // A blur while the opening disk read is still in flight must not write an
    // empty document over the real note.
    expect(flushableNoteText(demoFile("Note.md", "md", true), undefined)).toBeNull();
  });

  it("never flushes a binary file, cached or not", () => {
    const pdf = demoFile("Report.pdf", "pdf");
    expect(flushableNoteText(pdf, undefined)).toBeNull();
    // Even if something poisoned the text cache for it (e.g. a lossy UTF-8
    // decode of the PDF's bytes), the flush must still refuse.
    expect(flushableNoteText(pdf, "%PDF-1.7 �� garbage")).toBeNull();
    expect(flushableNoteText(demoFile("photo.png", "png"), "")).toBeNull();
  });
});

describe("writeNote fails closed on non-text files", () => {
  it("refuses to write text over a PDF and leaves it untouched", async () => {
    // The demo vault is an in-memory filesystem, so this exercises the real
    // writeNote path without touching disk.
    const pdf = demoFile("Guard.pdf", "pdf");
    await expect(writeNote(pdf, "")).rejects.toThrow(/only edits text files/i);
    await expect(writeNote(pdf, "anything")).rejects.toThrow(/Guard\.pdf/);
    expect(await readNote(pdf)).toBe("");
  });

  it("still writes text files normally", async () => {
    const note = demoFile("Guard.md", "md", true);
    await writeNote(note, "# written");
    expect(await readNote(note)).toBe("# written");
  });
});
