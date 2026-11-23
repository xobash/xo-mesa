import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { VaultFile } from "../types";
import { useAppStore } from "../store";
import { formatBytes } from "../lib/formatBytes";
import { localISO, localTime } from "../lib/daily";
import { detectFileType, isExtensionMismatch, type DetectedType } from "../lib/fileSniff";
import { ByteWindowCache } from "../lib/hexView";
import { readVaultRange } from "../lib/vaultByteRead";
import { legacyOfficeKind, officeFallbackReason } from "../lib/officeFallbackReason";
import { isSpreadsheetExt, isWordExt } from "../lib/vault";
import { isPresentationExt } from "../lib/officeFormats";
import { ByteSource, SOURCE_READ_MAX_BYTES } from "../lib/byteSource";
import { legacyEncryptionReason } from "../lib/legacyOfficeEncryption";
import { HexView } from "./HexView";

// Archive and book views pull in fflate and the HTML purifier; load on use.
const ZipView = lazy(() => import("./ZipView").then((m) => ({ default: m.ZipView })));
const EpubView = lazy(() => import("./EpubView").then((m) => ({ default: m.EpubView })));
// Legacy .doc/.xls/.ppt readers and the copy builder load only for those files.
const LegacyOfficeView = lazy(() => import("./LegacyOfficeView").then((m) => ({ default: m.LegacyOfficeView })));

/** First read: enough to detect the type and fill the first screens of bytes. */
export const FALLBACK_HEAD_BYTES = 64 * 1024;

type Mode = "office" | "book" | "contents" | "bytes";

function modesFor(detected: DetectedType, ext: string): Mode[] {
  if (detected.id === "cfb" && legacyOfficeKind(ext)) return ["office", "bytes"];
  if (detected.family === "epub") return ["book", "contents", "bytes"];
  if (detected.family === "zip") return ["contents", "bytes"];
  return ["bytes"];
}

const MODE_LABEL: Record<Mode, string> = { office: "Content", book: "Read book", contents: "Contents", bytes: "Bytes" };

/** Why a spreadsheet format has no viewer here, by extension, or `null` (legacy .xls: `officeFallbackReason`). */
function spreadsheetFormatNote(ext: string): string | null {
  if (/^xlsb$/i.test(ext)) {
    return "Mesa does not open binary (.xlsb) Excel workbooks: Mesa cannot write their binary format without risking damage. To view and edit it in Mesa, save a copy as .xlsx in Excel or LibreOffice.";
  }
  if (/^(fods|fodt|fodp)$/i.test(ext)) {
    return "This is a flat XML OpenDocument file. Mesa opens only packaged OpenDocument files; save a copy as .ods, .odt or .odp in LibreOffice to view and edit it in Mesa.";
  }
  return null;
}

function hintFor(detected: DetectedType, ext: string): string {
  if (detected.id === "cfb" && legacyOfficeKind(ext)) return "Read its content here or inspect its bytes. Everything is read-only.";
  if (detected.id === "cfb" && (isWordExt(ext) || isSpreadsheetExt(ext) || isPresentationExt(ext))) return "This Office file is password-protected. Enter its password to open and edit it; its bytes are shown here read-only.";
  if (detected.family === "epub") return "Read the book here, list its files or inspect its bytes. Everything is read-only.";
  if (detected.family === "zip") return "List the archive's files and preview text inside it, or inspect its bytes. Nothing is extracted.";
  if (detected.family === "empty") return "This file has no content.";
  if (detected.id === "cfb") return "This is a legacy or encrypted Microsoft Office file. Mesa shows its details and bytes, read-only. To edit it in Mesa, save it from Office as .docx, .xlsx or .pptx (a password is fine).";
  return "Mesa has no editor for this type. You can inspect its bytes here, read-only.";
}

/**
 * Safe view for any file without a dedicated viewer: details from the catalog
 * and magic bytes, then a read-only archive, book or hex view.
 */
