import { formatCellRef } from "../cellRef";
import { translateFormula } from "./xlsxFormula";
import { formatNumber, utcMsToSerial, serialToUtcMs } from "./xlsxNumberFormat";
import type { CellRecord, SheetIndex } from "./xlsxSheet";
import { DEFAULT_CELL_STYLE, type CellStyle } from "./xlsxStyles";
import { encodeSpreadsheetText } from "./xlsxText";
import type { XlsxWorkbook } from "./xlsxWorkbook";
import { escapeXmlText, findAttributeSpan } from "./xmlScan";

// Cell values: how a stored cell displays, what the editor shows for it,
// how typed input becomes a value (ECMA-376 Part 1, 18.3.1.4 c, 18.18.11
// ST_CellType) and the XML Mesa writes for an edited cell.

export type CellInput =
  | { readonly kind: "empty" }
  | { readonly kind: "number"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "formula"; readonly value: string };

export interface CellView {
  readonly display: string;
  /** Text for the formula bar and the cell editor. */
  readonly edit: string;
  readonly formula: boolean;
  readonly style: CellStyle;
  readonly error: boolean;
  /** A number (or date): Excel right-aligns these unless the style says otherwise. */
  readonly numeric: boolean;
}

const EMPTY_VIEW: CellView = { display: "", edit: "", formula: false, style: DEFAULT_CELL_STYLE, error: false, numeric: false };

export function styleOf(workbook: XlsxWorkbook, index: number): CellStyle {
  return workbook.styles()[index] ?? DEFAULT_CELL_STYLE;
}

/** Formula text of a cell, filling a shared formula from its anchor (18.3.1.40). */
export function formulaText(index: SheetIndex, cell: CellRecord): string | null {
  const f = cell.formula;
  if (!f) return null;
  if (f.type !== "shared" || f.text || f.si === null) return f.text;
  const anchor = index.sharedFormulas.get(f.si);
  return anchor ? translateFormula(anchor.text, cell.row - anchor.row, cell.col - anchor.col) : null;
}

function isoDateText(serial: number, workbook: XlsxWorkbook, style: CellStyle): string | null {
  if (style.numberFormat.kind !== "date") return null;
  const ms = serialToUtcMs(serial, workbook.date1904);
  if (ms === null) return null;
  const iso = new Date(Math.round(ms / 1000) * 1000).toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19);
  if (!style.numberFormat.hasDate) return time;
  return style.numberFormat.hasTime || time !== "00:00:00" ? `${date} ${time}` : date;
}

