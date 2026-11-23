import { formatCellRange, formatCellRef, MAX_SHEET_COLUMNS, parseCellRange, parseCellRef, type CellRange } from "../cellRef";
import { cellXml, type CellInput } from "./xlsxCells";
import { findRow, readRowCells, type CellRecord, type SheetIndex } from "./xlsxSheet";
import { findElement } from "./xlsxText";
import { findAttributeSpan, findAttributeValue, localName, nextTag } from "./xmlScan";

// Splices edits into worksheet XML. Every byte outside a changed cell, a
// renumbered reference or an updated count stays as it was; nothing is
// re-serialized from a tree.

export interface Splice {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Applies non-overlapping splices; equal starts keep their order. Throws on overlap. */
export function applySplices(source: string, splices: readonly Splice[]): string {
  if (!splices.length) return source;
  const ordered = splices.map((s, i) => ({ s, i })).sort((a, b) => a.s.start - b.s.start || a.i - b.i).map((x) => x.s);
  let out = "";
  let at = 0;
  for (const splice of ordered) {
    if (splice.start < at || splice.end < splice.start) throw new Error("Overlapping worksheet edits.");
    out += source.slice(at, splice.start) + splice.text;
    at = splice.end;
  }
  return out + source.slice(at);
}

/** Map key of a 0-based cell address. */
export function cellKey(row: number, col: number): number {
  return row * MAX_SHEET_COLUMNS + col;
}

export function keyAddress(key: number): { row: number; col: number } {
  return { row: Math.floor(key / MAX_SHEET_COLUMNS), col: key % MAX_SHEET_COLUMNS };
}

function groupByRow(edits: ReadonlyMap<number, CellInput>): Map<number, Array<[number, CellInput]>> {
  const rows = new Map<number, Array<[number, CellInput]>>();
  for (const [key, input] of edits) {
    const { row, col } = keyAddress(key);
    const list = rows.get(row) ?? [];
    list.push([col, input]);
    rows.set(row, list);
  }
  for (const list of rows.values()) list.sort((a, b) => a[0] - b[0]);
  return new Map([...rows.entries()].sort((a, b) => a[0] - b[0]));
}

function spansCover(xml: string, tag: { attrStart: number; attrEnd: number }, cols: readonly number[]): boolean {
  const spans = findAttributeValue(xml, tag.attrStart, tag.attrEnd, "spans");
  if (!spans) return true;
  const match = /^(\d+):(\d+)$/.exec(xml.slice(spans.start, spans.end));
  if (!match) return false;
  return cols.every((c) => c + 1 >= Number(match[1]) && c + 1 <= Number(match[2]));
}

/** Start tag of a row (or sheetData) without its closing `>`/`/>`, dropping `spans` when stale. */
function openTagText(xml: string, start: number, newCols: readonly number[]): { text: string; tagEnd: number; selfClosing: boolean } {
  const tag = nextTag(xml, start)!;
  const spans = newCols.length && !spansCover(xml, tag, newCols) ? findAttributeSpan(xml, tag.attrStart, tag.attrEnd, "spans") : null;
  const head = spans ? xml.slice(start, spans.start) + xml.slice(spans.end, tag.attrEnd) : xml.slice(start, tag.attrEnd);
  return { text: head.replace(/\s+$/, ""), tagEnd: tag.end, selfClosing: tag.kind === "empty" };
}

function patchExistingRow(index: SheetIndex, i: number, edits: Array<[number, CellInput]>, out: Splice[]): void {
  const { xml, pfx } = index;
  const cells = readRowCells(index, i);
  const byCol = new Map<number, CellRecord>(cells.map((c) => [c.col, c]));
  const row = index.rowNumbers[i] - 1;
  const inserts = new Map<number, string>();
  const newCols: number[] = [];
  for (const [col, input] of edits) {
    const cell = byCol.get(col);
    if (cell) { out.push({ start: cell.start, end: cell.end, text: cellXml(index, cell, row, col, input) }); continue; }
    if (input.kind === "empty") continue;
    const before = cells.find((c) => c.col > col);
    const at = before ? before.start : index.rowCloseStart[i];
    inserts.set(at, (inserts.get(at) ?? "") + cellXml(index, undefined, row, col, input));
    newCols.push(col);
  }
  if (!newCols.length) return;
  const open = openTagText(xml, index.rowStart[i], newCols);
  if (open.selfClosing) {
    out.push({ start: index.rowStart[i], end: open.tagEnd, text: `${open.text}>${[...inserts.values()].join("")}</${pfx}row>` });
    return;
  }
  if (open.text !== xml.slice(index.rowStart[i], open.tagEnd - 1).replace(/\s+$/, "")) out.push({ start: index.rowStart[i], end: open.tagEnd, text: `${open.text}>` });
  for (const [at, text] of inserts) out.push({ start: at, end: at, text });
}

function newRowXml(index: SheetIndex, row: number, edits: Array<[number, CellInput]>): string {
  const cells = edits.filter(([, input]) => input.kind !== "empty").map(([col, input]) => cellXml(index, undefined, row, col, input));
  return cells.length ? `<${index.pfx}row r="${row + 1}">${cells.join("")}</${index.pfx}row>` : "";
}

function dimensionSplice(index: SheetIndex, bounds: CellRange | null): Splice | null {
  const dim = index.dimension;
  if (!dim || !bounds) return null;
  const current = dim.range;
  const next = current
    ? { top: Math.min(current.top, bounds.top), left: Math.min(current.left, bounds.left), bottom: Math.max(current.bottom, bounds.bottom), right: Math.max(current.right, bounds.right) }
    : bounds;
  const text = formatCellRange(next);
  return text === index.xml.slice(dim.start, dim.end) ? null : { start: dim.start, end: dim.end, text };
}

function editBounds(edits: ReadonlyMap<number, CellInput>): CellRange | null {
  let bounds: CellRange | null = null;
  for (const [key, input] of edits) {
    if (input.kind === "empty") continue;
    const { row, col } = keyAddress(key);
    bounds = bounds
      ? { top: Math.min(bounds.top, row), left: Math.min(bounds.left, col), bottom: Math.max(bounds.bottom, row), right: Math.max(bounds.right, col) }
      : { top: row, left: col, bottom: row, right: col };
  }
  return bounds;
}

/** Worksheet XML with `edits` written into it. */
export function patchSheetCells(index: SheetIndex, edits: ReadonlyMap<number, CellInput>): string {
  if (!edits.size) return index.xml;
  const out: Splice[] = [];
  const newRows = new Map<number, string>();
  for (const [row, list] of groupByRow(edits)) {
    const i = findRow(index, row + 1);
    if (i >= 0) { patchExistingRow(index, i, list, out); continue; }
    const text = newRowXml(index, row, list);
    if (!text) continue;
    const insertAt = -i - 1;
    const at = insertAt < index.rowCount ? index.rowStart[insertAt] : index.dataClose;
    newRows.set(at, (newRows.get(at) ?? "") + text);
  }
  if (index.dataSelfClosing && newRows.size) {
    const data = index.children.find((c) => c.name === "sheetData")!;
    const open = openTagText(index.xml, data.start, []);
    out.push({ start: data.start, end: data.end, text: `${open.text}>${[...newRows.values()].join("")}</${index.pfx}sheetData>` });
  } else {
    for (const [at, text] of newRows) out.push({ start: at, end: at, text });
  }
  const dimension = dimensionSplice(index, editBounds(edits));
  if (dimension) out.push(dimension);
  return applySplices(index.xml, out);
}

// ---------- row insertion and deletion ----------

function renumberRow(index: SheetIndex, i: number, newRow: number, out: Splice[]): void {
  const { xml, pfx } = index;
  const rowTag = nextTag(xml, index.rowStart[i])!;
  const r = findAttributeValue(xml, rowTag.attrStart, rowTag.attrEnd, "r")!;
  out.push({ start: r.start, end: r.end, text: String(newRow + 1) });
  let at = index.rowOpenEnd[i];
  const to = index.rowCloseStart[i];
  for (let guard = 0; guard <= to - at; guard++) {
    const c = findElement(xml, `${pfx}c`, at, to);
    if (c < 0) break;
    const tag = nextTag(xml, c, to)!;
    const ref = findAttributeValue(xml, tag.attrStart, tag.attrEnd, "r")!;
    const address = parseCellRef(xml.slice(ref.start, ref.end))!;
    out.push({ start: ref.start, end: ref.end, text: formatCellRef(newRow, address.col) });
    at = tag.end;
  }
}

/** Where a range lands after inserting (`delta` 1) or deleting (`delta` -1) row `at`, or `null` when deleted. */
export function shiftRange(range: CellRange, at: number, delta: 1 | -1): CellRange | null {
  if (delta === 1) {
    if (range.bottom < at) return range;
    return { ...range, top: range.top >= at ? range.top + 1 : range.top, bottom: range.bottom + 1 };
  }
  if (range.bottom < at) return range;
  if (range.top > at) return { ...range, top: range.top - 1, bottom: range.bottom - 1 };
  if (range.top === range.bottom) return null;
  return { ...range, bottom: range.bottom - 1 };
}

function shiftMerges(index: SheetIndex, at: number, delta: 1 | -1, out: Splice[]): void {
  const child = index.children.find((c) => c.name === "mergeCells");
  if (!child) return;
  const { xml } = index;
  const kept: Splice[] = [];
  let remaining = 0;
  let pos = child.start;
  let countAttr: { start: number; end: number } | null = null;
  for (let guard = 0; guard <= child.end - child.start; guard++) {
    const tag = nextTag(xml, pos, child.end);
    if (!tag) break;
    pos = tag.end;
    if (tag.kind === "end") continue;
    if (localName(tag.qname) === "mergeCells") { countAttr = findAttributeValue(xml, tag.attrStart, tag.attrEnd, "count"); continue; }
    if (localName(tag.qname) !== "mergeCell") continue;
    const ref = findAttributeValue(xml, tag.attrStart, tag.attrEnd, "ref");
    const range = ref ? parseCellRange(xml.slice(ref.start, ref.end)) : null;
    if (!ref || !range) { remaining++; continue; }
    const next = shiftRange(range, at, delta);
    if (!next) { kept.push({ start: tag.start, end: tag.end, text: "" }); continue; }
    remaining++;
    const text = formatCellRange(next);
    if (text !== xml.slice(ref.start, ref.end)) kept.push({ start: ref.start, end: ref.end, text });
  }
  if (remaining === 0) { out.push({ start: child.start, end: child.end, text: "" }); return; }
  for (const edit of kept) out.push(edit);
  if (countAttr && xml.slice(countAttr.start, countAttr.end) !== String(remaining)) out.push({ ...countAttr, text: String(remaining) });
}

/**
 * Worksheet XML with a row inserted before 0-based `at` (`delta` 1) or row
 * `at` deleted (`delta` -1). Callers must first prove that nothing else
 * refers to the moved rows (`xlsxRefusals.ts`).
 */
export function shiftSheetRows(index: SheetIndex, at: number, delta: 1 | -1): string {
  const out: Splice[] = [];
  for (let i = 0; i < index.rowCount; i++) {
    const row = index.rowNumbers[i] - 1;
    if (row < at) continue;
    if (delta === -1 && row === at) { out.push({ start: index.rowStart[i], end: index.rowEnd[i], text: "" }); continue; }
    renumberRow(index, i, row + delta, out);
  }
  shiftMerges(index, at, delta, out);
  const dim = index.dimension;
  if (dim?.range) {
    const next = shiftRange(dim.range, at, delta) ?? { ...dim.range, bottom: dim.range.top };
    const text = formatCellRange(next);
    if (text !== index.xml.slice(dim.start, dim.end)) out.push({ start: dim.start, end: dim.end, text });
  }
  return applySplices(index.xml, out);
}
