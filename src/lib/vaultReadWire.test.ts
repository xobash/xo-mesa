import { describe, expect, it } from "vitest";
import { decodeTextChunk, decodeTextChunkOutcomes } from "./vault";

const READ_FAILED = 0xffffffff;

/** Native frame: u32 LE count, then each byte length or failure marker. */
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

describe("vault text batch decoder", () => {
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

  it("distinguishes empty, oversized, and failed reads", () => {
    const frame = new Uint8Array(16);
    const view = new DataView(frame.buffer);
    view.setUint32(0, 3, true);
    view.setUint32(4, 0, true);
    view.setUint32(8, 0xfffffffe, true);
    view.setUint32(12, 0xffffffff, true);
    expect(decodeTextChunkOutcomes(frame)).toEqual([
      { kind: "content", text: "" }, { kind: "skipped" }, { kind: "failed" },
    ]);
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

  it("oversized files use the normal failure marker, preserving order", () => {
    const texts = decodeTextChunk(encode([utf8("a"), null, utf8("c")]));
    expect(texts).toEqual(["a", null, "c"]);
  });

});
