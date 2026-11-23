import { useRef, type ChangeEvent, type KeyboardEvent } from "react";
import { useAppStore } from "../store";
import { IN_TAURI } from "../lib/vault";
import type { VaultFile } from "../types";
import { EncryptedOfficeGate } from "./EncryptedOfficeGate";
import { FileFallbackView } from "./FileFallbackView";
import type { WordCommand, WordImageMime } from "./wordEngine";
import { useWordDocument, type WordSurfaceFactory } from "./useWordDocument";
import { formatBytes } from "../lib/formatBytes";

/** Largest picture Mesa inserts; bigger files are refused with a reason. */
const IMAGE_LIMIT_BYTES = 16 * 1024 * 1024;
/** Inserted pictures start at most this wide (6 inches), keeping their aspect. */
const IMAGE_MAX_WIDTH_PT = 432;

const MARKS: { mark: "bold" | "italic" | "underline" | "strike"; label: string; title: string }[] = [
  { mark: "bold", label: "B", title: "Bold" },
  { mark: "italic", label: "I", title: "Italic" },
  { mark: "underline", label: "U", title: "Underline" },
  { mark: "strike", label: "S", title: "Strikethrough" },
];
const ALIGNS: { align: "left" | "center" | "right" | "justify"; label: string; current: string }[] = [
  { align: "left", label: "Left", current: "left" },
  { align: "center", label: "Center", current: "center" },
  { align: "right", label: "Right", current: "right" },
  { align: "justify", label: "Justify", current: "both" },
];

function imageMime(bytes: Uint8Array): WordImageMime | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return null;
}

async function pictureSize(bytes: Uint8Array, mime: WordImageMime): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  const width = bitmap.width * 0.75;
  const height = bitmap.height * 0.75;
  bitmap.close();
  const scale = Math.min(1, IMAGE_MAX_WIDTH_PT / Math.max(width, 1));
  return { width: Math.max(1, width * scale), height: Math.max(1, height * scale) };
}

/**
 * Word (.docx, .docm, .dotx, .dotm) viewer and, where `editable`, editor.
 * Opens read-only; Edit unlocks the engine. Save writes only the parts the
 * edit changed (docs/office-editing.md). Files Mesa cannot open fall back to
 * the details view with the reason.
 */
export function WordView(props: WordViewProps) {
  const storeFile = useAppStore((s) => s.fileFor(props.rel));
  return (
    <EncryptedOfficeGate file={props.file ?? storeFile}>
      <WordViewBody {...props} />
    </EncryptedOfficeGate>
  );
}

interface WordViewProps {
  rel: string;
  /** Detached windows pass their own catalog entry. */
  file?: VaultFile;
  editable?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  mountSurface?: WordSurfaceFactory;
}

