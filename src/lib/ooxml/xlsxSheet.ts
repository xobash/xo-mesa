import { parseCellRange, parseCellRef, type CellRange } from "../cellRef";
import { findElement, richText } from "./xlsxText";
import { decodeXmlText, findAttributeValue, listTopLevel, localName, nextTag, prefixOf, readAttributes, type TopLevelElement, type XmlTagAt } from "./xmlScan";
import { OoxmlPackageError } from "./zipContainer";

// Worksheet index (ECMA-376 Part 1, 18.3.1.99 worksheet). Opening a sheet
// records only row positions, in one linear pass; cells are parsed per row
// when a row is shown or edited. The source text is never re-serialized:
// edits splice new text between recorded offsets.

export type TopLevelChild = TopLevelElement;

export interface SheetFormulaAnchor {
  readonly row: number;
  readonly col: number;
  readonly text: string;
}

export interface SheetIndex {
  readonly xml: string;
  /** SpreadsheetML prefix including its colon, or "". */
  readonly pfx: string;
  readonly children: readonly TopLevelChild[];
  /** End of the `<sheetData>` start tag, or of `<sheetData/>`. */
  readonly dataOpenEnd: number;
  readonly dataSelfClosing: boolean;
  /** Start of `</sheetData>`; equals `dataOpenEnd` when self-closing. */
  readonly dataClose: number;
  readonly rowCount: number;
  /** 1-based row numbers, ascending. */
  readonly rowNumbers: Int32Array;
  readonly rowStart: Int32Array;
  readonly rowOpenEnd: Int32Array;
  /** Start of `</row>`; equals `rowOpenEnd` for `<row/>`. */
  readonly rowCloseStart: Int32Array;
  readonly rowEnd: Int32Array;
  /** Used grid size (rows and columns), from the cells and the dimension. */
  readonly usedRows: number;
  readonly usedColumns: number;
  readonly dimension: { readonly start: number; readonly end: number; readonly range: CellRange | null } | null;
  readonly merges: readonly CellRange[];
  readonly frozenRows: number;
  readonly frozenColumns: number;
  /** Column widths in character units, keyed by 0-based column. */
  readonly columnWidths: ReadonlyMap<number, number>;
  readonly defaultColumnWidth: number;
  readonly hasFormulas: boolean;
  readonly sharedFormulas: ReadonlyMap<string, SheetFormulaAnchor>;
  /** Any shared formula, anchor or dependent. */
  readonly hasSharedFormulas: boolean;
  readonly arrayRanges: readonly CellRange[];
  /** Why cells cannot be edited at all, or `null`. */
  readonly structureIssue: string | null;
  /** Rows or cells without an explicit `r` attribute. */
  readonly implicitRefs: boolean;
}

export interface CellFormula {
  readonly text: string;
  readonly type: "normal" | "shared" | "array" | "dataTable";
  readonly ref: string | null;
  readonly si: string | null;
}

export interface CellRecord {
  readonly row: number;
  readonly col: number;
  readonly start: number;
  readonly end: number;
  readonly attrStart: number;
  readonly attrEnd: number;
  readonly style: number;
  /** `t` attribute; "n" when absent. */
  readonly type: string;
  readonly value: string | null;
  readonly formula: CellFormula | null;
  readonly inline: string | null;
  /** `vm`/`cm` metadata or an extension list: content Mesa does not model. */
  readonly opaque: boolean;
}

function fail(message: string): never {
  throw new OoxmlPackageError("malformed", message);
}

function attrValue(xml: string, tag: { attrStart: number; attrEnd: number }, name: string): string | null {
  const at = findAttributeValue(xml, tag.attrStart, tag.attrEnd, name);
  return at ? xml.slice(at.start, at.end) : null;
}

function readTopLevel(xml: string, pfx: string) {
  let dataTag: XmlTagAt | null = null;
  const { children } = listTopLevel(xml, (name, tag) => {
    if (name !== "sheetData") return null;
    dataTag = tag;
    const close = xml.indexOf(`</${pfx}sheetData>`, tag.end);
    if (close < 0) fail("A worksheet has no end of its cell data.");
    return close + pfx.length + 12;
  });
  const empty = children.find((c) => c.name === "sheetData" && !dataTag);
  if (empty) dataTag = nextTag(xml, empty.start);
  return { children, dataTag: dataTag as XmlTagAt | null };
}

