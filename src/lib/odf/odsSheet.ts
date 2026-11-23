import { MAX_SHEET_COLUMNS, MAX_SHEET_ROWS, type CellRange } from "../cellRef";
import { escapeXmlAttribute } from "../ooxml/xmlScan";
import { applySplices, type XmlDoc, type XmlEl, type XmlSplice } from "../pptx/xmlTree";
import { isOdf, lengthToEmu, odfAttr, odfAttrName, odfCount, prefixOfEl, rootPrefix } from "./odfNames";
import type { OdfPackage } from "./odfPackage";
import { readOdfStyles, type OdfStyles } from "./odfStyles";
import { OdfEditRefusal, encodeOdfText, readParagraph } from "./odfText";

// OpenDocument spreadsheets (.ods) as run-length sheet indexes, and cell
// edits as splices of content.xml. A repeated row or cell is split only
// where an edit lands: untouched copies keep their source text with a
// smaller repeat count. Edited formulas are written as `of:` OpenFormula
// without a cached value, so the spreadsheet application recalculates.

export interface OdsCell {
  readonly col: number;
  readonly count: number;
  readonly el: XmlEl;
  readonly covered: boolean;
  readonly display: string;
  readonly edit: string;
  readonly numeric: boolean;
  readonly formula: boolean;
  readonly matrix: boolean;
}

export interface OdsRow { readonly row: number; readonly count: number; readonly el: XmlEl; readonly cells: readonly OdsCell[] }

export interface OdsColumn { readonly col: number; readonly count: number; readonly widthPx: number | null }

export interface OdsSheet {
  readonly name: string;
  readonly el: XmlEl;
  readonly rows: readonly OdsRow[];
  readonly columns: readonly OdsColumn[];
  /** Columns the sheet defines with table:table-column (0 when none). */
  readonly declaredColumns: number;
  readonly usedRows: number;
  readonly usedColumns: number;
  readonly merges: readonly CellRange[];
  readonly protected: boolean;
  readonly hidden: boolean;
}

export interface OdsWorkbook { readonly doc: XmlDoc; readonly sheets: readonly OdsSheet[]; readonly hasFormulas: boolean }

/** Edited cell text keyed by `cellKey`. */
export type OdsEdits = ReadonlyMap<string, string>;

export const cellKey = (sheet: number, row: number, col: number) => `${sheet}:${row}:${col}`;

const VALUE_ATTRS = new Set(["value-type", "value", "date-value", "time-value", "boolean-value", "string-value", "currency", "formula"]);
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const ROW_CONTAINERS = new Set(["table-row-group", "table-header-rows", "table-rows"]);
const COLUMN_CONTAINERS = new Set(["table-column-group", "table-header-columns", "table-columns"]);
const NUMERIC_TYPES = new Set(["float", "percentage", "currency", "date", "time"]);

function cellText(doc: XmlDoc, cell: XmlEl): string {
  return cell.children.filter((c) => isOdf(c, "text", "p")).map((p) => readParagraph(doc, p).plain).join("\n");
}

function editText(cell: XmlEl, display: string): string {
  const formula = odfAttr(cell, "table", "formula");
  if (formula !== null) return formula.startsWith("of:") ? formula.slice(3) : formula;
  const type = odfAttr(cell, "office", "value-type");
  if (type === "float" || type === "percentage" || type === "currency") return odfAttr(cell, "office", "value") ?? display;
  if (type === "date") return odfAttr(cell, "office", "date-value") ?? display;
  if (type === "time") return odfAttr(cell, "office", "time-value") ?? display;
  if (type === "boolean") return (odfAttr(cell, "office", "boolean-value") ?? display).toUpperCase();
  return display;
}