/** Text typed into a cell that would read back as something else gets a leading apostrophe. */
function protectText(text: string): string {
  return /^[=']/.test(text) || parseNumber(text) !== null || /^(true|false)$/i.test(text) ? `'${text}` : text;
}

/** How a stored cell shows in the grid and in the formula bar. */
export function viewStoredCell(workbook: XlsxWorkbook, index: SheetIndex, cell: CellRecord | undefined): CellView {
  if (!cell) return EMPTY_VIEW;
  const style = styleOf(workbook, cell.style);
  const formula = formulaText(index, cell);
  const raw = cell.value ?? "";
  let display = raw;
  let edit = raw;
  let error = false;
  if (cell.type === "s") {
    display = workbook.sharedStrings()[Number(raw)] ?? "";
    edit = protectText(display);
  } else if (cell.type === "inlineStr") {
    display = cell.inline ?? raw;
    edit = protectText(display);
  } else if (cell.type === "str") {
    edit = protectText(raw);
  } else if (cell.type === "b") {
    display = raw === "1" || raw === "true" ? "TRUE" : "FALSE";
    edit = display;
  } else if (cell.type === "e") {
    error = true;
  } else if (cell.type === "n" && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      display = formatNumber(n, style.numberFormat, workbook.date1904);
      edit = isoDateText(n, workbook, style) ?? String(n);
    }
  }
  const numeric = cell.type === "n" && raw !== "";
  if (formula !== null) return { display, edit: `=${formula}`, formula: true, style, error, numeric };
  return { display, edit, formula: false, style, error, numeric };
}

/** How a pending edit shows before it is saved. A new formula has no computed value yet. */
export function viewInput(input: CellInput, style: CellStyle, workbook: XlsxWorkbook): CellView {
  switch (input.kind) {
    case "empty": return { ...EMPTY_VIEW, style };
    case "bool": return { display: input.value ? "TRUE" : "FALSE", edit: input.value ? "TRUE" : "FALSE", formula: false, style, error: false, numeric: false };
    case "text": return { display: input.value, edit: protectText(input.value), formula: false, style, error: false, numeric: false };
    case "formula": return { display: `=${input.value}`, edit: `=${input.value}`, formula: true, style, error: false, numeric: false };
    case "number": {
      const n = Number(input.value);
      return {
        display: formatNumber(n, style.numberFormat, workbook.date1904),
        edit: isoDateText(n, workbook, style) ?? input.value, formula: false, style, error: false, numeric: true,
      };
    }
  }
}

function parseNumber(text: string): string | null {
  const trimmed = text.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?%?$/.test(trimmed)) return null;
  const percent = trimmed.endsWith("%");
  const n = Number(percent ? trimmed.slice(0, -1) : trimmed);
  if (!Number.isFinite(n)) return null;
  return percent ? formatPercentValue(n) : String(n);
}

/** `12.5%` -> 0.125 without binary noise from the division. */
function formatPercentValue(n: number): string {
  return String(Number((n / 100).toPrecision(15)));
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

function parseDate(text: string, date1904: boolean): string | null {
  const m = ISO_DATE.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h = "0", mi = "0", s = "0"] = m.slice(1);
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const check = new Date(ms);
  if (check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d)) return null;
  const serial = utcMsToSerial(ms, date1904);
  return serial < 0 ? null : String(Number(serial.toPrecision(15)));
}

/** Classifies typed text: `=` formula, `'` forced text, TRUE/FALSE, numbers, ISO dates in date-formatted cells. */
export function parseCellInput(text: string, style: CellStyle, date1904: boolean): CellInput {
  if (text === "") return { kind: "empty" };
  if (text.startsWith("'")) return { kind: "text", value: text.slice(1) };
  if (text.startsWith("=") && text.length > 1) return { kind: "formula", value: text.slice(1) };
  if (/^(true|false)$/i.test(text.trim())) return { kind: "bool", value: /^true$/i.test(text.trim()) };
  const number = parseNumber(text);
  if (number !== null) return { kind: "number", value: number };
  if (style.numberFormat.kind === "date") {
    const serial = parseDate(text, date1904);
    if (serial !== null) return { kind: "number", value: serial };
  }
  return { kind: "text", value: text };
}

/** True when the stored cell already holds exactly this input. */
export function storedCellEquals(workbook: XlsxWorkbook, index: SheetIndex, cell: CellRecord | undefined, input: CellInput): boolean {
  const empty = !cell || (cell.value === null && cell.formula === null && cell.inline === null);
  if (input.kind === "empty") return empty;
  if (!cell || empty) return false;
  if (input.kind === "formula") return cell.formula !== null && formulaText(index, cell) === input.value && cell.formula.type === "normal";
  if (cell.formula) return false;
  if (input.kind === "number") return cell.type === "n" && Number(cell.value) === Number(input.value);
  if (input.kind === "bool") return cell.type === "b" && (cell.value === "1") === input.value;
  if (cell.type === "s") return workbook.sharedStrings()[Number(cell.value)] === input.value;
  if (cell.type === "inlineStr") return cell.inline === input.value;
  return cell.type === "str" && cell.value === input.value;
}

/** Start-tag attributes for an edited cell: the original's minus `t`, or a new `r`. */
function cellAttributes(xml: string, cell: CellRecord | undefined, row: number, col: number): string {
  if (!cell) return ` r="${formatCellRef(row, col)}"`;
  const t = findAttributeSpan(xml, cell.attrStart, cell.attrEnd, "t");
  const attrs = t ? xml.slice(cell.attrStart, t.start) + xml.slice(t.end, cell.attrEnd) : xml.slice(cell.attrStart, cell.attrEnd);
  return attrs.replace(/\s+$/, "");
}

/**
 * XML for a cell after an edit. Text is written as an inline string, so the
 * shared-string part never changes; the style index `s` is kept; a formula
 * is written without a cached value, so no stale result is stored.
 */
export function cellXml(index: SheetIndex, cell: CellRecord | undefined, row: number, col: number, input: CellInput): string {
  const p = index.pfx;
  const attrs = cellAttributes(index.xml, cell, row, col);
  switch (input.kind) {
    case "empty": return `<${p}c${attrs}/>`;
    case "number": return `<${p}c${attrs}><${p}v>${input.value}</${p}v></${p}c>`;
    case "bool": return `<${p}c${attrs} t="b"><${p}v>${input.value ? 1 : 0}</${p}v></${p}c>`;
    case "formula": return `<${p}c${attrs}><${p}f>${escapeXmlText(input.value)}</${p}f></${p}c>`;
    case "text": return `<${p}c${attrs} t="inlineStr"><${p}is><${p}t xml:space="preserve">${encodeSpreadsheetText(input.value)}</${p}t></${p}is></${p}c>`;
  }
}