function WordViewBody({ rel, file: givenFile, editable = false, onDirtyChange, mountSurface }: WordViewProps) {
  const storeFile = useAppStore((s) => s.fileFor(rel));
  const file = givenFile ?? storeFile;
  const doc = useWordDocument(file ? { path: file.path, relPath: file.relPath, mtime: file.mtime } : undefined, onDirtyChange, mountSurface);
  const pictureInput = useRef<HTMLInputElement | null>(null);
  if (!file) return <div className="editor-empty">File not found.</div>;
  if (doc.load.state === "unsupported") return <FileFallbackView file={file} notice={doc.load.message} />;

  const notice = doc.load.state === "ready" ? doc.load.notice : null;
  const editing = doc.mode === "editing";
  const canEdit = editable && IN_TAURI && doc.surfaceReady && !doc.readOnlyReason;

  const run = (command: WordCommand) => () => doc.run(command);
  const onPicture = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = "";
    if (!picked) return;
    if (picked.size > IMAGE_LIMIT_BYTES) return void doc.report(`Pictures above ${formatBytes(IMAGE_LIMIT_BYTES)} are not inserted.`);
    try {
      const bytes = new Uint8Array(await picked.arrayBuffer());
      const mime = imageMime(bytes);
      if (!mime) return void doc.report("Only PNG, JPEG and GIF pictures can be inserted.");
      const size = await pictureSize(bytes, mime);
      await doc.insertImage(bytes, mime, size.width, size.height);
    } catch (error) {
      doc.report(`The picture could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!editing || !(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    if (notice?.canSave && !doc.changedOnDisk) void doc.save();
  };

  const state = doc.busy ? "Saving…" : editing ? (doc.dirty ? "Unsaved changes" : "Editing, no changes") : doc.mode === "preparing" ? "Preparing editor…" : "Read-only";
  return (
    <div className="word-view" data-testid="word-view" onKeyDown={onKeyDown}>
      <div className="pdf-toolbar word-toolbar" role="toolbar" aria-label="Word document">
        <span className={`word-state${doc.dirty ? " is-dirty" : ""}`} role="status" aria-live="polite">{state}</span>
        {editing && <>
          <button className="btn ghost" onClick={run({ type: "undo" })} disabled={!doc.format.canUndo}>Undo</button>
          <button className="btn ghost" onClick={run({ type: "redo" })} disabled={!doc.format.canRedo}>Redo</button>
          {MARKS.map((m) => (
            <button key={m.mark} className={`seg-btn word-mark word-mark-${m.mark}`} title={m.title} aria-label={m.title}
              aria-pressed={doc.format[m.mark]} onMouseDown={(e) => e.preventDefault()} onClick={run({ type: "toggleMark", mark: m.mark })}>{m.label}</button>
          ))}
          <select className="word-align" aria-label="Alignment" value=""
            onChange={(e) => { const a = ALIGNS.find((x) => x.align === e.target.value); if (a) doc.run({ type: "setAlignment", align: a.align }); }}>
            <option value="">{`Align: ${ALIGNS.find((a) => a.current === doc.format.alignment)?.label ?? "—"}`}</option>
            {ALIGNS.map((a) => <option key={a.align} value={a.align}>{a.label}</option>)}
          </select>
          <button className="btn ghost" onClick={run({ type: "toggleList", kind: "bullet" })}>Bullets</button>
          <button className="btn ghost" onClick={run({ type: "toggleList", kind: "ordered" })}>Numbering</button>
          <button className="btn ghost" disabled={!doc.format.inTable} onClick={run({ type: "insertRow", where: "below" })}>Add row</button>
          <button className="btn ghost" disabled={!doc.format.inTable} onClick={run({ type: "insertColumn", where: "right" })}>Add column</button>
          <button className="btn ghost" onClick={() => pictureInput.current?.click()}>Picture…</button>
          <input ref={pictureInput} type="file" accept="image/png,image/jpeg,image/gif" hidden onChange={(e) => void onPicture(e)} />
        </>}
        <span className="spacer" />
        {!editing && canEdit && <button className="btn primary" disabled={doc.mode !== "viewing"} onClick={() => void doc.startEditing()}>Edit</button>}
        {editing && !doc.dirty && <button className="btn ghost" onClick={doc.stopEditing}>Done</button>}
        {(doc.dirty || doc.changedOnDisk) && <button className="btn ghost" disabled={doc.busy} onClick={() => void doc.discard()}>Discard</button>}
        {editing && <button className="btn" disabled={!doc.dirty || doc.busy} onClick={() => void doc.saveCopy()}>Save as copy</button>}
        {editing && <button className="btn primary" disabled={!doc.dirty || doc.busy || !notice?.canSave || doc.changedOnDisk}
          title={notice?.canSave ? undefined : notice?.message ?? undefined} onClick={() => void doc.save()}>Save</button>}
      </div>
      {notice?.message && editable && <div className="rtf-notice word-notice" role="note">{notice.message}</div>}
      {editable && !IN_TAURI && <div className="rtf-notice word-notice" role="note">Editing Word files works in the desktop app; the browser demo is read-only.</div>}
      {doc.status && <div className="pdf-status" role="status">{doc.status}</div>}
      {doc.load.state === "loading" && <div className="editor-empty">Loading…</div>}
      <div className="word-surface" ref={doc.hostRef} aria-label={`${file.name} (Word)`} aria-busy={!doc.surfaceReady} />
    </div>
  );
}