interface RowArrays { numbers: number[]; start: number[]; openEnd: number[]; closeStart: number[]; end: number[] }

function lastCellColumn(xml: string, pfx: string, from: number, to: number): number {
  const at = xml.lastIndexOf(`<${pfx}c `, to);
  if (at < from) return -1;
  const tag = nextTag(xml, at, to);
  const ref = tag ? attrValue(xml, tag, "r") : null;
  return ref ? parseCellRef(ref)?.col ?? -1 : -1;
}

function indexRows(xml: string, pfx: string, from: number, to: number) {
  const rows: RowArrays = { numbers: [], start: [], openEnd: [], closeStart: [], end: [] };
  let at = from;
  let previous = 0;
  let maxCol = -1;
  let implicitRefs = false;
  let ordered = true;
  for (let guard = 0; guard <= to - from; guard++) {
    const start = findElement(xml, `${pfx}row`, at, to);
    if (start < 0) break;
    const tag = nextTag(xml, start, to);
    if (!tag) fail("A worksheet row is truncated.");
    const r = attrValue(xml, tag, "r");
    const number = r === null ? previous + 1 : Number(r);
    if (r === null) implicitRefs = true;
    if (!Number.isInteger(number) || number < 1) fail("A worksheet row has an invalid number.");
    if (number <= previous) ordered = false;
    let closeStart = tag.end;
    let end = tag.end;
    if (tag.kind === "start") {
      closeStart = xml.indexOf(`</${pfx}row>`, tag.end);
      if (closeStart < 0 || closeStart > to) fail("A worksheet row is not closed.");
      end = closeStart + pfx.length + 6;
      const col = lastCellColumn(xml, pfx, tag.end, closeStart);
      if (col < 0 && findElement(xml, `${pfx}c`, tag.end, closeStart) >= 0) implicitRefs = true;
      maxCol = Math.max(maxCol, col);
    }
    rows.numbers.push(number);
    rows.start.push(start);
    rows.openEnd.push(tag.end);
    rows.closeStart.push(closeStart);
    rows.end.push(end);
    previous = number;
    at = end;
  }
  return { rows, maxCol, implicitRefs, ordered };
}

function childAttrs(xml: string, child: TopLevelChild | undefined, element: string): Array<Map<string, string>> {
  const out: Array<Map<string, string>> = [];
  if (!child) return out;
  let at = child.start;
  for (let guard = 0; guard <= child.end - child.start; guard++) {
    const tag = nextTag(xml, at, child.end);
    if (!tag) break;
    at = tag.end;
    if (tag.kind !== "end" && localName(tag.qname) === element) out.push(readAttributes(xml.slice(tag.attrStart, tag.attrEnd)));
  }
  return out;
}

function frozenPane(xml: string, children: readonly TopLevelChild[]): { rows: number; cols: number } {
  const pane = childAttrs(xml, children.find((c) => c.name === "sheetViews"), "pane")[0];
  if (!pane || !/^frozen/.test(pane.get("state") ?? "")) return { rows: 0, cols: 0 };
  const whole = (v: string | undefined) => Math.max(0, Math.min(1000, Math.floor(Number(v ?? 0)) || 0));
  return { rows: whole(pane.get("ySplit")), cols: whole(pane.get("xSplit")) };
}

function columnWidths(xml: string, children: readonly TopLevelChild[]): Map<number, number> {
  const widths = new Map<number, number>();
  for (const col of childAttrs(xml, children.find((c) => c.name === "cols"), "col")) {
    const min = Number(col.get("min"));
    const max = Math.min(Number(col.get("max")), min + 255);
    const width = Number(col.get("width"));
    if (!Number.isInteger(min) || !Number.isFinite(width) || min < 1) continue;
    for (let c = min; c <= max; c++) widths.set(c - 1, width);
  }
  return widths;
}

