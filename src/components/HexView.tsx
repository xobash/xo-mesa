import { useEffect, useRef, useState } from "react";
import { HEX_ROW_BYTES, HEX_ROW_HEIGHT, formatHexRow, hexWindow, type ByteWindowCache } from "../lib/hexView";
import { useScrollViewport } from "./useScrollViewport";

/** Quiet time after the last scroll before missing bytes are read, so a
 *  scrollbar drag across a multi-GB file asks for one window, not hundreds. */
export const HEX_SETTLE_MS = 120;

/**
 * Read-only, windowed hex view (offset / hex / ASCII) over a file of any
 * size. Only the rows on screen are rendered; bytes are read one 1 MiB window
 * per scroll settle and at most 8 MiB stay cached.
 */
export function HexView({ cache, onFileChanged }: { cache: ByteWindowCache; onFileChanged?: () => void }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const viewport = useScrollViewport(scrollRef, cache);
  const [, setLoaded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rowCount = Math.ceil(cache.size / HEX_ROW_BYTES);
  const win = hexWindow(rowCount, viewport.scrollTop, viewport.height);
  const start = win.start * HEX_ROW_BYTES;
  const end = win.end * HEX_ROW_BYTES;
  const missing = !cache.has(start, end);

  useEffect(() => {
    if (!missing) return;
    let alive = true;
    const timer = setTimeout(() => {
      cache.ensure(start, end).then(
        () => {
          if (!alive) return;
          setError(null);
          setLoaded((n) => n + 1);
          if (cache.changed) onFileChanged?.();
        },
        (reason: unknown) => { if (alive) setError(`Could not read this part of the file: ${reason instanceof Error ? reason.message : String(reason)}`); }
      );
    }, HEX_SETTLE_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [cache, start, end, missing, onFileChanged]);

  const rows = [];
  for (let row = win.start; row < win.end; row++) {
    const offset = row * HEX_ROW_BYTES;
    const bytes = cache.slice(offset, offset + HEX_ROW_BYTES);
    const formatted = bytes.length > 0 ? formatHexRow(offset, bytes) : { offset: offset.toString(16).padStart(8, "0"), hex: "…", ascii: "" };
    rows.push(
      <div key={row} className="hex-row" style={{ height: HEX_ROW_HEIGHT }} data-offset={offset}>
        <span className="hex-offset">{formatted.offset}</span>
        <span className="hex-bytes">{formatted.hex}</span>
        <span className="hex-ascii">{formatted.ascii}</span>
      </div>
    );
  }
  return (
    <div className="hex-view">
      <div className="code-bar">
        <span className="code-lang">Bytes</span>
        <span className="code-meta">Read-only · Mesa reads only the part you scroll to</span>
        {cache.changed && (
          <span className="code-meta" role="status">
            This file changed on disk. Mesa cleared the bytes it had read and now shows the current version.
          </span>
        )}
      </div>
      {error && <div className="file-fallback-error" role="alert">{error}</div>}
      {rowCount === 0 ? (
        <div className="editor-empty">This file is empty.</div>
      ) : (
        <div className="hex-scroll" ref={scrollRef} tabIndex={0} aria-label="File bytes">
          <div className="hex-spacer" style={{ height: win.spacerHeight }}>
            <div className="hex-rows" style={{ transform: `translateY(${win.top}px)` }}>{rows}</div>
          </div>
        </div>
      )}
    </div>
  );
}
