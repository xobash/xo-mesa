import { useState } from "react";
import {
  insertColumn,
  insertRow,
  removeColumn,
  removeRow,
  rowCells,
  scanDelimited,
  serializeTable,
  setCell,
  tableUndoBytes,
  type DelimitedTable,
} from "../lib/delimitedTable";
import { DataGrid, type GridCursor } from "./DataGrid";

/** Most undo steps kept in the table view. */
const MAX_TABLE_UNDO = 50;
/**
 * Memory the undo steps may hold. A step is a whole earlier table, and on a
 * very large file one column edit decodes every row, so a step count alone
 * let the history reach gigabytes. The newest step is always kept.
 */
export const MAX_TABLE_UNDO_BYTES = 128 * 1024 * 1024;

interface UndoStep {
  readonly table: DelimitedTable;
  /** `tableUndoBytes` against the table that replaced it. */
  readonly bytes: number;
}

/** `steps` plus `table` (replaced by `next`), trimmed from the oldest end to both limits. */
export function pushTableUndo(steps: readonly UndoStep[], table: DelimitedTable, next: DelimitedTable, maxBytes = MAX_TABLE_UNDO_BYTES): UndoStep[] {
  const kept = [...steps.slice(-(MAX_TABLE_UNDO - 1)), { table, bytes: tableUndoBytes(table, next) }];
  let total = 0;
  for (const step of kept) total += step.bytes;
  let drop = 0;
  while (drop < kept.length - 1 && total > maxBytes) total -= kept[drop++].bytes;
  return drop ? kept.slice(drop) : kept;
}

interface Props {
  text: string;
  delimiter: string;
  /** Null when editable; otherwise the reason shown on screen. */
  readOnlyReason: string | null;
  /** Receives the new file text after a committed change. */
  onChange: (text: string) => void;
}

interface TableModel {
  text: string;
  delimiter: string;
  table: DelimitedTable;
  /** Earlier tables, newest last. Cleared when the text changes from outside. */
  undo: readonly UndoStep[];
}

/** Keep the parsed table for text this view wrote itself; rescan any other text. */
function useTableModel(text: string, delimiter: string) {
  const [model, setModel] = useState<TableModel>(() => ({ text, delimiter, table: scanDelimited(text, delimiter), undo: [] }));
  let current = model;
  if (model.text !== text || model.delimiter !== delimiter) {
    current = { text, delimiter, table: scanDelimited(text, delimiter), undo: [] };
    setModel(current);
  }
  return [current, setModel] as const;
}

/**
 * Editable, windowed CSV/TSV grid. A change re-serializes only the rows it
 * touched; every other row keeps its exact bytes (lib/delimitedTable.ts).
 */
export function TableEditor({ text, delimiter, readOnlyReason, onChange }: Props) {
  const [model, setModel] = useTableModel(text, delimiter);
  const table = model.table;
  const [cursor, setCursor] = useState<GridCursor | null>(null);
  const editable = readOnlyReason === null;
  const columns = Math.max(1, table.columns);
  const rowCount = table.rows.length;
  const at = cursor && cursor.row < rowCount ? cursor : null;

  const publish = (next: DelimitedTable, undo: readonly UndoStep[]) => {
    const nextText = serializeTable(next);
    setModel({ text: nextText, delimiter, table: next, undo });
    onChange(nextText);
  };
  const apply = (next: DelimitedTable) => {
    if (next === table || !editable) return;
    publish(next, pushTableUndo(model.undo, table, next));
  };
  const undoLast = () => {
    const previous = model.undo[model.undo.length - 1];
    if (!previous || !editable) return;
    publish(previous.table, model.undo.slice(0, -1));
  };

  return (
    <DataGrid
      rowCount={rowCount}
      columnCount={columns}
      cell={(row, col) => ({ text: rowCells(table, row)[col] ?? "" })}
      editText={(row, col) => rowCells(table, row)[col] ?? ""}
      editable={editable}
      onCommit={(row, col, value) => apply(setCell(table, row, col, value))}
      onUndo={undoLast}
      onCursorChange={setCursor}
      ariaLabel="Table cells"
    >
      <div className="table-editor-bar" role="toolbar" aria-label="Table editing">
        <span className="code-meta">{rowCount} rows × {table.columns} columns</span>
        <button className="seg-btn" disabled={!editable} onClick={() => apply(insertRow(table, at ? at.row + 1 : rowCount))}>
          Add row
        </button>
        <button className="seg-btn" disabled={!editable || !at} onClick={() => at && apply(removeRow(table, at.row))}>
          Delete row
        </button>
        <button className="seg-btn" disabled={!editable} onClick={() => apply(insertColumn(table, at ? at.col + 1 : table.columns))}>
          Add column
        </button>
        <button className="seg-btn" disabled={!editable || !at || table.columns === 0} onClick={() => at && apply(removeColumn(table, at.col))}>
          Delete column
        </button>
        <button className="seg-btn" disabled={!editable || model.undo.length === 0} onClick={undoLast}>
          Undo
        </button>
        {readOnlyReason && <span className="table-editor-readonly" role="status">Read-only: {readOnlyReason}</span>}
      </div>
    </DataGrid>
  );
}