function readCells(doc: XmlDoc, row: XmlEl, merges: CellRange[], rowIndex: number): OdsCell[] {
  const cells: OdsCell[] = [];
  let col = 0;
  for (const el of row.children) {
    const covered = isOdf(el, "table", "covered-table-cell");
    if (!covered && !isOdf(el, "table", "table-cell")) continue;
    if (col >= MAX_SHEET_COLUMNS) break;
    const count = Math.min(odfCount(el, "table", "number-columns-repeated", MAX_SHEET_COLUMNS), MAX_SHEET_COLUMNS - col);
    const display = covered ? "" : cellText(doc, el);
    const spanCols = odfCount(el, "table", "number-columns-spanned", MAX_SHEET_COLUMNS);
    const spanRows = odfCount(el, "table", "number-rows-spanned", MAX_SHEET_ROWS);
    if (!covered && (spanCols > 1 || spanRows > 1)) merges.push({ top: rowIndex, left: col, bottom: rowIndex + spanRows - 1, right: col + spanCols - 1 });
    cells.push({
      col, count, el, covered, display, edit: covered ? "" : editText(el, display),
      numeric: NUMERIC_TYPES.has(odfAttr(el, "office", "value-type") ?? ""), formula: odfAttr(el, "table", "formula") !== null,
      matrix: odfAttr(el, "table", "number-matrix-columns-spanned") !== null,
    });
    col += count;
  }
  return cells;
}

function columnWidthPx(styles: OdfStyles, el: XmlEl): number | null {
  const entry = styles.byKey.get(`table-column:${odfAttr(el, "table", "style-name") ?? ""}`);
  const props = entry?.el.children.find((c) => isOdf(c, "style", "table-column-properties"));
  const emu = lengthToEmu(odfAttr(props, "style", "column-width"));
  return emu ? Math.max(24, Math.round(emu / 9525)) : null;
}

/** Row and column elements of a table in document order, descending into groups. */
function tableParts(table: XmlEl): { rows: XmlEl[]; columns: XmlEl[] } {
  const rows: XmlEl[] = [];
  const columns: XmlEl[] = [];
  const todo = [...table.children].reverse();
  for (let guard = 0; todo.length && guard < 4_000_000; guard++) {
    const el = todo.pop()!;
    if (isOdf(el, "table", "table-row")) rows.push(el);
    else if (isOdf(el, "table", "table-column")) columns.push(el);
    else if (el.ns === table.ns && (ROW_CONTAINERS.has(el.localName) || COLUMN_CONTAINERS.has(el.localName))) for (let i = el.children.length - 1; i >= 0; i--) todo.push(el.children[i]);
  }
  return { rows, columns };
}

function readSheet(doc: XmlDoc, styles: OdfStyles, table: XmlEl): OdsSheet {
  const parts = tableParts(table);
  const columns: OdsColumn[] = [];
  let declared = 0;
  for (const el of parts.columns) {
    if (declared >= MAX_SHEET_COLUMNS) break;
    const count = Math.min(odfCount(el, "table", "number-columns-repeated", MAX_SHEET_COLUMNS), MAX_SHEET_COLUMNS - declared);
    columns.push({ col: declared, count, widthPx: columnWidthPx(styles, el) });
    declared += count;
  }
  const rows: OdsRow[] = [];
  const merges: CellRange[] = [];
  let row = 0;
  let usedRows = 0;
  let usedColumns = 0;
  for (const el of parts.rows) {
    if (row >= MAX_SHEET_ROWS) break;
    const count = Math.min(odfCount(el, "table", "number-rows-repeated", MAX_SHEET_ROWS), MAX_SHEET_ROWS - row);
    const cells = readCells(doc, el, merges, row);
    const filled = cells.filter((c) => c.display || c.formula);
    if (filled.length) {
      usedRows = row + count;
      const last = filled[filled.length - 1];
      usedColumns = Math.max(usedColumns, last.col + last.count);
    }
    rows.push({ row, count, el, cells });
    row += count;
  }
  return {
    name: odfAttr(table, "table", "name") ?? "Sheet", el: table, rows, columns, declaredColumns: declared, usedRows, usedColumns, merges,
    protected: odfAttr(table, "table", "protected") === "true",
    hidden: odfAttr(table, "table", "display") === "false",
  };
}

