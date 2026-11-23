import { useCallback, type ClipboardEvent, type KeyboardEvent } from "react";
import { useAppStore } from "../store";
import type { RtfFormat } from "../lib/rtfDocument";
import type { VaultFile } from "../types";
import { useRtfEditor } from "./useRtfEditor";

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
type Toggle = "b" | "i" | "ul" | "strike";
const TOGGLES: { key: Toggle; label: string; title: string }[] = [
  { key: "b", label: "B", title: "Bold" },
  { key: "i", label: "I", title: "Italic" },
  { key: "ul", label: "U", title: "Underline" },
  { key: "strike", label: "S", title: "Strikethrough" },
];

/** Rich RTF viewer and, in the main pane, editor. Formatting shows as
 *  written; edits save only the changed text (see `lib/rtfEdit.ts`). Files
 *  Mesa cannot write back exactly open read-only with the reason. Surfaces
 *  without the store's unsaved-edit guard (previews) stay view-only. */
export function RtfView({ rel, file: givenFile, editable = false, onDirtyChange }: {
  rel: string;
  /** Detached windows pass their own catalog entry. */
  file?: VaultFile;
  editable?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const storeFile = useAppStore((s) => s.fileFor(rel));
  const file = givenFile ?? storeFile;
  const adoptSavedBytes = useAppStore((s) => s.adoptSavedBytes);
  const onSaved = useCallback((bytes: Uint8Array, path: string) => adoptSavedBytes(rel, bytes, path), [adoptSavedBytes, rel]);
  const editor = useRtfEditor(file ? { path: file.path, mtime: file.mtime } : undefined, onDirtyChange, onSaved);
  const { load } = editor;
  const doc = load.state === "ready" ? load.doc : null;
  const readOnly = !editable || !doc || !!doc.readOnlyReason;

  const toggle = (key: Toggle) => editor.format((f: RtfFormat, all: RtfFormat[]) => ({ ...f, [key]: !all.every((x) => x[key]) }));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const run = (action: () => void) => {
      event.preventDefault();
      action();
    };
    if (key === "z" && event.shiftKey) run(editor.redo);
    else if (key === "z" || key === "y") run(key === "y" ? editor.redo : editor.undo);
    else if (readOnly) return;
    else if (key === "b") run(() => toggle("b"));
    else if (key === "i") run(() => toggle("i"));
    else if (key === "u") run(() => toggle("ul"));
  };
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    event.preventDefault();
    editor.paste(event.clipboardData.getData("text/plain"));
  };
  const onBeforeInput = (event: { nativeEvent: Event; preventDefault(): void }) => {
    const type = (event.nativeEvent as InputEvent).inputType ?? "";
    // Native rich-text commands would bypass the format model; Mesa's own undo owns history.
    if (/^format/.test(type) || type === "historyUndo" || type === "historyRedo" || type === "insertFromDrop") event.preventDefault();
  };

  if (!file) return <div className="editor-empty">File not found.</div>;
  if (load.state === "failed") return <div className="editor-empty" role="alert">{load.message}</div>;

  return (
    <div className="rtf-editor" data-testid="rtf-editor">
      {editable && <div className="pdf-toolbar rtf-toolbar" role="toolbar" aria-label="RTF formatting">
        {TOGGLES.map((t) => (
          <button
            key={t.key}
            className={`seg-btn rtf-toggle rtf-toggle-${t.key}`}
            title={t.title}
            aria-label={t.title}
            disabled={readOnly}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggle(t.key)}
          >
            {t.label}
          </button>
        ))}
        <select
          className="rtf-size"
          aria-label="Font size"
          disabled={readOnly}
          defaultValue=""
          onChange={(e) => {
            const pt = Number(e.target.value);
            e.target.value = "";
            if (pt) editor.format((f) => ({ ...f, fs: pt * 2 }));
          }}
        >
          <option value="">Size</option>
          {SIZES.map((pt) => <option key={pt} value={pt}>{pt} pt</option>)}
        </select>
        <button className="btn ghost" onClick={editor.undo} disabled={!editor.history.undo && !editor.dirty}>Undo</button>
        <button className="btn ghost" onClick={editor.redo} disabled={!editor.history.redo}>Redo</button>
        <span className="spacer" />
        {editor.dirty && <button className="btn ghost" onClick={() => void editor.discard()}>Discard</button>}
        <button className="btn primary" onClick={() => void editor.save()} disabled={readOnly || !editor.dirty || editor.saving}>
          {editor.saving ? "Saving…" : "Save"}
        </button>
      </div>}
      {editable && doc?.readOnlyReason && (
        <div className="rtf-notice" role="status">Read-only: Mesa cannot save this file without changing parts it does not edit, because {doc.readOnlyReason}.</div>
      )}
      {editor.status && <div className="pdf-status" role="status">{editor.status}</div>}
      {load.state === "loading" && <div className="editor-empty">Loading…</div>}
      <div className="rtf-view">
        <div
          ref={editor.rootRef}
          className="rtf-page"
          contentEditable={!readOnly && !editor.saving}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={`${file.name} (RTF)`}
          aria-readonly={readOnly || editor.saving}
          spellCheck
          onInput={editor.onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBeforeInput={onBeforeInput}
          onDrop={(e) => e.preventDefault()}
        />
      </div>
    </div>
  );
}
