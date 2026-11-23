import { columnIndex, columnLetters, MAX_SHEET_COLUMNS, MAX_SHEET_ROWS } from "../cellRef";

// Linear reference scanner for SpreadsheetML formulas (ECMA-376 Part 1,
// 18.17). It does not evaluate anything. It finds A1 references, their sheet
// qualifiers and the functions that build references at run time, so the
// editor can show shared formulas and refuse row moves it cannot prove safe.

export type FormulaRefKind = "cell" | "area" | "rows" | "cols";

export interface FormulaRefPart {
  readonly row: number;
  readonly col: number;
  readonly absRow: boolean;
  readonly absCol: boolean;
}

export interface FormulaRef {
  readonly kind: FormulaRefKind;
  /** Start of the whole token, including any sheet qualifier. */
  readonly start: number;
  /** Start of the reference after the qualifier. */
  readonly refStart: number;
  readonly end: number;
  /** Unquoted sheet name, or `null` for the formula's own sheet. */
  readonly sheet: string | null;
  /** `Sheet1:Sheet3!A1`: spans several sheets. */
  readonly threeD: boolean;
  readonly first: FormulaRefPart;
  /** Same as `first` for a single cell. */
  readonly last: FormulaRefPart;
}

export interface FormulaScan {
  readonly refs: readonly FormulaRef[];
  /** INDIRECT or OFFSET: references the scanner cannot see. */
  readonly dynamicRefs: boolean;
}

const WORD = /[A-Za-z0-9_.$\\?]/;
const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/;
const COLUMN = /^(\$?)([A-Za-z]{1,3})$/;
const ROW = /^(\$?)([0-9]{1,7})$/;
const DYNAMIC_FUNCTIONS = new Set(["INDIRECT", "OFFSET"]);

function readWord(f: string, from: number): number {
  let i = from;
  while (i < f.length && WORD.test(f[i])) i++;
  return i;
}

/** End of a quoted run starting at `from` (the opening quote); doubled quotes are escapes. */
function skipQuoted(f: string, from: number, quote: string): number {
  let i = from + 1;
  for (let guard = 0; guard <= f.length && i < f.length; guard++) {
    const close = f.indexOf(quote, i);
    if (close < 0) return f.length;
    if (f[close + 1] === quote) { i = close + 2; continue; }
    return close + 1;
  }
  return f.length;
}

function skipBrackets(f: string, from: number): number {
  let depth = 0;
  for (let i = from; i < f.length; i++) {
    if (f[i] === "[") depth++;
    else if (f[i] === "]" && --depth === 0) return i + 1;
  }
  return f.length;
}

/** `#REF!`, `#N/A`, `#DIV/0!`, `#NAME?` and the spill marker `A1#`. */
function skipErrorLiteral(f: string, from: number): number {
  let i = from;
  while (i < f.length && /[A-Za-z0-9_/!?]/.test(f[i])) i++;
  return i;
}

type Part = FormulaRefPart & { form: "cell" | "col" | "row" };

function readPart(word: string): Part | null {
  const cell = CELL.exec(word);
  if (cell) {
    const col = columnIndex(cell[2]);
    const row = Number(cell[4]) - 1;
    if (col < 0 || row < 0 || row >= MAX_SHEET_ROWS) return null;
    return { form: "cell", row, col, absCol: cell[1] === "$", absRow: cell[3] === "$" };
  }
  const column = COLUMN.exec(word);
  if (column) {
    const col = columnIndex(column[2]);
    return col < 0 ? null : { form: "col", row: 0, col, absCol: column[1] === "$", absRow: false };
  }
  const row = ROW.exec(word);
  if (row) {
    const n = Number(row[2]) - 1;
    return n < 0 || n >= MAX_SHEET_ROWS ? null : { form: "row", row: n, col: 0, absRow: row[1] === "$", absCol: false };
  }
  return null;
}

interface RefRead { ref: Omit<FormulaRef, "start" | "sheet" | "threeD">; next: number }

/** A reference starting at `from`, or `null` with the scan left to treat the word as a name or number. */
function readReference(f: string, from: number): RefRead | null {
  const firstEnd = readWord(f, from);
  const first = readPart(f.slice(from, firstEnd));
  if (!first) return null;
  if (f[firstEnd] === ":") {
    const secondEnd = readWord(f, firstEnd + 1);
    const second = readPart(f.slice(firstEnd + 1, secondEnd));
    if (second && second.form === first.form) {
      const kind: FormulaRefKind = first.form === "cell" ? "area" : first.form === "col" ? "cols" : "rows";
      return { ref: { kind, refStart: from, end: secondEnd, first, last: second }, next: secondEnd };
    }
  }
  if (first.form !== "cell") return null;
  return { ref: { kind: "cell", refStart: from, end: firstEnd, first, last: first }, next: firstEnd };
}

