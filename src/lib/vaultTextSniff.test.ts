import { afterEach, describe, expect, it } from "vitest";
import {
  DEMO_ROOT,
  clearSniffedText,
  documentKind,
  flushableNoteText,
  isOpenableTextFile,
  isTextualVaultFile,
  looksLikeUtf8Text,
  moveSniffedText,
  needsCachedTextRefresh,
  needsTextSniff,
  readNote,
  rememberSniffedText,
  sniffVaultText,
  writeNote,
} from "./vault";
import { buildNotes } from "./graph";
import type { VaultFile } from "../types";

/**
 * UNKNOWN EXTENSIONS OPEN AS TEXT WHEN THEIR BYTES ARE TEXT.
 *
 * `.tex`, `.org`, `.lua`, `.gitignore` and files with no extension are only
 * sniffed when the user opens them: a bounded prefix that is valid UTF-8 with
 * no NUL byte makes the file readable and savable as text. The vault-scale
 * rule (index, graph, counts) never changes, so 4,000-file vaults pay nothing.
 */

const enc = (text: string) => new TextEncoder().encode(text);
function file(rel: string, ext: string): VaultFile {
  return { path: `${DEMO_ROOT}/${rel}`, relPath: rel, name: rel.replace(/\.[^.]+$/, ""), ext, isMarkdown: false };
}

afterEach(() => clearSniffedText());

describe("looksLikeUtf8Text", () => {
  it("accepts UTF-8 text, including an empty file and a BOM", () => {
    expect(looksLikeUtf8Text(enc("\\section{Intro}\n"), true)).toBe(true);
    expect(looksLikeUtf8Text(new Uint8Array(), true)).toBe(true);
    expect(looksLikeUtf8Text(enc("\uFEFF* Org heading\n"), true)).toBe(true);
  });

  it("rejects a NUL byte and invalid UTF-8", () => {
    expect(looksLikeUtf8Text(new Uint8Array([0x61, 0x00, 0x62]), true)).toBe(false);
    expect(looksLikeUtf8Text(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), true)).toBe(false); // Latin-1 "café"
    expect(looksLikeUtf8Text(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), true)).toBe(false); // zip header
  });

  it("allows a multi-byte character cut at the end of a partial prefix only", () => {
    const cut = enc("ab€").subarray(0, 4); // "€" is three bytes; keep one
    expect(looksLikeUtf8Text(cut, false)).toBe(true);
    expect(looksLikeUtf8Text(cut, true)).toBe(false);
  });
});

describe("open-time text rule", () => {
  it("routes an unknown extension to the binary view until it sniffs as text", () => {
    const tex = file("paper.tex", "tex");
    expect(needsTextSniff(tex)).toBe(true);
    expect(documentKind(tex)).toBe("other");
    expect(isOpenableTextFile(tex)).toBe(false);
    rememberSniffedText(tex.path);
    expect(needsTextSniff(tex)).toBe(false);
    expect(documentKind(tex)).toBe("text");
    expect(isOpenableTextFile(tex)).toBe(true);
    expect(flushableNoteText(tex, "body")).toBe("body");
    expect(needsCachedTextRefresh(tex, "body")).toBe(true); // watcher refreshes it
  });

  it("never sniffs known kinds", () => {
    expect(needsTextSniff(file("a.json", "json"))).toBe(false);
    expect(needsTextSniff(file("a.png", "png"))).toBe(false);
    expect(needsTextSniff(file("a.pdf", "pdf"))).toBe(false);
  });

  it("does not change vault-scale eligibility (index and graph)", () => {
    const org = file("plan.org", "org");
    rememberSniffedText(org.path);
    expect(isTextualVaultFile(org)).toBe(false);
    expect(buildNotes([org], new Map([[org.relPath, "* plan"]]))).toEqual({});
  });

  it("follows a rename", () => {
    rememberSniffedText(`${DEMO_ROOT}/old.lua`);
    moveSniffedText(`${DEMO_ROOT}/old.lua`, `${DEMO_ROOT}/new.lua`);
    expect(isOpenableTextFile(file("old.lua", "lua"))).toBe(false);
    expect(isOpenableTextFile(file("new.lua", "lua"))).toBe(true);
  });
});

describe("sniffed files through the write boundary", () => {
  it("saves a sniffed file and still refuses one that was never sniffed", async () => {
    const lua = file("init.lua", "lua");
    await expect(writeNote(lua, "print(1)\n")).rejects.toThrow(/only edits text files/i);
    expect(await sniffVaultText(lua)).toBe(true); // demo: an empty file is text
    rememberSniffedText(lua.path);
    await writeNote(lua, "print(1)\n");
    expect(await readNote(lua)).toBe("print(1)\n");
  });
});