export function FileFallbackView({ file, notice }: { file: VaultFile; notice?: string }) {
  const openDocWindow = useAppStore((s) => s.openDocWindow);
  // A detached document window has no vault in its store; a new window opened from it would be empty.
  const canOpenWindow = useAppStore((s) => !!s.vaultPath);
  const isActive = useAppStore((s) => s.activePath === file.relPath);
  const revealActiveFile = useAppStore((s) => s.revealActiveFile);
  const [head, setHead] = useState<{ cache: ByteWindowCache; detected: DetectedType } | { error: string } | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  // Re-renders the details when the hex view sees a new file version.
  const [, setVersion] = useState(0);
  const onFileChanged = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setHead(null);
    setMode(null);
    readVaultRange(file, 0, FALLBACK_HEAD_BYTES).then(
      (first) => {
        if (!alive) return;
        const cache = new ByteWindowCache((offset, len) => readVaultRange(file, offset, len), first);
        setHead({ cache, detected: detectFileType(first.bytes, file.ext) });
      },
      (reason: unknown) => { if (alive) setHead({ error: reason instanceof Error ? reason.message : String(reason) }); }
    );
    return () => { alive = false; };
  }, [file]);

  const detected = head && "detected" in head ? head.detected : null;
  const [encryption, setEncryption] = useState<string | null>(null);
  // Compound files: say when one is password-protected (read whole, bounded).
  useEffect(() => {
    setEncryption(null);
    if (detected?.id !== "cfb") return;
    let alive = true;
    ByteSource.open((offset, len) => readVaultRange(file, offset, len))
      .then((source) => (source.size <= SOURCE_READ_MAX_BYTES ? source.read(0, source.size) : null))
      .then((bytes) => { if (alive && bytes) setEncryption(legacyEncryptionReason(bytes, file.ext)); }, () => undefined);
    return () => { alive = false; };
  }, [detected, file]);
  const modes = useMemo(() => (detected ? modesFor(detected, file.ext) : []), [detected, file.ext]);
  const current = mode && modes.includes(mode) ? mode : modes[0] ?? null;
  const size = head && "cache" in head ? head.cache.size : file.size;
  const mismatch = detected && isExtensionMismatch(detected, file.ext);
  const fullName = file.ext ? `${file.name}.${file.ext}` : file.name;

  return (
    <div className="file-fallback">
      <section className="file-details" aria-label="File details">
        <div className="file-details-title">{fullName}</div>
        <dl className="file-details-list">
          <dt>Type</dt>
          <dd>{detected ? detected.name : head && "error" in head ? "Unknown (could not read the file)" : "Detecting…"}</dd>
          <dt>Size</dt>
          <dd>{size === undefined ? "Unknown" : `${formatBytes(size)} (${size.toLocaleString()} bytes)`}</dd>
          <dt>Modified</dt>
          <dd>{file.mtime ? `${localISO(new Date(file.mtime))} ${localTime(new Date(file.mtime))}` : "Unknown"}</dd>
          <dt>Location</dt>
          <dd className="file-details-path">{file.relPath}</dd>
        </dl>
        {notice && <p className="file-details-warning" role="note">Mesa cannot open this file in its viewer: {notice}</p>}
        {mismatch && detected && (
          <p className="file-details-warning" role="note">
            Named .{file.ext || "(no extension)"}, but the contents look like {detected.label}. It may be mislabeled
            or a saved error page.
          </p>
        )}
        {head && "error" in head && <p className="file-fallback-error" role="alert">Cannot read this file: {head.error}</p>}
        {encryption && <p className="file-details-warning" role="note">{encryption}</p>}
        {officeFallbackReason(file.ext) && <p className="file-details-hint file-format-note" role="note">{officeFallbackReason(file.ext)}</p>}
        {spreadsheetFormatNote(file.ext) && <p className="file-details-warning" role="note">{spreadsheetFormatNote(file.ext)}</p>}
        {detected && <p className="file-details-hint">{hintFor(detected, file.ext)}</p>}
        <div className="file-details-actions">
          {modes.length > 1 && (
            <div className="file-mode-switch" role="tablist" aria-label="View">
              {modes.map((m) => (
                <button key={m} type="button" role="tab" aria-selected={current === m}
                  className={"btn" + (current === m ? " is-active" : "")} onClick={() => setMode(m)}>
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
          )}
          {canOpenWindow && (
            <button type="button" className="btn" onClick={() => void openDocWindow(file.relPath)}>
              Open in a new window
            </button>
          )}
          {isActive && (
            <button type="button" className="btn" onClick={revealActiveFile}>Show in sidebar</button>
          )}
        </div>
      </section>
      <div className="file-fallback-body">
        <Suspense fallback={<div className="editor-empty">Loading viewer…</div>}>
          {head && "cache" in head && current === "bytes" && <HexView cache={head.cache} onFileChanged={onFileChanged} />}
          {current === "contents" && <ZipView file={file} />}
          {current === "book" && <EpubView file={file} />}
          {current === "office" && <LegacyOfficeView file={file} />}
        </Suspense>
      </div>
    </div>
  );
}