/** Reads every sheet of a spreadsheet content part. */
export function readOdsWorkbook(doc: XmlDoc, stylesDoc: XmlDoc | null): OdsWorkbook {
  const body = doc.root.children.find((c) => isOdf(c, "office", "body"));
  const spreadsheet = body?.children.find((c) => isOdf(c, "office", "spreadsheet"));
  if (!spreadsheet) throw new OdfEditRefusal("This file has no OpenDocument spreadsheet body.");
  const styles = readOdfStyles(doc, stylesDoc);
  const sheets = spreadsheet.children.filter((c) => isOdf(c, "table", "table")).map((t) => readSheet(doc, styles, t));
  return { doc, sheets, hasFormulas: sheets.some((s) => s.rows.some((r) => r.cells.some((c) => c.formula))) };
}

export function openOdsWorkbook(pkg: OdfPackage): OdsWorkbook {
  return readOdsWorkbook(pkg.content, pkg.styles);
}

function findRun<T extends { readonly count: number }>(runs: readonly T[], at: number, startOf: (run: T) => number): T | null {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = startOf(runs[mid]);
    if (at < start) hi = mid - 1;
    else if (at >= start + runs[mid].count) lo = mid + 1;
    else return runs[mid];
  }
  return null;
}

export function rowAt(sheet: OdsSheet, row: number): OdsRow | null {
  return findRun(sheet.rows, row, (r) => r.row);
}

export function cellAt(sheet: OdsSheet, row: number, col: number): OdsCell | null {
  const r = rowAt(sheet, row);
  return r ? findRun(r.cells, col, (c) => c.col) : null;
}

export function columnWidthAt(sheet: OdsSheet, col: number): number | null {
  return findRun(sheet.columns, col, (c) => c.col)?.widthPx ?? null;
}

/** Why this cell cannot be edited, or `null`. */
export function odsCellRefusal(sheet: OdsSheet, row: number, col: number): string | null {
  if (sheet.protected) return "This sheet is protected.";
  if (row >= MAX_SHEET_ROWS || col >= MAX_SHEET_COLUMNS) return "This cell is outside the sheet.";
  if (sheet.declaredColumns && col >= sheet.declaredColumns) return "This cell is outside the columns this sheet defines.";
  const cell = cellAt(sheet, row, col);
  if (cell?.covered) return "This cell is covered by a merged cell.";
  if (cell?.matrix) return "This cell holds an array formula, which Mesa does not edit.";
  return null;
}

/** Normalizes typed cell text the way it will be stored and read back. */
export function normalizeCellText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

// ---------- writing ----------

interface Prefixes { table: string; office: string; text: string }

function startTag(el: XmlEl, drop: (qname: string) => boolean, extra: string, empty: boolean): string {
  let attrs = "";
  for (const [qname, raw] of el.attrs) if (!drop(qname)) attrs += ` ${qname}="${raw.replace(/"/g, "&quot;")}"`;
  return `<${el.name}${attrs}${extra}${empty ? "/>" : ">"}`;
}

const isEmptyTag = (doc: XmlDoc, el: XmlEl) => el.innerStart === el.end && doc.text[el.end - 2] === "/";

/** The element's source with its repeat attribute set to `count`. */
function withRepeat(doc: XmlDoc, el: XmlEl, local: string, count: number): string {
  const name = odfAttrName(el, "table", local) ?? `${prefixOfEl(el)}:${local}`;
  const extra = count > 1 ? ` ${name}="${count}"` : "";
  const empty = isEmptyTag(doc, el);
  return startTag(el, (q) => q === name, extra, empty) + (empty ? "" : doc.text.slice(el.innerStart, el.end));
}

function localOf(qname: string): string {
  return qname.slice(qname.indexOf(":") + 1);
}