/** Anchors of shared formulas and ranges of array formulas, found by attribute search. */
function formulaAnchors(xml: string, pfx: string, from: number, to: number) {
  const shared = new Map<string, SheetFormulaAnchor>();
  const arrays: CellRange[] = [];
  let at = from;
  let sharedSeen = false;
  for (let guard = 0; guard <= to - from; guard++) {
    const f = findElement(xml, `${pfx}f`, at, to);
    if (f < 0) break;
    const tag = nextTag(xml, f, to);
    if (!tag) break;
    at = tag.end;
    const type = attrValue(xml, tag, "t");
    const ref = attrValue(xml, tag, "ref");
    if (type === "shared") sharedSeen = true;
    if (!ref || (type !== "shared" && type !== "array")) continue;
    const cellAt = xml.lastIndexOf(`<${pfx}c`, f);
    const cellTag = cellAt >= from ? nextTag(xml, cellAt, f) : null;
    const anchor = cellTag ? parseCellRef(attrValue(xml, cellTag, "r") ?? "") : null;
    const range = parseCellRange(ref);
    if (type === "array" && range) arrays.push(range);
    const si = attrValue(xml, tag, "si");
    if (type === "shared" && si !== null && anchor && tag.kind === "start") {
      const close = xml.indexOf(`</${pfx}f>`, tag.end);
      if (close > 0 && close < to) shared.set(si, { ...anchor, text: decodeXmlText(xml.slice(tag.end, close)) });
    }
  }
  return { shared, arrays, sharedSeen };
}

function dimensionOf(xml: string, children: readonly TopLevelChild[]): SheetIndex["dimension"] {
  const child = children.find((c) => c.name === "dimension");
  if (!child) return null;
  const tag = nextTag(xml, child.start, child.end);
  const at = tag ? findAttributeValue(xml, tag.attrStart, tag.attrEnd, "ref") : null;
  return at ? { ...at, range: parseCellRange(xml.slice(at.start, at.end)) } : null;
}

/** Indexes a worksheet part. Throws `OoxmlPackageError` on malformed structure. */
export function indexWorksheet(xml: string): SheetIndex {
  const first = nextTag(xml, 0);
  if (!first || first.kind !== "start" || localName(first.qname) !== "worksheet") fail("This part is not a worksheet.");
  const prefix = prefixOf(first.qname);
  const pfx = prefix ? `${prefix}:` : "";
  const { children, dataTag } = readTopLevel(xml, pfx);
  if (!dataTag) fail("A worksheet has no cell data.");
  const dataSelfClosing = dataTag.kind === "empty";
  const dataOpenEnd = dataTag.end;
  const dataClose = dataSelfClosing ? dataOpenEnd : xml.indexOf(`</${pfx}sheetData>`, dataOpenEnd);
  const { rows, maxCol, implicitRefs, ordered } = indexRows(xml, pfx, dataOpenEnd, dataClose);
  const dimension = dimensionOf(xml, children);
  const anchors = formulaAnchors(xml, pfx, dataOpenEnd, dataClose);
  const frozen = frozenPane(xml, children);
  const markup = /<[!?]/.test(xml.slice(dataOpenEnd, dataClose));
  const mergeChild = children.find((c) => c.name === "mergeCells");
  const merges = childAttrs(xml, mergeChild, "mergeCell").map((m) => parseCellRange(m.get("ref") ?? "")).filter((r): r is CellRange => r !== null);
  const lastRow = rows.numbers.length ? rows.numbers[rows.numbers.length - 1] : 0;
  const formatPr = childAttrs(xml, children.find((c) => c.name === "sheetFormatPr"), "sheetFormatPr")[0];
  return {
    xml, pfx, children, dataOpenEnd, dataSelfClosing, dataClose,
    rowCount: rows.numbers.length,
    rowNumbers: Int32Array.from(rows.numbers), rowStart: Int32Array.from(rows.start), rowOpenEnd: Int32Array.from(rows.openEnd),
    rowCloseStart: Int32Array.from(rows.closeStart), rowEnd: Int32Array.from(rows.end),
    usedRows: Math.max(lastRow, merges.reduce((m, r) => Math.max(m, r.bottom + 1), 0)),
    usedColumns: Math.max(maxCol + 1, merges.reduce((m, r) => Math.max(m, r.right + 1), 0)),
    dimension, merges, frozenRows: frozen.rows, frozenColumns: frozen.cols,
    columnWidths: columnWidths(xml, children),
    defaultColumnWidth: Number(formatPr?.get("defaultColWidth")) || Number(formatPr?.get("baseColWidth")) + 0.71 || 8.43,
    hasFormulas: findElement(xml, `${pfx}f`, dataOpenEnd, dataClose) >= 0,
    sharedFormulas: anchors.shared, hasSharedFormulas: anchors.sharedSeen, arrayRanges: anchors.arrays,
    structureIssue: !ordered ? "its rows are out of order" : markup ? "its cell data contains comments or CDATA sections" : null,
    implicitRefs,
  };
}

