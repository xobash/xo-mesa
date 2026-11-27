import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { placeCaretAtEnd } from "../lib/caretAtEnd";
import { clamp } from "../lib/clamp";
import { columnLetters } from "../lib/cellRef";
import { visibleCodeLineRange } from "../lib/codeWindow";
import { useScrollViewport } from "./useScrollViewport";

// The one windowed cell grid, shared by the CSV/TSV table and the
// spreadsheet view. Rows and columns are windowed: only cells in view are in
// the DOM. Select a cell, then Enter, F2 or a double-click edits it; Enter
// or Tab commits; Escape cancels; Shift+Enter adds a line break.

/** Fixed row height: rows are windowed, so only visible rows are in the DOM. */
const TABLE_ROW_HEIGHT = 26;
const GRID_ROW_HEADER_WIDTH = 56;
const DEFAULT_COLUMN_WIDTH = 160;
const COLUMN_OVERSCAN = 2;

export interface GridCursor { row: number; col: number }

export interface GridCell {
  readonly text: string;
  readonly title?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  /** Merged-cell anchor: how many columns and rows it covers. */
  readonly span?: { readonly cols: number; readonly rows: number };
  /** Covered by a merged cell: not drawn. */
  readonly hidden?: boolean;
}

interface DataGridProps {
  rowCount: number;
  columnCount: number;
  cell(row: number, col: number): GridCell;
  /** Initial editor text for a cell. */
  editText(row: number, col: number): string;
  editable: boolean;
  /** Why this cell cannot be edited, or `null`. Called before an edit starts. */
  editRefusal?(row: number, col: number): string | null;
  onRefused?(reason: string): void;
  onCommit(row: number, col: number, text: string): void;
  onUndo?(): void;
  onRedo?(): void;
  onCursorChange?(cursor: GridCursor | null): void;
  /** Column width in CSS pixels; keep the function identity stable. */
  columnWidth?(col: number): number;
  frozenRows?: number;
  frozenColumns?: number;
  /** Typing a character on a selected cell starts editing with it. */
  typeToEdit?: boolean;
  ariaLabel: string;
  className?: string;
  /** Shown above the grid (toolbar). */
  children?: ReactNode;
}

/** Left edge of every column, plus the total width at the end. */
function columnOffsets(count: number, width: (col: number) => number): Float64Array {
  const offsets = new Float64Array(count + 1);
  for (let c = 0; c < count; c++) offsets[c + 1] = offsets[c] + width(c);
  return offsets;
}