/** A cell holding `text`, keeping the original cell's style, spans and non-paragraph children. */
function buildCell(doc: XmlDoc, original: XmlEl | null, text: string, p: Prefixes): string {
  const value = text.trim();
  let extra = "";
  let paragraphs = "";
  if (value.startsWith("=") && value.length > 1) extra = ` ${p.table}:formula="of:${escapeXmlAttribute(value)}"`;
  else if (NUMBER.test(value)) {
    extra = ` ${p.office}:value-type="float" ${p.office}:value="${escapeXmlAttribute(value.replace(/^\+/, ""))}"`;
    paragraphs = `<${p.text}:p>${encodeOdfText(value, p.text)}</${p.text}:p>`;
  } else if (text) {
    extra = ` ${p.office}:value-type="string"`;
    paragraphs = text.split("\n").map((line) => `<${p.text}:p>${encodeOdfText(line, p.text)}</${p.text}:p>`).join("");
  }
  if (!original) return `<${p.table}:table-cell${extra}${paragraphs ? `>${paragraphs}</${p.table}:table-cell>` : "/>"}`;
  const drop = (qname: string) => VALUE_ATTRS.has(localOf(qname)) || localOf(qname) === "number-columns-repeated";
  const kept = original.children.filter((c) => !isOdf(c, "text", "p")).map((c) => doc.text.slice(c.start, c.end)).join("");
  const inner = kept + paragraphs;
  return startTag(original, drop, extra, !inner) + (inner ? `${inner}</${original.name}>` : "");
}

/** Replacement text for a run of `count` units starting at `start` with edits at `touched`. */
function splitRun(start: number, count: number, touched: readonly number[], copy: (n: number) => string, build: (at: number) => string): string {
  const out: string[] = [];
  let at = start;
  for (const index of touched) {
    if (index > at) out.push(copy(index - at));
    out.push(build(index));
    at = index + 1;
  }
  if (at < start + count) out.push(copy(start + count - at));
  return out.join("");
}

function sortedKeys<T>(map: ReadonlyMap<number, T>): number[] {
  return [...map.keys()].sort((a, b) => a - b);
}

function buildRow(doc: XmlDoc, row: OdsRow | null, edits: ReadonlyMap<number, string>, p: Prefixes): string {
  const cols = sortedKeys(edits);
  if (!row) {
    const inner = splitRun(0, cols[cols.length - 1] + 1, cols, (n) => `<${p.table}:table-cell${n > 1 ? ` ${p.table}:number-columns-repeated="${n}"` : ""}/>`, (c) => buildCell(doc, null, edits.get(c)!, p));
    return `<${p.table}:table-row>${inner}</${p.table}:table-row>`;
  }
  const el = row.el;
  const repeatName = odfAttrName(el, "table", "number-rows-repeated");
  const out: string[] = [startTag(el, (q) => q === repeatName, "", false)];
  let pos = el.innerStart;
  let end = 0;
  for (const cell of row.cells) {
    const hits = cols.filter((c) => c >= cell.col && c < cell.col + cell.count);
    end = cell.col + cell.count;
    if (!hits.length) continue;
    out.push(doc.text.slice(pos, cell.el.start));
    out.push(splitRun(cell.col, cell.count, hits, (n) => withRepeat(doc, cell.el, "number-columns-repeated", n), (c) => buildCell(doc, cell.el, edits.get(c)!, p)));
    pos = cell.el.end;
  }
  const beyond = cols.filter((c) => c >= end);
  const tailStart = isEmptyTag(doc, el) ? el.innerStart : el.innerEnd;
  out.push(doc.text.slice(pos, tailStart));
  if (beyond.length) out.push(splitRun(end, beyond[beyond.length - 1] + 1 - end, beyond, (n) => `<${p.table}:table-cell${n > 1 ? ` ${p.table}:number-columns-repeated="${n}"` : ""}/>`, (c) => buildCell(doc, null, edits.get(c)!, p)));
  out.push(`</${el.name}>`);
  return out.join("");
}

