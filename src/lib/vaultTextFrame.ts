// Pure decoding of `vault_read_text` frames and byte-capped peeks.

/** Failure marker in the `vault_read_text` frame — see `vaultread.rs`. */
const TEXT_READ_FAILED = 0xffffffff;
const TEXT_READ_SKIPPED = 0xfffffffe;
/** Online-only cloud file (OneDrive Files On-Demand): background reads leave it
 *  in the cloud; opening the note downloads it through the ordinary read. */
const TEXT_READ_OFFLINE = 0xfffffffd;
export type TextReadOutcome =
  /** `sha256` hashes the raw file bytes (before BOM removal or replacement of
   *  invalid UTF-8), matching `vault_text_fingerprints`. Absent on reads that
   *  have no raw bytes. */
  | { kind: "content"; text: string; sha256?: string }
  | { kind: "skipped" }
  | { kind: "offline" }
  | { kind: "failed" };

/** Decode ordered little-endian count/length frames; reserved lengths distinguish skips and failures.
 * Use nonfatal UTF-8 decoding consistently with plugin reads and retain outcome distinctions. */
export function decodeTextChunkOutcomes(
  /** Whatever `invoke` handed back. The custom-protocol IPC yields an
   *  `ArrayBuffer`, but Tauri silently falls back to `postMessage` if that
   *  protocol is ever blocked, and there a byte array arrives as a plain array
   *  of numbers. `plugin-fs`'s own readers handle both; so must this one, or a
   *  fallback shell would decode garbage instead of degrading. */
  body: ArrayBuffer | Uint8Array | number[],
  /** Sees each content outcome's exact raw bytes; the view is valid only during the call. */
  onContentBytes?: (index: number, raw: Uint8Array) => void
): TextReadOutcome[] {
  const bytes =
    body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : body instanceof Uint8Array
        ? body
        : Uint8Array.from(body);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  // Every read is bounds-checked rather than trusted. `subarray` CLAMPS out of
  // range instead of throwing, so a frame that was truncated in transit would
  // otherwise decode as quietly-shortened note text and be cached as the real
  // file. Throwing sends the batch down the per-file fallback instead.
  const need = (at: number, n: number) => {
    if (at + n > bytes.byteLength) throw new Error("truncated vault_read_text frame");
  };
  need(0, 4);
  const count = view.getUint32(0, true);
  const out: TextReadOutcome[] = [];
  let at = 4;
  for (let i = 0; i < count; i++) {
    need(at, 4);
    const len = view.getUint32(at, true);
    at += 4;
    if (len === TEXT_READ_FAILED) {
      out.push({ kind: "failed" });
      continue;
    }
    if (len === TEXT_READ_SKIPPED) {
      out.push({ kind: "skipped" });
      continue;
    }
    if (len === TEXT_READ_OFFLINE) {
      out.push({ kind: "offline" });
      continue;
    }
    need(at, len);
    const raw = bytes.subarray(at, at + len);
    onContentBytes?.(out.length, raw);
    out.push({ kind: "content", text: decoder.decode(raw) });
    at += len;
  }
  if (at !== bytes.byteLength) throw new Error("trailing vault_read_text bytes");
  return out;
}

/** Decode a byte-capped peek to text, dropping any trailing partial UTF-8
 *  sequence (a cut multi-byte char decodes to U+FFFD at the very end). */
export function decodePeekBytes(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return text.replace(/�+$/, "");
}
