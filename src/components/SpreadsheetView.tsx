import { useCallback, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useAppStore } from "../store";
import type { VaultFile } from "../types";
import { formatCellRef, MAX_SHEET_COLUMNS, MAX_SHEET_ROWS, type CellRange } from "../lib/cellRef";
import { cellEditRefusal, cellView, currentIndex, sheetEditRefusal } from "../lib/ooxml/xlsxDraft";
import type { SheetIndex } from "../lib/ooxml/xlsxSheet";
import type { CellView } from "../lib/ooxml/xlsxCells";
import { DataGrid, type GridCell, type GridCursor } from "./DataGrid";
import { EncryptedOfficeGate } from "./EncryptedOfficeGate";
import { FileFallbackView } from "./FileFallbackView";
import { useXlsxEditor } from "./useXlsxEditor";

/** Empty rows and columns shown past the used range, so new cells can be typed. */
const EXTRA_ROWS = 50;
const EXTRA_COLUMNS = 8;
/** Merge lookup is per visible cell; beyond this many merges they are not drawn. */
const MAX_DRAWN_MERGES = 5000;
const NO_SHEETS: readonly never[] = [];

function cellStyle(view: CellView): CSSProperties | undefined {
  const s = view.style;
  if (!s.bold && !s.italic && !s.underline && !s.strike && !s.color && !s.fill && !s.align) return undefined;
  const decoration = [s.underline ? "underline" : "", s.strike ? "line-through" : ""].filter(Boolean).join(" ");
  return {
    fontWeight: s.bold ? 700 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: decoration || undefined,
    color: s.color ?? undefined,
    background: s.fill ?? undefined,
    textAlign: s.align ?? undefined,
  };
}

function mergeAt(merges: readonly CellRange[], row: number, col: number): CellRange | null {
  if (merges.length > MAX_DRAWN_MERGES) return null;
  for (const m of merges) if (row >= m.top && row <= m.bottom && col >= m.left && col <= m.right) return m;
  return null;
}

/** Excel column width (characters) to CSS pixels, as Excel draws Calibri 11. */
function widthPx(chars: number): number {
  return Math.max(24, Math.round(chars * 7 + 5));
}

function SheetTabs({ names, active, onSelect, renaming, onRename, onRenameDone }: {
  names: ReadonlyArray<{ name: string; hidden: boolean }>;
  active: number;
  onSelect: (i: number) => void;
  renaming: boolean;
  onRename: (name: string) => void;
  onRenameDone: () => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => { if (renaming) setValue(names[active]?.name ?? ""); }, [renaming, active, names]);
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); onRename(value); }
    else if (event.key === "Escape") { event.preventDefault(); onRenameDone(); }
  };
  return (
    <div className="sheet-tabs" role="tablist" aria-label="Sheets">
      {names.map((sheet, i) => (i === active && renaming ? (
        <input key={i} className="sheet-formula-input" aria-label="Sheet name" autoFocus value={value}
          onChange={(e) => setValue(e.target.value)} onKeyDown={onKey} onBlur={onRenameDone} maxLength={31} />
      ) : (
        <button key={i} type="button" role="tab" aria-selected={i === active} className="sheet-tab" onClick={() => onSelect(i)}>
          {sheet.name}{sheet.hidden ? " (hidden)" : ""}
        </button>
      )))}
    </div>
  );
}

/**
 * Excel workbook viewer and, in the main pane, editor. Read-only until Edit;
 * edits patch only the changed cells (lib/ooxml/xlsxPatch.ts) and save
 * through the verified byte path. Surfaces without the store's unsaved-edit
 * guard (previews, document windows) stay view-only.
 */
export function SpreadsheetView(props: SpreadsheetViewProps) {
  const storeFile = useAppStore((s) => s.fileFor(props.rel));
  const file = props.file ?? storeFile;
  return (
    <EncryptedOfficeGate file={file}>
      <SpreadsheetViewBody {...props} />
    </EncryptedOfficeGate>
  );
}

interface SpreadsheetViewProps {
  rel: string;
  /** Detached windows pass their own catalog entry. */
  file?: VaultFile;
  editable?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}