function groupEdits(edits: OdsEdits, sheetCount: number): Map<number, Map<number, Map<number, string>>> {
  const out = new Map<number, Map<number, Map<number, string>>>();
  for (const [key, text] of edits) {
    const [s, r, c] = key.split(":").map(Number);
    if (!(s >= 0 && s < sheetCount) || !Number.isInteger(r) || !Number.isInteger(c)) throw new OdfEditRefusal("An edit points outside the workbook.");
    const rows = out.get(s) ?? new Map<number, Map<number, string>>();
    const cols = rows.get(r) ?? new Map<number, string>();
    cols.set(c, text);
    rows.set(r, cols);
    out.set(s, rows);
  }
  return out;
}

function sheetSplices(doc: XmlDoc, sheet: OdsSheet, rows: ReadonlyMap<number, ReadonlyMap<number, string>>, p: Prefixes): XmlSplice[] {
  const splices: XmlSplice[] = [];
  for (const [row, cols] of rows) for (const col of cols.keys()) {
    const refusal = odsCellRefusal(sheet, row, col);
    if (refusal) throw new OdfEditRefusal(refusal);
  }
  const touched = sortedKeys(rows);
  for (const run of sheet.rows) {
    const hits = touched.filter((r) => r >= run.row && r < run.row + run.count);
    if (!hits.length) continue;
    const text = splitRun(run.row, run.count, hits, (n) => withRepeat(doc, run.el, "number-rows-repeated", n), (r) => buildRow(doc, run, rows.get(r)!, p));
    splices.push({ start: run.el.start, end: run.el.end, text });
  }
  const last = sheet.rows[sheet.rows.length - 1];
  const end = last ? last.row + last.count : 0;
  const beyond = touched.filter((r) => r >= end);
  if (beyond.length) {
    if (!last) throw new OdfEditRefusal("This sheet has no rows Mesa can extend.");
    const text = splitRun(end, beyond[beyond.length - 1] + 1 - end, beyond,
      (n) => `<${p.table}:table-row${n > 1 ? ` ${p.table}:number-rows-repeated="${n}"` : ""}><${p.table}:table-cell/></${p.table}:table-row>`,
      (r) => buildRow(doc, null, rows.get(r)!, p));
    splices.push({ start: last.el.end, end: last.el.end, text });
  }
  return splices;
}

/** Content text with every cell edit applied; the input text when `edits` is empty. */
export function applyOdsEdits(wb: OdsWorkbook, edits: OdsEdits): string {
  if (!edits.size) return wb.doc.text;
  const office = rootPrefix(wb.doc.root, "office");
  const text = rootPrefix(wb.doc.root, "text");
  if (!office || !text) throw new OdfEditRefusal("This workbook does not declare the namespaces Mesa needs to write cells.");
  const splices: XmlSplice[] = [];
  for (const [index, rows] of groupEdits(edits, wb.sheets.length)) {
    const sheet = wb.sheets[index];
    splices.push(...sheetSplices(wb.doc, sheet, rows, { table: prefixOfEl(sheet.el), office, text }));
  }
  return applySplices(wb.doc.text, splices);
}

/** Read-back check: every edited cell holds exactly the text that was typed. */
export function checkOdsEdits(saved: OdsWorkbook, edits: OdsEdits): void {
  for (const [key, typed] of edits) {
    const [s, r, c] = key.split(":").map(Number);
    const sheet = saved.sheets[s];
    const cell = sheet ? cellAt(sheet, r, c) : null;
    const want = NUMBER.test(typed.trim()) ? typed.trim().replace(/^\+/, "") : typed.trim().startsWith("=") && typed.trim().length > 1 ? typed.trim() : typed;
    if ((cell?.edit ?? "") !== want) throw new OdfEditRefusal(`Mesa stopped the save: cell ${key} did not read back as typed.`);
  }
}
