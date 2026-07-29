import { describe, expect, it } from "vitest";
import demoPdfSource from "../../public/mesa-pdf-tour.pdf?raw";
import {
  DEMO_ROOT,
  canonicalRoot,
  decodePeekBytes,
  flushableNoteText,
  isIndexableVaultRelPath,
  isTextualVaultFile,
  needsCachedTextRefresh,
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

describe("isIndexableVaultRelPath", () => {
  it("rejects everything under a dot-directory, at any depth", () => {
    // The defect: the watcher checked only the BASENAME for a leading dot, so
    // `.git/index` read as an ordinary file named `index`. It was absent from
    // `files`, `registerExternalFile` refused it, and the fallback ran a full
    // scanVault — once per path, for every file a git operation touches.
    expect(isIndexableVaultRelPath(".git/index")).toBe(false);
    expect(isIndexableVaultRelPath(".git/refs/heads/main")).toBe(false);
    expect(isIndexableVaultRelPath(".git/objects/ab/1234")).toBe(false);
    expect(isIndexableVaultRelPath(".obsidian/workspace.json")).toBe(false);
    expect(isIndexableVaultRelPath("Notes/.hidden/file.md")).toBe(false);
  });

  it("rejects Mesa's own in-flight write artifacts", () => {
    // These fire on every verified save; treating one as a new vault file is
    // what the dot rule has always prevented.
    expect(isIndexableVaultRelPath(".Note.md.mesa-tmp")).toBe(false);
    expect(isIndexableVaultRelPath("Notes/.Note.md.mesa-tmp")).toBe(false);
  });

  it("rejects node_modules at any depth", () => {
    expect(isIndexableVaultRelPath("node_modules/pkg/index.js")).toBe(false);
    expect(isIndexableVaultRelPath("Projects/app/node_modules/pkg/x.js")).toBe(false);
  });

  it("accepts ordinary vault files, including dots inside a name", () => {
    expect(isIndexableVaultRelPath("Note.md")).toBe(true);
    expect(isIndexableVaultRelPath("Notes/Deep/Beta.txt")).toBe(true);
    expect(isIndexableVaultRelPath("My Notes v1.2 final.md")).toBe(true);
    expect(isIndexableVaultRelPath("data/rows.csv")).toBe(true);
    // A folder merely CONTAINING "node_modules" is a real folder.
    expect(isIndexableVaultRelPath("about node_modules/notes.md")).toBe(true);
  });

  it("rejects empty and malformed rel paths", () => {
    expect(isIndexableVaultRelPath("")).toBe(false);
    expect(isIndexableVaultRelPath("/")).toBe(false);
    expect(isIndexableVaultRelPath("Notes//Beta.md")).toBe(false);
  });

  it("agrees with what scanVault actually indexes", async () => {
    // The whole point is that these two cannot drift. The demo vault is a real
    // scanVault run, so every path it returns must be indexable.
    const scanned = await scanVault(DEMO_ROOT);
    expect(scanned.length).toBeGreaterThan(0);
    for (const f of scanned) {
      expect(isIndexableVaultRelPath(f.relPath), f.relPath).toBe(true);
    }
  });
});

describe("normalizeVaultRelPath: deferring the known-paths list", () => {
  // The watcher used to build an array of every relPath in the vault for every
  // single event path. The list is only ever consulted for an absolute path
  // that is not under the vault root, so it is now built only after the cheap
  // call fails. That is a pure optimization ONLY if the two forms agree.
  const root = "/Users/x/Vault";
  const known = [
    "Notes/Alpha.md",
    "Notes/Deep/Beta.txt",
    "data/rows.csv",
    "Top.md",
  ];

  const cases = [
    // under the root — must resolve without ever reading the list
    `${root}/Notes/Alpha.md`,
    `${root}/Top.md`,
    `${root}/Brand New File.md`,
    `${root}/Notes/Deep/Beta.txt`,
    root,
    // aliased/symlinked root — only the list can resolve these
    `/private${root}/Notes/Alpha.md`,
    `/private${root}/data/rows.csv`,
    `/elsewhere/Notes/Deep/Beta.txt`,
    // absolute and unresolvable
    "/somewhere/else/Unknown.md",
    "/",
    // relative forms
    "Notes/Alpha.md",
    "./Top.md",
    "",
    // URL + Windows spellings
    `file://${root}/Notes/Alpha.md`,
    "C:/Users/x/Vault/Top.md",
    "\\\\Users\\x\\Vault\\Top.md",
  ];

  it("agrees with always passing the list, on every path shape", () => {
    for (const p of cases) {
      const oneCall = normalizeVaultRelPath(p, root, known);
      const cheap = normalizeVaultRelPath(p, root);
      const deferred = cheap || normalizeVaultRelPath(p, root, known);
      expect(deferred, `mismatch for ${JSON.stringify(p)}`).toBe(oneCall);
    }
  });

  it("resolves a path under the root without consulting the list at all", () => {
    // Passing a deliberately wrong list must not change the answer for a path
    // the root prefix already explains — that is what makes deferring safe.
    expect(normalizeVaultRelPath(`${root}/Notes/Alpha.md`, root, [])).toBe(
      "Notes/Alpha.md"
    );
    expect(normalizeVaultRelPath(`${root}/Notes/Alpha.md`, root)).toBe(
      "Notes/Alpha.md"
    );
  });

  it("still needs the list for an aliased root", () => {
    // The case that must keep working: the cheap call cannot resolve it.
    expect(normalizeVaultRelPath(`/private${root}/Top.md`, root)).toBe("");
    expect(normalizeVaultRelPath(`/private${root}/Top.md`, root, known)).toBe(
      "Top.md"
    );
  });
});

describe("needsCachedTextRefresh", () => {
  it("refreshes every textual file Mesa is holding text for, not just markdown", () => {
    // The regression: vault open caches all textual files within the budget,
    // but the watcher refreshed `isMarkdown` only. An external edit to one of
    // these left the stale copy searchable, openable, and re-writable.
    for (const [name, ext] of [
      ["Prompt.txt", "txt"],
      ["build.py", "py"],
      ["data.json", "json"],
      ["page.html", "html"],
      ["rows.csv", "csv"],
      ["notes.rtf", "rtf"],
    ] as const) {
      expect(needsCachedTextRefresh(demoFile(name, ext), "cached")).toBe(true);
    }
    expect(needsCachedTextRefresh(demoFile("Note.md", "md", true), "cached")).toBe(
      true
    );
  });

  it("leaves an uncached file alone so the budget is not quietly bypassed", () => {
    // Nothing is stale when nothing is held, and `ensureContent`'s lazy read
    // already yields current text. Reading here would pull in exactly the files
    // `planTextCache` chose to skip.
    expect(needsCachedTextRefresh(demoFile("Prompt.txt", "txt"), undefined)).toBe(
      false
    );
    expect(needsCachedTextRefresh(demoFile("Note.md", "md", true), undefined)).toBe(
      false
    );
  });

  it("never re-reads a binary file as text", () => {
    // Same gate as the write side: a PDF/image decoded through the text
    // pipeline is corrupt, so it must not be pulled into the cache even if
    // something already poisoned that entry.
    expect(needsCachedTextRefresh(demoFile("Report.pdf", "pdf"), undefined)).toBe(
      false
    );
    expect(
      needsCachedTextRefresh(demoFile("Report.pdf", "pdf"), "%PDF-1.7 garbage")
    ).toBe(false);
    expect(needsCachedTextRefresh(demoFile("photo.png", "png"), "")).toBe(false);
  });

  it("treats a deliberately emptied cached file as cached", () => {
    // `""` is a real cached value (the file is empty on disk); only `undefined`
    // means "not held".
    expect(needsCachedTextRefresh(demoFile("Prompt.txt", "txt"), "")).toBe(true);
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
