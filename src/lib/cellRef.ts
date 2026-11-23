// A1-style cell references shared by the CSV grid and the spreadsheet editor.
// Rows and columns are 0-based here; A1 is { row: 0, col: 0 }. Limits follow
// Excel's grid (ECMA-376 Part 1, 18.3.1.4 and 18.3.1.73).

export const MAX_SHEET_ROWS = 1_048_576;
export const MAX_SHEET_COLUMNS = 16_384;

export interface CellAddress {
  readonly row: number;
  readonly col: number;
}

export interface CellRange {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". At most four letters for any safe input. */
export function columnLetters(index: number): string {
  let name = "";
  let n = Math.max(0, Math.floor(index)) + 1;
  for (let guard = 0; n > 0 && guard < 8; guard++) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** "A" -> 0; -1 for anything that is not 1-3 letters inside the grid. */
export function columnIndex(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n <= MAX_SHEET_COLUMNS ? n - 1 : -1;
}

const CELL_REF = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/;

/** "B3" or "$B$3" -> { row: 2, col: 1 }; `null` outside the grid. */
export function parseCellRef(ref: string): CellAddress | null {
  const match = CELL_REF.exec(ref);
  if (!match) return null;
  const col = columnIndex(match[1]);
  const row = Number(match[2]) - 1;
  return col < 0 || row >= MAX_SHEET_ROWS ? null : { row, col };
}

export function formatCellRef(row: number, col: number): string {
  return `${columnLetters(col)}${row + 1}`;
}

/** "A1:C3" or a single cell; corners are normalized. */
export function parseCellRange(ref: string): CellRange | null {
  const [a, b, extra] = ref.split(":");
  if (extra !== undefined) return null;
  const first = parseCellRef(a);
  const second = b === undefined ? first : parseCellRef(b);
  if (!first || !second) return null;
  return {
    top: Math.min(first.row, second.row), left: Math.min(first.col, second.col),
    bottom: Math.max(first.row, second.row), right: Math.max(first.col, second.col),
  };
}

export function formatCellRange(range: CellRange): string {
  const start = formatCellRef(range.top, range.left);
  return range.top === range.bottom && range.left === range.right ? start : `${start}:${formatCellRef(range.bottom, range.right)}`;
}

export function rangeContains(range: CellRange, row: number, col: number): boolean {
  return row >= range.top && row <= range.bottom && col >= range.left && col <= range.right;
}