function SpreadsheetViewBody({ rel, file: givenFile, editable: editableProp = false, onDirtyChange }: SpreadsheetViewProps) {
  const storeFile = useAppStore((s) => s.fileFor(rel));
  const file = givenFile ?? storeFile;
  const editor = useXlsxEditor(file, onDirtyChange);
  const editable = editableProp && !editor.readOnlyReason;
  const { load, draft } = editor;
  const opened = load.state === "ready" ? load.opened : null;
  const session = opened?.session ?? null;
  const [position, setPosition] = useState(0);
  const [cursor, setCursor] = useState<GridCursor | null>(null);
  const [bar, setBar] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [indexIssue, setIndexIssue] = useState<string | null>(null);
  const [, setIndexed] = useState(0);
  const sheets = draft?.sheets ?? NO_SHEETS;
  const sheet = sheets[Math.min(position, Math.max(0, sheets.length - 1))];
  const part = sheet?.kind === "worksheet" ? sheet.part : null;
  const ready = !!session && !!draft && !!part && (session.hasIndex(part) || draft.sheetDrafts.has(part));
  const { ensureIndex } = editor;

  useEffect(() => {
    if (!part || ready) return;
    let alive = true;
    setIndexIssue(null);
    ensureIndex(part).then(() => { if (alive) setIndexed((n) => n + 1); }, (error: unknown) => {
      if (alive) setIndexIssue(error instanceof Error ? error.message : String(error));
    });
    return () => { alive = false; };
  }, [part, ready, ensureIndex]);

  const index: SheetIndex | null = ready && session && draft && part ? currentIndex(session, draft, part) : null;
  const columnWidth = useCallback((col: number) => widthPx(index?.columnWidths.get(col) ?? index?.defaultColumnWidth ?? 8.43), [index]);
  const rowCount = index ? Math.min(MAX_SHEET_ROWS, Math.max(index.usedRows, cursor ? cursor.row + 1 : 0) + EXTRA_ROWS) : 0;
  const columnCount = index ? Math.min(MAX_SHEET_COLUMNS, Math.max(index.usedColumns, cursor ? cursor.col + 1 : 0) + EXTRA_COLUMNS) : 0;
  const sheetRefusal = editor.editing && session && draft && part && index ? sheetEditRefusal(session, draft, part) : null;
  const rowJob = editor.rowJob;
  const canEdit = editable && editor.editing && !sheetRefusal && !rowJob;
  const view = (row: number, col: number) => cellView(session!, draft!, part!, row, col);

  const cell = (row: number, col: number): GridCell => {
    const merge = index ? mergeAt(index.merges, row, col) : null;
    if (merge && (merge.top !== row || merge.left !== col)) return { text: "", hidden: true };
    const v = view(row, col);
    const classes = [v.numeric && !v.style.align ? "num" : "", v.edited ? "edited" : "", v.edited && v.formula ? "formula-pending" : "", v.style.wrap ? "wrap" : ""];
    return {
      text: v.display,
      title: v.formula ? `${v.edit}${v.edited ? " (calculated when Excel opens the file)" : ` = ${v.display}`}` : v.display,
      className: classes.filter(Boolean).join(" ") || undefined,
      style: cellStyle(v),
      span: merge ? { cols: merge.right - merge.left + 1, rows: merge.bottom - merge.top + 1 } : undefined,
    };
  };

  const selected = cursor && index ? view(cursor.row, cursor.col) : null;
  const commitBar = () => {
    if (bar === null || !cursor || !part) return;
    editor.setCell(part, cursor.row, cursor.col, bar);
    setBar(null);
  };
  const names = useMemo(() => sheets.map((s) => ({ name: s.name, hidden: s.state !== "visible" })), [sheets]);

  if (!file) return <div className="editor-empty">File not found.</div>;
  if (load.state === "failed") {
    return (
      <div className="sheet-view">
        <div className="sheet-notice warn" role="alert">{load.message}</div>
        <FileFallbackView file={file} />
      </div>
    );
  }
  if (!opened || !draft) return <div className="editor-empty">Opening workbook…</div>;

  const refusal = opened.refusals.length ? `Read-only: Mesa does not save this workbook because ${opened.refusals.join("; ")}.` : null;
  const hasFormulas = !!index?.hasFormulas;

  return (
    <div className="sheet-view" data-testid="spreadsheet-view">
      {editable && (
        <div className="table-editor-bar" role="toolbar" aria-label="Workbook editing">
          {!editor.editing ? (
            <button className="btn" disabled={!!refusal} onClick={() => void editor.startEditing()}>Edit</button>
          ) : (
            <>
              <button className="seg-btn" disabled={!editor.canUndo || !!rowJob} onClick={editor.undo}>Undo</button>
              <button className="seg-btn" disabled={!editor.canRedo || !!rowJob} onClick={editor.redo}>Redo</button>
              <button className="seg-btn" disabled={!canEdit || !cursor} onClick={() => { if (cursor && part) void editor.shiftRow(part, cursor.row, true); }}>Insert row</button>
              <button className="seg-btn" disabled={!canEdit || !cursor} onClick={() => { if (cursor && part) void editor.shiftRow(part, cursor.row, false); }}>Delete row</button>
              <button className="seg-btn" disabled={!!rowJob} onClick={() => { if (editor.addSheet(nextSheetName(sheets.map((s) => s.name)))) setPosition(sheets.length); }}>Add sheet</button>
              <button className="seg-btn" disabled={!sheet || !!rowJob} onClick={() => setRenaming(true)}>Rename sheet</button>
              <span className="spacer" />
              {editor.dirty && <span className="sheet-dirty" role="status">Unsaved changes</span>}
              <button className="btn ghost" disabled={!!rowJob} onClick={() => void editor.discard()}>{editor.dirty ? "Discard" : "Done"}</button>
              <button className="btn" disabled={!editor.dirty || editor.busy || !!rowJob} onClick={() => void editor.saveCopy()}>Save as copy</button>
              <button className="btn primary" disabled={!editor.dirty || editor.busy || editor.diskChanged || !!rowJob} onClick={() => void editor.save()}>
                {editor.busy ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      )}
      {editable && refusal && <div className="sheet-notice" role="status">{refusal}</div>}
      {editable && !refusal && opened.warnings.length > 0 && <div className="sheet-notice warn" role="note">{opened.warnings.join(" ")}</div>}
      {editor.editing && sheetRefusal && <div className="sheet-notice" role="status">This sheet is read-only: {sheetRefusal}.</div>}
      {hasFormulas && <div className="sheet-notice" role="note">Formula cells show the results saved in the file. Mesa does not calculate; after an edit, Excel recalculates when it opens the file.</div>}
      {rowJob && (
        <div className="sheet-notice" role="status" aria-busy="true" data-testid="sheet-row-job">
          {rowJob.insert ? "Inserting" : "Deleting"} row {rowJob.row + 1}… Editing resumes when Mesa finishes.
        </div>
      )}
      {editor.status && <div className="sheet-notice warn" role="status">{editor.status}</div>}
      <div className="sheet-formula-bar">
        <span className="sheet-cell-name" aria-label="Selected cell">{cursor ? formatCellRef(cursor.row, cursor.col) : ""}</span>
        <input
          className="sheet-formula-input"
          aria-label="Cell contents"
          readOnly={!canEdit || !cursor}
          value={bar ?? selected?.edit ?? ""}
          onChange={(e) => setBar(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commitBar(); }
            else if (e.key === "Escape") { e.preventDefault(); setBar(null); }
          }}
          onBlur={() => setBar(null)}
        />
      </div>
      {!part && <div className="editor-empty">This is a {sheet?.kind ?? "sheet"} part. Mesa shows worksheets only.</div>}
      {part && !index && <div className="editor-empty" role={indexIssue ? "alert" : undefined}>{indexIssue ? `Mesa cannot show this sheet: ${indexIssue}` : "Reading sheet…"}</div>}
      {index && (
        <DataGrid
          key={part}
          rowCount={rowCount}
          columnCount={columnCount}
          cell={cell}
          editText={(row, col) => view(row, col).edit}
          editable={canEdit}
          editRefusal={(row, col) => cellEditRefusal(session!, draft, part!, row, col)}
          onRefused={editor.setStatus}
          onCommit={(row, col, text) => { if (part) editor.setCell(part, row, col, text); }}
          onUndo={editor.undo}
          onRedo={editor.redo}
          onCursorChange={(next) => { setCursor(next); setBar(null); }}
          columnWidth={columnWidth}
          frozenRows={index.frozenRows}
          frozenColumns={index.frozenColumns}
          typeToEdit
          ariaLabel={`${sheet?.name ?? "Sheet"} cells`}
        />
      )}
      <SheetTabs
        names={names}
        active={Math.min(position, Math.max(0, sheets.length - 1))}
        onSelect={(i) => { setPosition(i); setCursor(null); setBar(null); setRenaming(false); }}
        renaming={renaming && editor.editing}
        onRename={(name) => { if (editor.rename(position, name)) setRenaming(false); }}
        onRenameDone={() => setRenaming(false)}
      />
    </div>
  );
}

function nextSheetName(taken: readonly string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  for (let n = taken.length + 1; n < taken.length + 1000; n++) if (!lower.has(`sheet${n}`)) return `Sheet${n}`;
  return `Sheet${Date.now()}`;
}