/** Sheet qualifier at `from` (quoted or bare), returning the name and where the reference starts. */
function readQualifier(f: string, from: number): { sheet: string; threeD: boolean; next: number } | null {
  if (f[from] === "'") {
    const end = skipQuoted(f, from, "'");
    if (f[end] !== "!") return null;
    const sheet = f.slice(from + 1, end - 1).replace(/''/g, "'");
    return { sheet, threeD: sheet.includes(":"), next: end + 1 };
  }
  const end = readWord(f, from);
  if (end === from) return null;
  if (f[end] === "!") return { sheet: f.slice(from, end), threeD: false, next: end + 1 };
  if (f[end] === ":") {
    const second = readWord(f, end + 1);
    if (second > end + 1 && f[second] === "!") return { sheet: f.slice(from, second), threeD: true, next: second + 1 };
  }
  return null;
}

/** Scans a formula (without the leading `=`). Linear in its length. */
export function scanFormula(f: string): FormulaScan {
  const refs: FormulaRef[] = [];
  let dynamicRefs = false;
  let i = 0;
  for (let guard = 0; guard <= f.length && i < f.length; guard++) {
    const ch = f[i];
    if (ch === '"') { i = skipQuoted(f, i, '"'); continue; }
    if (ch === "[") { i = skipBrackets(f, i); continue; }
    if (ch === "#") { i = skipErrorLiteral(f, i + 1); continue; }
    if (ch !== "'" && !WORD.test(ch)) { i++; continue; }
    const start = i;
    const qualifier = readQualifier(f, i);
    const refAt = qualifier ? qualifier.next : i;
    const wordEnd = readWord(f, refAt);
    if (!qualifier && f[wordEnd] === "(") {
      const name = f.slice(refAt, wordEnd).toUpperCase().replace(/^_XLFN\./, "");
      if (DYNAMIC_FUNCTIONS.has(name)) dynamicRefs = true;
      i = wordEnd + 1;
      continue;
    }
    const read = readReference(f, refAt);
    if (read) {
      refs.push({ ...read.ref, start, sheet: qualifier?.sheet ?? null, threeD: qualifier?.threeD ?? false });
      i = read.next;
      continue;
    }
    i = Math.max(wordEnd, refAt + 1);
  }
  return { refs, dynamicRefs };
}

function shiftPart(part: FormulaRefPart, form: FormulaRefKind, dRow: number, dCol: number): FormulaRefPart | null {
  const row = part.absRow || form === "cols" ? part.row : part.row + dRow;
  const col = part.absCol || form === "rows" ? part.col : part.col + dCol;
  if (row < 0 || row >= MAX_SHEET_ROWS || col < 0 || col >= MAX_SHEET_COLUMNS) return null;
  return { ...part, row, col };
}

function partText(part: FormulaRefPart, form: FormulaRefKind): string {
  const col = `${part.absCol ? "$" : ""}${columnLetters(part.col)}`;
  const row = `${part.absRow ? "$" : ""}${part.row + 1}`;
  return form === "cols" ? col : form === "rows" ? row : col + row;
}

/**
 * Moves relative references by `dRow`/`dCol`, as Excel does when it fills a
 * shared formula from its anchor cell (18.3.1.40). A reference pushed off
 * the grid becomes `#REF!`.
 */
export function translateFormula(f: string, dRow: number, dCol: number): string {
  if (dRow === 0 && dCol === 0) return f;
  const { refs } = scanFormula(f);
  let out = "";
  let at = 0;
  for (const ref of refs) {
    const first = shiftPart(ref.first, ref.kind, dRow, dCol);
    const last = shiftPart(ref.last, ref.kind, dRow, dCol);
    out += f.slice(at, ref.refStart);
    if (!first || !last) out += "#REF!";
    else out += ref.kind === "cell" ? partText(first, ref.kind) : `${partText(first, ref.kind)}:${partText(last, ref.kind)}`;
    at = ref.end;
  }
  return out + f.slice(at);
}

/**
 * Why inserting or deleting rows at `fromRow` (0-based) on `targetSheet`
 * would change what this formula means, or `null` when it provably would not.
 * Whole-column references are unaffected; rows above `fromRow` are unaffected.
 */
export function rowShiftConflict(f: string, formulaSheet: string | null, targetSheet: string, fromRow: number): string | null {
  const scan = scanFormula(f);
  const target = targetSheet.toLowerCase();
  for (const ref of scan.refs) {
    const sheet = ref.sheet ?? formulaSheet;
    if (ref.threeD && sheet !== null) return "it uses a reference across several sheets";
    if (sheet === null || sheet.toLowerCase() !== target || ref.kind === "cols") continue;
    if (Math.max(ref.first.row, ref.last.row) >= fromRow) return `it refers to ${f.slice(ref.refStart, ref.end)}`;
  }
  return scan.dynamicRefs ? "it uses INDIRECT or OFFSET, whose references Mesa cannot see" : null;
}
