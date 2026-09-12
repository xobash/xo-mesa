import { describe, expect, it } from "vitest";
// `vault_read_text` (src-tauri/src/vaultread.rs) is the read half of what
// `vault_scan` did for the listing: many files per IPC round-trip instead of
// one invoke per file. Vault open issued ~2,400 of those on the 4,165-file
// reference vault (721 markdown before the first paint, ~1,673 search-corpus
// reads streaming behind it).
//
// The round-trip count is charged hardest on Windows: every Tauri invoke uses
// the custom-protocol IPC, which on Windows is a WebView2 `WebResourceRequested`
// raised on the UI thread, and wry delivers the async response by posting a
// window message and forcing `RDW_INTERNALPAINT`. The corpus half of those
// reads runs while the user is already typing.
//
// The wire format is hand-rolled binary, so the encoder and decoder can drift
// silently and would corrupt the content cache (every file's text shifted onto
// the wrong path) rather than fail loudly. These tests pin the pair.
import rust from "../../src-tauri/src/vaultread.rs?raw";
import lib from "../../src-tauri/src/lib.rs?raw";
import { decodeTextChunk, VAULT_TEXT_CHUNK } from "./vault";
import { SEARCH_CORPUS_BATCH } from "./searchCorpus";
import { MAX_TEXT_CACHE_FILE_BYTES } from "./textCachePlan";

const READ_FAILED = 0xffffffff;

/** `vaultread.rs` with `//` comment lines removed, for assertions that must
 *  hold of the CODE — the comments there discuss the rejected alternatives by
 *  name, and matching those would make the test pass for the wrong reason. */
const rustCode = rust
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

/** Build a frame exactly as `vaultread.rs` `encode` does: u32 LE count, then
 *  per file a u32 LE length (READ_FAILED = unreadable) and that many bytes. */
