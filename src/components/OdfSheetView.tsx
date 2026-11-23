import { useCallback, useMemo, useState } from "react";
import { formatCellRef, MAX_SHEET_COLUMNS, MAX_SHEET_ROWS, type CellRange } from "../lib/cellRef";
import type { OdfPackage } from "../lib/odf/odfPackage";
import {
  applyOdsEdits, cellAt, cellKey, checkOdsEdits, columnWidthAt, normalizeCellText, odsCellRefusal, openOdsWorkbook,
  type OdsEdits, type OdsWorkbook,
} from "../lib/odf/odsSheet";
import type { VaultFile } from "../types";
import { DataGrid, type GridCell, type GridCursor } from "./DataGrid";
import { OdfFailed, OdfToolbar } from "./OdfToolbar";
import { useOdfEditor, type OdfDraftSpec } from "./useOdfEditor";

const EXTRA_ROWS = 50;
const EXTRA_COLUMNS = 8;
const MAX_DRAWN_MERGES = 5000;
const NO_EDITS: OdsEdits = new Map();
const workbooks = new WeakMap<OdfPackage, OdsWorkbook>();

function workbookOf(pkg: OdfPackage): OdsWorkbook {
  let wb = workbooks.get(pkg);
  if (!wb) { wb = openOdsWorkbook(pkg); workbooks.set(pkg, wb); }
  return wb;
}

const SHEET_SPEC: OdfDraftSpec<OdsEdits> = {
  initial: () => NO_EDITS,
  content: (pkg, edits) => applyOdsEdits(workbookOf(pkg), edits),
  isClean: (_pkg, edits) => edits.size === 0,
  check: (saved, edits) => checkOdsEdits(openOdsWorkbook(saved), edits),
};

function mergeAt(merges: readonly CellRange[], row: number, col: number): CellRange | null {
  if (merges.length > MAX_DRAWN_MERGES) return null;
  for (const m of merges) if (row >= m.top && row <= m.bottom && col >= m.left && col <= m.right) return m;
  return null;
}

