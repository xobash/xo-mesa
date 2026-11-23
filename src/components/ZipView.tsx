import { useEffect, useMemo, useRef, useState } from "react";
import type { VaultFile } from "../types";
import { formatBytes } from "../lib/formatBytes";
import { localISO, localTime } from "../lib/daily";
import { detectFileType } from "../lib/fileSniff";
import { ByteSource, memoryRangeReader } from "../lib/byteSource";
import { ByteWindowCache } from "../lib/hexView";
import { readVaultRange } from "../lib/vaultByteRead";
import { listZipArchive, readZipEntry, type ZipListing, type ZipViewEntry } from "../lib/zipView";
import { visibleCodeLineRange } from "../lib/codeWindow";
import { odfEncryptionReason } from "../lib/odfEncryption";
import { HexView } from "./HexView";
import { useScrollViewport } from "./useScrollViewport";

const ROW_HEIGHT = 26;

type Preview =
  | { entry: ZipViewEntry; text: string }
  | { entry: ZipViewEntry; cache: ByteWindowCache; type: string }
  | { entry: ZipViewEntry; error: string };

async function previewFor(source: ByteSource, entry: ZipViewEntry): Promise<Preview> {
  try {
    const bytes = await readZipEntry(source, entry);
    const detected = detectFileType(bytes);
    if (detected.family === "text" && detected.id !== "utf16") {
      return { entry, text: new TextDecoder("utf-8").decode(bytes) };
    }
    // Previews are at most one window (1 MiB), so the cache holds it whole.
    const cache = new ByteWindowCache(memoryRangeReader(bytes), { bytes, size: bytes.length, stamp: "memory" });
    return { entry, cache, type: detected.name };
  } catch (reason) {
    return { entry, error: reason instanceof Error ? reason.message : String(reason) };
  }
}

function dateText(date: Date | null): string {
  return date ? `${localISO(date)} ${localTime(date)}` : "—";
}

/** Read-only archive contents from the central directory, read by range so
 *  archive size is not limited. Entries are previewed in memory, one at a
 *  time; nothing is extracted to disk. */
export function ZipView({ file }: { file: VaultFile }) {
  const [state, setState] = useState<{ source: ByteSource; listing: ZipListing; encryptedOdf: string | null } | { error: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingPreview = useRef<object | null>(null);

  useEffect(() => {
    let alive = true;
    setState(null);
    setPreview(null);
    pendingPreview.current = null;
    ByteSource.open((offset, len) => readVaultRange(file, offset, len))
      .then(async (source) => {
        const listing = await listZipArchive(source);
        return { source, listing, encryptedOdf: await odfEncryptionReason(file.ext, source, listing) };
      })
      .then(
        (next) => { if (alive) setState(next); },
        (reason: unknown) => { if (alive) setState({ error: reason instanceof Error ? reason.message : String(reason) }); }
      );
    return () => { alive = false; };
  }, [file]);

  const viewport = useScrollViewport(scrollRef, state);
  const entries = useMemo(() => (state && "listing" in state ? state.listing.entries : []), [state]);
  const range = visibleCodeLineRange(entries.length, viewport.scrollTop, viewport.height, ROW_HEIGHT);
  const unsafeCount = useMemo(() => entries.filter((e) => e.unsafe).length, [entries]);

  if (!state) return <div className="editor-empty">Reading archive contents…</div>;
  if ("error" in state) {
    return <div className="file-fallback-error" role="alert">Cannot list this archive: {state.error}</div>;
  }
  const { listing, source } = state;
  const open = (entry: ZipViewEntry) => {
    const opening = { entry };
    pendingPreview.current = opening;
    void previewFor(source, entry).then((next) => { if (pendingPreview.current === opening) setPreview(next); });
  };
  const rows = [];
  for (let i = range.start; i < range.end; i++) {
    const entry = entries[i];
    rows.push(
      <div key={entry.index} role="row" className={"zip-row" + (preview?.entry.index === entry.index ? " is-selected" : "")}
        style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT }}>
        <span role="cell" className="zip-name">
          <button type="button" className="zip-open" disabled={entry.directory}
            onClick={() => open(entry)} title={entry.name}>
            {entry.name}
          </button>
          {entry.unsafe && <span className="zip-badge" title="Mesa never extracts this entry">Unsafe: {entry.unsafe}</span>}
          {entry.encrypted && <span className="zip-badge">Encrypted</span>}
        </span>
        <span role="cell" className="zip-num">{entry.directory ? "—" : formatBytes(entry.size)}</span>
        <span role="cell" className="zip-num">{entry.directory ? "—" : formatBytes(entry.compressedSize)}</span>
        <span role="cell" className="zip-date">{dateText(entry.modified)}</span>
      </div>
    );
  }
  return (
    <div className="zip-view">
      <div className="code-bar">
        <span className="code-lang">Contents</span>
        <span className="code-meta">
          {listing.declaredEntries.toLocaleString()} entries · {formatBytes(listing.totalSize)} uncompressed · read-only
        </span>
        {state.encryptedOdf && <span className="code-meta zip-warning" role="note">{state.encryptedOdf}</span>}
        {listing.truncated && (
          <span className="code-meta" role="note">Listing the first {listing.entries.length.toLocaleString()} entries.</span>
        )}
        {unsafeCount > 0 && (
          <span className="code-meta zip-warning" role="note">
            {unsafeCount} {unsafeCount === 1 ? "entry has" : "entries have"} an unsafe name. Mesa shows them but never extracts them.
          </span>
        )}
      </div>
      <div className="zip-header" role="row">
        <span role="columnheader">Path</span>
        <span role="columnheader">Size</span>
        <span role="columnheader">Compressed</span>
        <span role="columnheader">Modified</span>
      </div>
      <div className="zip-scroll" ref={scrollRef} role="table" aria-label="Archive contents">
        <div className="zip-spacer" style={{ height: entries.length * ROW_HEIGHT }}>{rows}</div>
      </div>
      {preview && (
        <div className="zip-preview" aria-label={`Preview of ${preview.entry.name}`}>
          <div className="code-bar">
            <span className="code-lang">{preview.entry.name}</span>
            {"type" in preview && <span className="code-meta">{preview.type}</span>}
            <button type="button" className="btn" onClick={() => { pendingPreview.current = null; setPreview(null); }}>Close preview</button>
          </div>
          {"error" in preview ? (
            <div className="file-fallback-error" role="alert">{preview.error}</div>
          ) : "text" in preview ? (
            <pre className="zip-text">{preview.text}</pre>
          ) : (
            <HexView cache={preview.cache} />
          )}
        </div>
      )}
    </div>
  );
}