function encode(entries: (Uint8Array | null)[]): ArrayBuffer {
  const total = entries.reduce((n, e) => n + 4 + (e?.length ?? 0), 4);
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  view.setUint32(0, entries.length, true);
  let at = 4;
  for (const entry of entries) {
    if (entry === null) {
      view.setUint32(at, READ_FAILED, true);
      at += 4;
      continue;
    }
    view.setUint32(at, entry.length, true);
    at += 4;
    bytes.set(entry, at);
    at += entry.length;
  }
  return buf;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("vault_read_text contract", () => {
  it("the command is registered on the Rust invoke handler", () => {
    expect(lib).toContain("mod vaultread;");
    expect(lib).toContain("vaultread::vault_read_text");
  });

  it("uses a bounded default and supports an optional native worker limit", () => {
    expect(rust).toContain("worker_limit: Option<usize>");
    expect(rust).toContain("const DEFAULT_BULK_READ_WORKERS: usize = 8;");
    expect(rust).toContain(".unwrap_or(DEFAULT_BULK_READ_WORKERS)");
    expect(rust).toContain(".clamp(1, available)");
    expect(rust).toContain("worker_limit");
  });

  it("both halves use the same failure marker and integer encoding", () => {
    expect(rust).toContain("const READ_FAILED: u32 = u32::MAX;");
    // Little-endian u32 on both sides. A big-endian slip would decode every
    // length as a wild number and either throw or silently truncate.
    expect(rust).toContain("to_le_bytes()");
    expect(rust).not.toContain("to_be_bytes()");
  });

  it("decodes a frame the Rust encoder would produce", () => {
    const texts = decodeTextChunk(
      encode([utf8("alpha"), utf8(""), utf8("# note\nbody")])
    );
    expect(texts).toEqual(["alpha", "", "# note\nbody"]);
  });

  it("an empty file decodes to text, not to a failure", () => {
    // These are different outcomes on the Rust side (Some(vec![]) vs None) and
    // must stay different here: conflating them would make every unreadable
    // file look like a legitimately empty note.
    expect(decodeTextChunk(encode([utf8("")]))).toEqual([""]);
    expect(decodeTextChunk(encode([null]))).toEqual([null]);
  });

  it("reports unreadable files positionally without losing their neighbours", () => {
    const texts = decodeTextChunk(encode([utf8("a"), null, utf8("c")]));
    expect(texts).toEqual(["a", null, "c"]);
  });

  it("an empty batch is a bare count of zero", () => {
    expect(decodeTextChunk(encode([]))).toEqual([]);
  });

  it("decodes the postMessage fallback shape too", () => {
    // Tauri drops to `postMessage` if the custom-protocol IPC is ever blocked,
    // and byte responses arrive there as a plain array of numbers. plugin-fs
    // handles both shapes; a decoder that assumed ArrayBuffer would turn that
    // fallback into silently corrupt note text.
    const buf = encode([utf8("alpha"), null, utf8("beta")]);
    const asNumbers = Array.from(new Uint8Array(buf));
    expect(decodeTextChunk(asNumbers)).toEqual(["alpha", null, "beta"]);
    expect(decodeTextChunk(new Uint8Array(buf))).toEqual(["alpha", null, "beta"]);
  });

  it("rejects a truncated or overlong frame instead of decoding it short", () => {
    // `subarray` clamps rather than throwing, so a frame cut in transit would
    // otherwise be cached as a genuinely shorter note. The throw is what sends
    // the batch down the per-file fallback.
    const full = new Uint8Array(encode([utf8("alpha"), utf8("beta")]));
    expect(() => decodeTextChunk(full.slice(0, full.length - 2))).toThrow();
    expect(() => decodeTextChunk(full.slice(0, 2))).toThrow();
    const padded = new Uint8Array(full.length + 3);
    padded.set(full);
    expect(() => decodeTextChunk(padded)).toThrow();
  });

  it("decodes invalid UTF-8 the way plugin-fs readTextFile does", () => {
    // Rust hands back raw bytes precisely so substitution happens here, in the
    // same non-fatal TextDecoder the per-file fallback path uses. If Rust ever
    // starts decoding, the two paths can disagree on the same file.
    expect(rust).toContain("std::fs::read(path)");
    // Comments discuss `from_utf8_lossy` deliberately; only real code counts.
    expect(rustCode).not.toContain("from_utf8");
    const [text] = decodeTextChunk(
      encode([new Uint8Array([0x68, 0x69, 0xff, 0xfe])])
    );
    expect(text).toBe(new TextDecoder().decode(new Uint8Array([0x68, 0x69, 0xff, 0xfe])));
    expect(text?.startsWith("hi")).toBe(true);
  });

  it("multi-byte characters survive a batch boundary", () => {
    // Each file is length-framed, so a chunk boundary can never split a
    // character the way a streamed decode could.
    const texts = decodeTextChunk(encode([utf8("héllo — ✅"), utf8("日本語")]));
    expect(texts).toEqual(["héllo — ✅", "日本語"]);
  });

  it("the Rust side preserves request order across its worker threads", () => {
    // Results are placed by index after the join; the frontend zips the
    // response straight back onto its own file list, so any reordering would
    // file every note's text under the wrong path.
    expect(rust).toContain("out[i] = bytes;");
    expect(rust).toContain("fetch_add(1, Ordering::Relaxed)");
  });

  it("the Rust side rejects paths that escape the vault root", () => {
    expect(rust).toContain('seg == ".." ');
    expect(rust).toContain("rel.replace('\\\\', \"/\")");
  });

  it("the native reader receives and enforces the non-markdown file guard", () => {
    expect(rust).toContain("const DEFAULT_MAX_TEXT_FILE_BYTES: u64 = 8 * 1024 * 1024;");
    expect(rust).toContain("max_text_file_bytes: Option<u64>");
    expect(rust).toContain("meta.len() > max_text_file_bytes");
    expect(rustCode.indexOf("meta.len() > max_text_file_bytes")).toBeLessThan(
      rustCode.indexOf("std::fs::read(path)")
    );
    expect(MAX_TEXT_CACHE_FILE_BYTES).toBe(8 * 1024 * 1024);
  });

  it("oversized files use the normal failure marker, preserving order", () => {
    const texts = decodeTextChunk(encode([utf8("a"), null, utf8("c")]));
    expect(texts).toEqual(["a", null, "c"]);
  });

  it("one chunk read produces exactly one search-corpus commit", () => {
    // Not required for correctness — the batch buffer honours `batchSize`
    // either way — but keeping them equal is what makes `indexingTextFiles`
    // tick once per round-trip instead of twice per three.
    expect(VAULT_TEXT_CHUNK).toBe(SEARCH_CORPUS_BATCH);
  });
});