function firstColumnAt(offsets: Float64Array, x: number): number {
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (offsets[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

const fixedWidth = () => DEFAULT_COLUMN_WIDTH;

export function DataGrid(props: DataGridProps) {
  const { rowCount, columnCount, editable, frozenRows = 0, frozenColumns = 0 } = props;
  const widthOf = props.columnWidth ?? fixedWidth;
  const offsets = useMemo(() => columnOffsets(columnCount, widthOf), [columnCount, widthOf]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const viewport = useScrollViewport(scrollRef, null, true);
  const [cursor, setCursorState] = useState<GridCursor | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const at = cursor && cursor.row < rowCount && cursor.col < columnCount ? cursor : null;
  const frozenR = Math.min(frozenRows, rowCount);
  const frozenC = Math.min(frozenColumns, columnCount);
  const frozenWidth = offsets[frozenC];
  const rowHeight = TABLE_ROW_HEIGHT;

  const setCursor = (next: GridCursor | null) => {
    setCursorState(next);
    props.onCursorChange?.(next);
  };

  // A committed or cancelled draft unmounts its textarea, which can still
  // fire blur; the flag makes that late blur a no-op.
  const editing = useRef(false);
  const commit = (move: GridCursor | null) => {
    if (!editing.current) return;
    editing.current = false;
    if (at && draft !== null) props.onCommit(at.row, at.col, draft);
    setDraft(null);
    if (move) setCursor(move);
  };
  const startEdit = (target: GridCursor | null, initial?: string) => {
    if (!target || !editable) return;
    const refusal = props.editRefusal?.(target.row, target.col) ?? null;
    if (refusal) { props.onRefused?.(refusal); return; }
    editing.current = true;
    setDraft(initial ?? props.editText(target.row, target.col));
  };

  const reveal = (next: GridCursor) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = (next.row - frozenR) * rowHeight;
    const viewTop = el.scrollTop;
    const viewHeight = el.clientHeight - rowHeight * (1 + frozenR);
    if (next.row >= frozenR) {
      if (top < viewTop) el.scrollTop = top;
      else if (top + rowHeight > viewTop + viewHeight) el.scrollTop = top + rowHeight - viewHeight;
    }
    if (next.col >= frozenC) {
      const left = offsets[next.col] - frozenWidth;
      const right = offsets[next.col + 1] - frozenWidth;
      const viewWidth = el.clientWidth - GRID_ROW_HEADER_WIDTH - frozenWidth;
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (right > el.scrollLeft + viewWidth) el.scrollLeft = right - viewWidth;
    }
  };

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (draft !== null) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) props.onRedo?.();
      else props.onUndo?.();
      return;
    }
    if (mod && event.key.toLowerCase() === "y") { event.preventDefault(); props.onRedo?.(); return; }
    if (!at) return;
    const moves: Record<string, GridCursor> = {
      ArrowUp: { row: at.row - 1, col: at.col },
      ArrowDown: { row: at.row + 1, col: at.col },
      ArrowLeft: { row: at.row, col: at.col - 1 },
      ArrowRight: { row: at.row, col: at.col + 1 },
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      const next = { row: clamp(move.row, 0, rowCount - 1), col: clamp(move.col, 0, columnCount - 1) };
      setCursor(next);
      reveal(next);
      return;
    }
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      startEdit(at);
    } else if ((event.key === "Delete" || event.key === "Backspace") && editable) {
      event.preventDefault();
      const refusal = props.editRefusal?.(at.row, at.col) ?? null;
      if (refusal) props.onRefused?.(refusal);
      else props.onCommit(at.row, at.col, "");
    } else if (props.typeToEdit && !mod && !event.altKey && event.key.length === 1) {
      event.preventDefault();
      startEdit(at, event.key);
    }
  };

  const onDraftKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!at) return;
    if (event.key === "Escape") {
      event.preventDefault();
      editing.current = false;
      setDraft(null);
      scrollRef.current?.focus();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      commit({ row: Math.min(at.row + 1, rowCount - 1), col: at.col });
      scrollRef.current?.focus();
    } else if (event.key === "Tab") {
      event.preventDefault();
      commit({ row: at.row, col: clamp(at.col + (event.shiftKey ? -1 : 1), 0, columnCount - 1) });
      scrollRef.current?.focus();
    }
  };

  const bodyRows = Math.max(0, rowCount - frozenR);
  const range = visibleCodeLineRange(bodyRows, viewport.scrollTop, viewport.height, rowHeight);
  const firstCol = Math.max(frozenC, firstColumnAt(offsets, viewport.scrollLeft + frozenWidth) - COLUMN_OVERSCAN);
  let lastCol = firstCol;
  const rightEdge = viewport.scrollLeft + frozenWidth + viewport.width;
  while (lastCol < columnCount && offsets[lastCol] < rightEdge) lastCol++;
  lastCol = Math.min(columnCount, lastCol + COLUMN_OVERSCAN);
  const scrollCols: number[] = [];
  for (let c = firstCol; c < lastCol; c++) scrollCols.push(c);
  const frozenCols = Array.from({ length: frozenC }, (_, c) => c);
  const totalWidth = GRID_ROW_HEADER_WIDTH + offsets[columnCount];

  const cellBox = (col: number, spec: GridCell): CSSProperties => {
    const cols = spec.span?.cols ?? 1;
    const rows = spec.span?.rows ?? 1;
    const end = Math.min(columnCount, col + cols);
    return {
      ...spec.style,
      left: GRID_ROW_HEADER_WIDTH + offsets[col],
      width: offsets[end] - offsets[col],
      height: rows * rowHeight,
      zIndex: rows > 1 || cols > 1 ? 1 : undefined,
    };
  };

  const renderCell = (row: number, col: number) => {
    const spec = props.cell(row, col);
    if (spec.hidden) return null;
    const selected = at?.row === row && at.col === col;
    const name = `${columnLetters(col)}${row + 1}`;
    if (selected && draft !== null) {
      return (
        <textarea
          key={col}
          className="table-editor-input"
          style={{ left: GRID_ROW_HEADER_WIDTH + offsets[col], width: Math.max(offsets[col + 1] - offsets[col], 120) }}
          aria-label={`Edit cell ${name}`}
          autoFocus
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={placeCaretAtEnd}
          onKeyDown={onDraftKey}
          onBlur={() => commit(null)}
        />
      );
    }
    return (
      <span
        key={col}
        role="gridcell"
        aria-selected={selected}
        aria-colindex={col + 1}
        title={spec.title ?? spec.text}
        className={"table-editor-cell" + (selected ? " selected" : "") + (col < frozenC ? " frozen" : "") + (spec.className ? ` ${spec.className}` : "")}
        style={cellBox(col, spec)}
        onClick={() => setCursor({ row, col })}
        onDoubleClick={() => {
          setCursor({ row, col });
          startEdit({ row, col });
        }}
      >
        {spec.text.replace(/\r\n|\r|\n/g, " ⏎ ")}
      </span>
    );
  };

  const renderRow = (row: number, top: number) => (
    <div key={row} role="row" aria-rowindex={row + 2} className="table-editor-row" style={{ top, height: rowHeight, width: totalWidth }}>
      <div className="table-editor-frozen" style={{ width: GRID_ROW_HEADER_WIDTH + frozenWidth }}>
        <span className="table-editor-rownum" aria-hidden="true">{row + 1}</span>
        {frozenCols.map((col) => renderCell(row, col))}
      </div>
      {scrollCols.map((col) => renderCell(row, col))}
    </div>
  );

  const header = (col: number) => (
    <span key={col} role="columnheader" className={"table-editor-colhead" + (col < frozenC ? " frozen" : "")} style={{ left: GRID_ROW_HEADER_WIDTH + offsets[col], width: offsets[col + 1] - offsets[col] }}>
      {columnLetters(col)}
    </span>
  );

  const visible: number[] = [];
  for (let i = range.start; i < range.end; i++) visible.push(i + frozenR);

  return (
    <div className={"table-editor" + (props.className ? ` ${props.className}` : "")}>
      {props.children}
      <div
        className="table-editor-scroll"
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-label={props.ariaLabel}
        aria-rowcount={rowCount + 1}
        aria-colcount={columnCount}
        aria-readonly={!editable}
        onKeyDown={onGridKey}
      >
        <div className="table-editor-head" style={{ width: totalWidth, height: rowHeight * (1 + frozenR) }}>
          <div role="row" aria-rowindex={1} className="table-editor-row" style={{ top: 0, height: rowHeight, width: totalWidth }}>
            <div className="table-editor-frozen" style={{ width: GRID_ROW_HEADER_WIDTH + frozenWidth }}>
              <span className="table-editor-rownum" aria-hidden="true">#</span>
              {frozenCols.map(header)}
            </div>
            {scrollCols.map(header)}
          </div>
          {Array.from({ length: frozenR }, (_, row) => renderRow(row, (row + 1) * rowHeight))}
        </div>
        <div className="table-editor-spacer" style={{ height: bodyRows * rowHeight, width: totalWidth }}>
          {visible.map((row) => renderRow(row, (row - frozenR) * rowHeight))}
        </div>
      </div>
    </div>
  );
}
