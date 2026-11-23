import { dominantLineBreak, type LineBreak } from "./lineEndings";

/**
 * Editable model of a CSV/TSV file that round-trips byte for byte.
 *
 * A row that nobody edited keeps its exact source text (quoting, spacing and
 * line break). Only a row whose cells changed is written again, with RFC 4180
 * quoting. A quote opens a quoted field only at the start of a field, as in
 * RFC 4180; any other quote is literal text.
 */

/** Line break that ends a row: `""` only for a last row with no final break. */
export type RowBreak = LineBreak | "";

/** `source` row: `table.source.slice(start, end)` is its text without the break. */
export type TableRow =
  | { readonly start: number; readonly end: number; readonly eol: RowBreak; readonly cells?: undefined }
  | { readonly cells: readonly string[]; readonly eol: RowBreak };

export interface DelimitedTable {
  readonly source: string;
  readonly delimiter: string;
  readonly rows: readonly TableRow[];
  /** Widest row, in cells. */
  readonly columns: number;
  /** Break for new rows: the file's most frequent row break. */
  readonly eol: LineBreak;
}

interface RecordEnd {
  /** Index after the last character of the row text. */
  end: number;
  /** Index where the next row starts. */
  next: number;
  eol: RowBreak;
  fields: number;
}

const QUOTE = 34;
const CR = 13;
const LF = 10;

/** Scan one row from `start`. Pushes decoded cells into `cells` when given.
 *  The loop always advances, so it ends after at most `src.length` steps. */
function scanRecord(src: string, start: number, delimiter: number, cells: string[] | null): RecordEnd {
  let i = start;
  let fields = 1;
  let fieldStart = true;
  let inQuotes = false;
  let field = "";
  let runStart = start;
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (inQuotes) {
      if (c !== QUOTE) { i++; continue; }
      if (cells) field += src.slice(runStart, i);
      if (src.charCodeAt(i + 1) === QUOTE) {
        if (cells) field += '"';
        i += 2;
        runStart = i;
        continue;
      }
      inQuotes = false;
      i++;
      runStart = i;
      continue;
    }
    if (c === QUOTE && fieldStart) {
      inQuotes = true;
      fieldStart = false;
      i++;
      runStart = i;
      continue;
    }
    if (c === delimiter) {
      if (cells) { cells.push(field + src.slice(runStart, i)); field = ""; }
      fields++;
      fieldStart = true;
      i++;
      runStart = i;
      continue;
    }
    if (c === LF || c === CR) {
      if (cells) cells.push(field + src.slice(runStart, i));
      const crlf = c === CR && src.charCodeAt(i + 1) === LF;
      return { end: i, next: i + (crlf ? 2 : 1), eol: crlf ? "\r\n" : c === CR ? "\r" : "\n", fields };
    }
    fieldStart = false;
    i++;
  }
  if (cells) cells.push(field + src.slice(runStart, n));
  return { end: n, next: n, eol: "", fields };
}

/** Index every row of `source` in one linear pass, without decoding cells. */
export function scanDelimited(source: string, delimiter: string): DelimitedTable {
  const code = delimiter.charCodeAt(0);
  const rows: TableRow[] = [];
  const breaks: LineBreak[] = [];
  let columns = 0;
  let start = 0;
  while (start < source.length) {
    const record = scanRecord(source, start, code, null);
    rows.push({ start, end: record.end, eol: record.eol });
    if (record.eol) breaks.push(record.eol);
    if (record.fields > columns) columns = record.fields;
    start = record.next;
  }
  return { source, delimiter, rows, columns, eol: dominantLineBreak(breaks) };
}

/** Decoded cells of one row. */
export function rowCells(table: DelimitedTable, index: number): readonly string[] {
  const row = table.rows[index];
  if (!row) return [];
  if (row.cells) return row.cells;
  const cells: string[] = [];
  scanRecord(table.source.slice(row.start, row.end), 0, table.delimiter.charCodeAt(0), cells);
  return cells;
}

/** Parse all rows of delimited text into cells (a final empty line is not a row). */
export function parseDelimitedRows(source: string, delimiter: string): string[][] {
  const table = scanDelimited(source, delimiter);
  return table.rows.map((_, index) => [...rowCells(table, index)]);
}

/** RFC 4180 quoting: quote a field that holds the delimiter, a quote or a line break. */
export function quoteField(value: string, delimiter: string): string {
  if (!value.includes(delimiter) && !/["\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function rowText(table: DelimitedTable, row: TableRow): string {
  if (!row.cells) return table.source.slice(row.start, row.end);
  return row.cells.map((cell) => quoteField(cell, table.delimiter)).join(table.delimiter);
}

/** File text: untouched rows are copied from the source, edited rows are re-quoted. */
export function serializeTable(table: DelimitedTable): string {
  const parts: string[] = new Array(table.rows.length);
  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i];
    parts[i] = rowText(table, row) + row.eol;
  }
  return parts.join("");
}