/** Index of the row record with 1-based number `rowNumber`, or `-(insertion point) - 1`. */
export function findRow(index: SheetIndex, rowNumber: number): number {
  let lo = 0;
  let hi = index.rowCount - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const n = index.rowNumbers[mid];
    if (n === rowNumber) return mid;
    if (n < rowNumber) lo = mid + 1;
    else hi = mid - 1;
  }
  return -lo - 1;
}

function readCellBody(xml: string, pfx: string, from: number, to: number) {
  let formula: CellFormula | null = null;
  let value: string | null = null;
  let inline: string | null = null;
  const f = findElement(xml, `${pfx}f`, from, to);
  if (f >= 0) {
    const tag = nextTag(xml, f, to)!;
    const close = tag.kind === "start" ? xml.indexOf(`</${pfx}f>`, tag.end) : -1;
    const t = attrValue(xml, tag, "t");
    formula = {
      text: close > 0 ? decodeXmlText(xml.slice(tag.end, close)) : "",
      type: t === "shared" || t === "array" || t === "dataTable" ? t : "normal",
      ref: attrValue(xml, tag, "ref"), si: attrValue(xml, tag, "si"),
    };
  }
  const v = findElement(xml, `${pfx}v`, from, to);
  if (v >= 0) {
    const tag = nextTag(xml, v, to)!;
    const close = tag.kind === "start" ? xml.indexOf(`</${pfx}v>`, tag.end) : -1;
    value = close > 0 ? decodeXmlText(xml.slice(tag.end, close)) : "";
  }
  const is = findElement(xml, `${pfx}is`, from, to);
  if (is >= 0) {
    const close = xml.indexOf(`</${pfx}is>`, is);
    inline = close > 0 ? richText(xml, is, close, pfx) : "";
  }
  return { formula, value, inline, extensions: findElement(xml, `${pfx}extLst`, from, to) >= 0 };
}

/** Cells of row record `i`, in document order. */
export function readRowCells(index: SheetIndex, i: number): CellRecord[] {
  const { xml, pfx } = index;
  const row = index.rowNumbers[i] - 1;
  const to = index.rowCloseStart[i];
  const cells: CellRecord[] = [];
  let at = index.rowOpenEnd[i];
  let col = -1;
  for (let guard = 0; guard <= to - at; guard++) {
    const start = findElement(xml, `${pfx}c`, at, to);
    if (start < 0) break;
    const tag = nextTag(xml, start, to);
    if (!tag) break;
    const ref = attrValue(xml, tag, "r");
    col = ref ? parseCellRef(ref)?.col ?? col + 1 : col + 1;
    const close = tag.kind === "start" ? xml.indexOf(`</${pfx}c>`, tag.end) : -1;
    if (tag.kind === "start" && (close < 0 || close > to)) fail("A worksheet cell is not closed.");
    const end = tag.kind === "start" ? close + pfx.length + 4 : tag.end;
    const body = tag.kind === "start" ? readCellBody(xml, pfx, tag.end, close) : { formula: null, value: null, inline: null, extensions: false };
    cells.push({
      row, col, start, end, attrStart: tag.attrStart, attrEnd: tag.attrEnd,
      style: Number(attrValue(xml, tag, "s") ?? 0) || 0, type: attrValue(xml, tag, "t") ?? "n",
      value: body.value, formula: body.formula, inline: body.inline,
      opaque: body.extensions || attrValue(xml, tag, "vm") !== null || attrValue(xml, tag, "cm") !== null,
    });
    at = end;
  }
  return cells;
}