/** OpenDocument spreadsheet in the shared grid; cell edits patch only the touched cells. */
export function OdfSheetView({ file, editable, onDirtyChange }: { file: VaultFile; editable: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const editor = useOdfEditor(file, SHEET_SPEC, onDirtyChange);
  const [position, setPosition] = useState(0);
  const [cursor, setCursor] = useState<GridCursor | null>(null);
  const [bar, setBar] = useState<string | null>(null);
  const opened = useMemo(() => {
    if (!editor.pkg) return null;
    try { return { wb: workbookOf(editor.pkg), error: null }; } catch (error) { return { wb: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [editor.pkg]);
  const wb = opened?.wb ?? null;
  const index = wb ? Math.min(position, Math.max(0, wb.sheets.length - 1)) : 0;
  const sheet = wb?.sheets[index] ?? null;
  const edits = editor.draft ?? NO_EDITS;
  const columnWidth = useCallback((col: number) => (sheet ? columnWidthAt(sheet, col) : null) ?? 96, [sheet]);

  if (editor.load.state === "loading") return <div className="editor-empty">Opening spreadsheet…</div>;
  if (editor.load.state === "failed") return <OdfFailed file={file} message={editor.load.message} />;
  if (!wb || editor.pkg?.kind !== "spreadsheet") return <OdfFailed file={file} message={opened?.error ?? "This file is not an OpenDocument spreadsheet."} />;

  const canEdit = editable && editor.editing;
  const editOf = (row: number, col: number) => edits.get(cellKey(index, row, col)) ?? (sheet ? cellAt(sheet, row, col)?.edit ?? "" : "");
  const cell = (row: number, col: number): GridCell => {
    const merge = sheet ? mergeAt(sheet.merges, row, col) : null;
    if (merge && (merge.top !== row || merge.left !== col)) return { text: "", hidden: true };
    const edited = edits.get(cellKey(index, row, col));
    const source = sheet ? cellAt(sheet, row, col) : null;
    const span = merge ? { cols: merge.right - merge.left + 1, rows: merge.bottom - merge.top + 1 } : undefined;
    if (edited !== undefined) {
      const formula = edited.trim().startsWith("=");
      return { text: edited, title: formula ? `${edited} (calculated when LibreOffice opens the file)` : edited, className: formula ? "edited formula-pending" : "edited", span };
    }
    return {
      text: source?.display ?? "",
      title: source?.formula ? `${source.edit} = ${source.display}` : source?.display,
      className: source?.numeric ? "num" : undefined, span,
    };
  };
  const commit = (row: number, col: number, text: string) => {
    const value = normalizeCellText(text);
    editor.apply((current) => {
      const key = cellKey(index, row, col);
      const original = sheet ? cellAt(sheet, row, col)?.edit ?? "" : "";
      if ((current.get(key) ?? original) === value) return current;
      const next = new Map(current);
      if (value === original) next.delete(key); else next.set(key, value);
      return next;
    });
  };
  const rowCount = sheet ? Math.min(MAX_SHEET_ROWS, Math.max(sheet.usedRows, cursor ? cursor.row + 1 : 0) + EXTRA_ROWS) : 0;
  const maxColumns = sheet?.declaredColumns || MAX_SHEET_COLUMNS;
  const columnCount = sheet ? Math.min(maxColumns, Math.max(sheet.usedColumns, cursor ? cursor.col + 1 : 0) + EXTRA_COLUMNS) : 0;

  return (
    <div className="sheet-view" data-testid="ods-view">
      <OdfToolbar editor={editor} editable={editable} label="Spreadsheet" />
      {wb.hasFormulas && <div className="sheet-notice" role="note">Formula cells show the results saved in the file. Mesa does not calculate; formulas use OpenDocument syntax such as =SUM([.A1:.A3]), and LibreOffice recalculates edited ones when it opens the file.</div>}
      {canEdit && sheet?.protected && <div className="sheet-notice" role="status">This sheet is read-only: it is protected.</div>}
      <div className="sheet-formula-bar">
        <span className="sheet-cell-name" aria-label="Selected cell">{cursor ? formatCellRef(cursor.row, cursor.col) : ""}</span>
        <input className="sheet-formula-input" aria-label="Cell contents" readOnly={!canEdit || !cursor}
          value={bar ?? (cursor ? editOf(cursor.row, cursor.col) : "")}
          onChange={(e) => setBar(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && cursor && bar !== null && sheet) {
              e.preventDefault();
              const refusal = odsCellRefusal(sheet, cursor.row, cursor.col);
              if (refusal) editor.setStatus(refusal); else commit(cursor.row, cursor.col, bar);
              setBar(null);
            } else if (e.key === "Escape") { e.preventDefault(); setBar(null); }
          }}
          onBlur={() => setBar(null)} />
      </div>
      {sheet ? (
        <DataGrid key={index} rowCount={rowCount} columnCount={columnCount} cell={cell} editText={editOf} editable={canEdit}
          editRefusal={(row, col) => odsCellRefusal(sheet, row, col)} onRefused={editor.setStatus} onCommit={commit}
          onUndo={editor.undo} onRedo={editor.redo} onCursorChange={(next) => { setCursor(next); setBar(null); }}
          columnWidth={columnWidth} typeToEdit ariaLabel={`${sheet.name} cells`} />
      ) : <div className="editor-empty">This spreadsheet has no sheets.</div>}
      <div className="sheet-tabs" role="tablist" aria-label="Sheets">
        {wb.sheets.map((s, i) => (
          <button key={i} type="button" role="tab" aria-selected={i === index} className="sheet-tab" onClick={() => { setPosition(i); setCursor(null); setBar(null); }}>
            {s.name}{s.hidden ? " (hidden)" : ""}
          </button>
        ))}
      </div>
    </div>
  );
}