function withRows(table: DelimitedTable, rows: TableRow[], columns = table.columns): DelimitedTable {
  return { ...table, rows, columns };
}

/** Set one cell. Returns the same table when the value is unchanged. */
export function setCell(table: DelimitedTable, rowIndex: number, column: number, value: string): DelimitedTable {
  const row = table.rows[rowIndex];
  if (!row || column < 0) return table;
  const current = rowCells(table, rowIndex);
  if ((current[column] ?? "") === value && column < current.length) return table;
  if (column >= current.length && value === "") return table;
  const cells = [...current];
  while (cells.length <= column) cells.push("");
  cells[column] = value;
  const rows = [...table.rows];
  rows[rowIndex] = { cells, eol: row.eol };
  return withRows(table, rows, Math.max(table.columns, cells.length));
}

function withBreak(row: TableRow, eol: RowBreak): TableRow {
  return row.cells ? { cells: row.cells, eol } : { start: row.start, end: row.end, eol };
}

/** Insert an empty row before `at` (`at === rows.length` appends). */
export function insertRow(table: DelimitedTable, at: number): DelimitedTable {
  const index = Math.max(0, Math.min(at, table.rows.length));
  const rows = [...table.rows];
  const cells = new Array<string>(Math.max(1, table.columns)).fill("");
  const last = rows[rows.length - 1];
  if (index === rows.length && last && last.eol === "") {
    // Appending after a last row without a final break: that row gains the
    // break and the new last row keeps the file's "no final break" shape.
    rows[rows.length - 1] = withBreak(last, table.eol);
    rows.push({ cells, eol: "" });
  } else {
    rows.splice(index, 0, { cells, eol: table.eol });
  }
  return withRows(table, rows, Math.max(table.columns, cells.length));
}

/** Remove one row. Removing the last row keeps the file's final-break shape. */
export function removeRow(table: DelimitedTable, at: number): DelimitedTable {
  if (at < 0 || at >= table.rows.length) return table;
  const rows = [...table.rows];
  const [removed] = rows.splice(at, 1);
  if (at === rows.length && rows.length > 0) {
    rows[rows.length - 1] = withBreak(rows[rows.length - 1], removed.eol);
  }
  return withRows(table, rows);
}

/** Insert an empty column before `at` in every row that reaches it. */
export function insertColumn(table: DelimitedTable, at: number): DelimitedTable {
  const column = Math.max(0, Math.min(at, table.columns));
  const rows = table.rows.map((row, index) => {
    const cells = [...rowCells(table, index)];
    while (cells.length < column) cells.push("");
    cells.splice(column, 0, "");
    return { cells, eol: row.eol };
  });
  return withRows(table, rows, Math.max(1, table.columns) + (table.columns === 0 ? 0 : 1));
}

/** Remove one column. Rows too short to have it keep their source text. */
export function removeColumn(table: DelimitedTable, at: number): DelimitedTable {
  if (at < 0 || at >= table.columns) return table;
  const rows = table.rows.map((row, index) => {
    const current = rowCells(table, index);
    if (at >= current.length) return row;
    const cells = [...current];
    cells.splice(at, 1);
    return { cells, eol: row.eol };
  });
  return withRows(table, rows, table.columns - 1);
}

const DELIMITER_CANDIDATES = [",", ";", "\t", "|"];
/** Bounded sample for delimiter detection: leading rows of the first 16 KiB. */
const DETECT_PREFIX_CHARS = 16 * 1024;
const DETECT_MAX_ROWS = 20;

/** Rows in the sample whose field count matches the first row's (0 when the
 *  first row has one field). Quoted fields are respected. */
function consistentRows(sample: string, complete: boolean, delimiter: string): number {
  const code = delimiter.charCodeAt(0);
  let start = 0;
  let width = 0;
  let matches = 0;
  for (let row = 0; row < DETECT_MAX_ROWS && start < sample.length; row++) {
    const record = scanRecord(sample, start, code, null);
    // A row cut off by the sample boundary is not evidence.
    if (!complete && record.eol === "") break;
    if (row === 0) width = record.fields;
    if (width < 2) return 0;
    if (record.fields === width) matches++;
    start = record.next;
  }
  return matches;
}

/** The delimiter that splits the leading rows most consistently (comma,
 *  semicolon, tab or pipe). Ties and one-column files keep `fallback`. */
export function detectDelimiter(source: string, fallback: string): string {
  const sample = source.slice(0, DETECT_PREFIX_CHARS);
  const complete = sample.length === source.length;
  let best = fallback;
  let bestScore = consistentRows(sample, complete, fallback);
  for (const candidate of DELIMITER_CANDIDATES) {
    if (candidate === fallback) continue;
    const score = consistentRows(sample, complete, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** The delimiter for a delimited-data extension, or null for other files. */
export function delimiterForExt(ext: string): string | null {
  const lower = ext.toLowerCase();
  if (lower === "csv") return ",";
  if (lower === "tsv") return "\t";
  return null;
}
