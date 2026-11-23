import { MAX_SHEET_ROWS, parseCellRange, rangeContains, type CellRange } from "../cellRef";
import { readRelationships, relationshipsPartFor, type OoxmlPackage } from "./ooxmlPackage";
import { parseCellInput, storedCellEquals, styleOf, viewInput, viewStoredCell, type CellInput, type CellView } from "./xlsxCells";
import { cellKey, keyAddress } from "./xlsxPatch";
import { renameRefusal, type WorkbookView } from "./xlsxRefusals";
import { findRow, indexWorksheet, readRowCells, type CellRecord, type SheetIndex } from "./xlsxSheet";
import { workbookRelType, type WorkbookSheet, type XlsxWorkbook } from "./xlsxWorkbook";
import { addSheetToWorkbook, appendToRoot, renameSheetInWorkbook, sheetNameProblem } from "./xlsxWorkbookEdit";
import { decodeXmlPart, findAttributeValue, nextTag } from "./xmlScan";

// The editing session: an immutable draft over the opened workbook. Cell
// edits are kept as a map until save; row moves (`xlsxRowShift.ts`) and sheet
// changes apply to the draft's XML text at once. Undo keeps earlier drafts.

export class XlsxEditRefusal extends Error {}

export interface SheetDraft {
  readonly index: SheetIndex;
  readonly edits: ReadonlyMap<number, CellInput>;
  /** Rows moved on a sheet with formulas: the calculation chain is stale. */
  readonly movedFormulas: boolean;
}

export interface XlsxDraft {
  readonly sheets: readonly WorkbookSheet[];
  readonly sheetDrafts: ReadonlyMap<string, SheetDraft>;
  readonly workbookXml: string;
  /** Changed text of the workbook relationships and content types, else `null`. */
  readonly relsXml: string | null;
  readonly contentTypesXml: string | null;
  readonly addedParts: ReadonlySet<string>;
}

interface TableInfo { readonly range: CellRange; readonly headerRows: number }

const MAX_CACHED_ROWS = 4096;

/** Read-side state shared by every draft of one opened file. */
export class XlsxSession {
  private readonly indexes = new Map<string, SheetIndex>();
  private readonly tables = new Map<string, TableInfo[]>();
  private readonly rows = new WeakMap<SheetIndex, Map<number, Map<number, CellRecord>>>();

  constructor(readonly workbook: XlsxWorkbook) {}

  get pkg(): OoxmlPackage {
    return this.workbook.pkg;
  }

  hasIndex(part: string): boolean {
    return this.indexes.has(part);
  }

  /** Installs an index built elsewhere (the worker) for an original part. */
  adoptIndex(part: string, index: SheetIndex): void {
    this.indexes.set(part, index);
  }

  originalIndex(part: string): SheetIndex {
    let index = this.indexes.get(part);
    if (!index) {
      index = indexWorksheet(this.workbook.partText(part));
      this.indexes.set(part, index);
    }
    return index;
  }

  /** Parsed cells of one row of an index (cached, bounded). */
  rowCells(index: SheetIndex, row: number): ReadonlyMap<number, CellRecord> {
    let cache = this.rows.get(index);
    if (!cache) {
      cache = new Map();
      this.rows.set(index, cache);
    }
    const hit = cache.get(row);
    if (hit) return hit;
    const i = findRow(index, row + 1);
    const cells = new Map<number, CellRecord>(i >= 0 ? readRowCells(index, i).map((c) => [c.col, c]) : []);
    if (cache.size >= MAX_CACHED_ROWS) cache.clear();
    cache.set(row, cells);
    return cells;
  }

  tablesOf(part: string): readonly TableInfo[] {
    let list = this.tables.get(part);
    if (!list) {
      list = readRelationships(this.pkg, part).filter((r) => !r.external && r.type.endsWith("/table") && r.targetPart && this.pkg.parts.has(r.targetPart)).map((r) => {
        const xml = decodeXmlPart(this.pkg.parts.get(r.targetPart!)!);
        const tag = nextTag(xml, 0);
        const ref = tag ? findAttributeValue(xml, tag.attrStart, tag.attrEnd, "ref") : null;
        const header = tag ? findAttributeValue(xml, tag.attrStart, tag.attrEnd, "headerRowCount") : null;
        return { range: parseCellRange(ref ? xml.slice(ref.start, ref.end) : "") ?? { top: -1, left: -1, bottom: -1, right: -1 }, headerRows: header ? Number(xml.slice(header.start, header.end)) : 1 };
      });
      this.tables.set(part, list);
    }
    return list;
  }
}

export function createDraft(session: XlsxSession): XlsxDraft {
  return { sheets: session.workbook.sheets, sheetDrafts: new Map(), workbookXml: session.workbook.workbookXml, relsXml: null, contentTypesXml: null, addedParts: new Set() };
}

export function currentIndex(session: XlsxSession, draft: XlsxDraft, part: string): SheetIndex {
  return draft.sheetDrafts.get(part)?.index ?? session.originalIndex(part);
}

function storedCell(session: XlsxSession, index: SheetIndex, row: number, col: number): CellRecord | undefined {
  return session.rowCells(index, row).get(col);
}

/** What a cell shows now, including unsaved edits. */
export function cellView(session: XlsxSession, draft: XlsxDraft, part: string, row: number, col: number): CellView & { edited: boolean } {
  const index = currentIndex(session, draft, part);
  const cell = storedCell(session, index, row, col);
  const input = draft.sheetDrafts.get(part)?.edits.get(cellKey(row, col));
  if (input) return { ...viewInput(input, styleOf(session.workbook, cell?.style ?? 0), session.workbook), edited: true };
  return { ...viewStoredCell(session.workbook, index, cell), edited: false };
}

/** Why the whole sheet is read-only, or `null`. */
export function sheetEditRefusal(session: XlsxSession, draft: XlsxDraft, part: string): string | null {
  if (session.workbook.strict) return "it uses Strict Open XML, which Mesa only displays";
  if (!draft.addedParts.has(part) && !session.workbook.roundTrips(part)) return "its XML is not stored as plain UTF-8";
  const index = currentIndex(session, draft, part);
  if (index.structureIssue) return index.structureIssue;
  if (index.implicitRefs) return "some rows or cells have no explicit address";
  return null;
}

/** Why one cell cannot be edited, or `null`. */
export function cellEditRefusal(session: XlsxSession, draft: XlsxDraft, part: string, row: number, col: number): string | null {
  const sheet = sheetEditRefusal(session, draft, part);
  if (sheet) return `This sheet is read-only: ${sheet}.`;
  const index = currentIndex(session, draft, part);
  const cell = storedCell(session, index, row, col);
  if (cell?.opaque) return "This cell holds rich data (such as a linked data type or a picture in the cell) that Mesa does not edit.";
  if (index.arrayRanges.some((r) => rangeContains(r, row, col))) return "This cell is part of an array formula. Edit it in Excel.";
  const f = cell?.formula;
  if (f?.type === "dataTable") return "This cell is part of a data table. Edit it in Excel.";
  if (f?.type === "shared" && f.ref && f.ref.includes(":")) return "This cell is the anchor of a shared formula that other cells use. Edit it in Excel.";
  if (!draft.addedParts.has(part) && session.tablesOf(part).some((t) => t.headerRows > 0 && row >= t.range.top && row < t.range.top + t.headerRows && col >= t.range.left && col <= t.range.right)) {
    return "This cell is a table header. Excel requires it to match the table definition, so Mesa does not change it.";
  }
  return null;
}

export function withSheetDraft(draft: XlsxDraft, part: string, next: SheetDraft | null): XlsxDraft {
  const sheetDrafts = new Map(draft.sheetDrafts);
  if (next) sheetDrafts.set(part, next);
  else sheetDrafts.delete(part);
  return { ...draft, sheetDrafts };
}

/** Draft with typed `text` in a cell. Returns the same draft when nothing changes. */
export function setCellText(session: XlsxSession, draft: XlsxDraft, part: string, row: number, col: number, text: string): XlsxDraft {
  const refusal = cellEditRefusal(session, draft, part, row, col);
  if (refusal) throw new XlsxEditRefusal(refusal);
  const index = currentIndex(session, draft, part);
  const cell = storedCell(session, index, row, col);
  const input = parseCellInput(text, styleOf(session.workbook, cell?.style ?? 0), session.workbook.date1904);
  const current = draft.sheetDrafts.get(part);
  const edits = new Map(current?.edits ?? []);
  const key = cellKey(row, col);
  const previous = edits.get(key);
  if (storedCellEquals(session.workbook, index, cell, input)) edits.delete(key);
  else edits.set(key, input);
  const next = edits.get(key);
  if (previous === next || (previous && next && sameInput(previous, next))) return draft;
  const keep = edits.size > 0 || draft.addedParts.has(part) || (!!current && current.index !== session.originalIndex(part));
  return withSheetDraft(draft, part, keep ? { index, edits, movedFormulas: current?.movedFormulas ?? false } : null);
}

function sameInput(a: CellInput, b: CellInput): boolean {
  return a.kind === b.kind && (a.kind === "empty" || (a as { value: unknown }).value === (b as { value: unknown }).value);
}

/** True when the draft would write nothing. */
export function isDraftClean(session: XlsxSession, draft: XlsxDraft): boolean {
  return draft.sheetDrafts.size === 0 && draft.relsXml === null && draft.contentTypesXml === null && draft.workbookXml === session.workbook.workbookXml;
}

export function viewOf(session: XlsxSession, draft: XlsxDraft): WorkbookView {
  return {
    workbook: session.workbook,
    sheets: draft.sheets.map((s) => ({ name: s.name, part: s.part, kind: s.kind })),
    definedNames: session.workbook.definedNames,
    indexOf: (part) => currentIndex(session, draft, part),
    pendingFormulas: (part) => [...(draft.sheetDrafts.get(part)?.edits ?? [])]
      .filter(([, input]) => input.kind === "formula")
      .map(([key, input]) => ({ ...keyAddress(key), text: (input as { value: string }).value })),
    sheetRelationTypes: (part) => (draft.addedParts.has(part) ? [] : readRelationships(session.pkg, part).map((r) => r.type)),
    editedCell: (part, row, col) => draft.sheetDrafts.get(part)?.edits.has(cellKey(row, col)) ?? false,
    lastRowPending: (part) => [...(draft.sheetDrafts.get(part)?.edits ?? [])].some(([key, input]) => input.kind !== "empty" && keyAddress(key).row >= MAX_SHEET_ROWS - 1),
  };
}

export function sheetNamed(draft: XlsxDraft, part: string): WorkbookSheet {
  const sheet = draft.sheets.find((s) => s.part === part);
  if (!sheet) throw new XlsxEditRefusal("The sheet is no longer in the workbook.");
  return sheet;
}

/** Draft with sheet `position` renamed. */
export function renameSheet(session: XlsxSession, draft: XlsxDraft, position: number, name: string): XlsxDraft {
  const sheet = draft.sheets[position];
  if (!sheet) throw new XlsxEditRefusal("The sheet is no longer in the workbook.");
  if (name === sheet.name) return draft;
  const problem = sheetNameProblem(name, draft.sheets.filter((_, i) => i !== position).map((s) => s.name));
  if (problem) throw new XlsxEditRefusal(problem);
  if (session.workbook.strict) throw new XlsxEditRefusal("This workbook uses Strict Open XML, which Mesa only displays.");
  if (!draft.addedParts.has(sheet.part ?? "")) {
    const refusal = renameRefusal(viewOf(session, draft), sheet.name);
    if (refusal) throw new XlsxEditRefusal(`Mesa cannot rename this sheet because ${refusal}. Rename it in Excel, which updates references.`);
  }
  return {
    ...draft,
    workbookXml: renameSheetInWorkbook(draft.workbookXml, position, name),
    sheets: draft.sheets.map((s, i) => (i === position ? { ...s, name } : s)),
  };
}

const NEW_SHEET_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
const WORKSHEET_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";

function freePartName(session: XlsxSession, draft: XlsxDraft, dir: string): string {
  const taken = new Set([...session.pkg.parts.keys(), ...draft.addedParts].map((p) => p.toLowerCase()));
  for (let n = 1; n <= 10_000; n++) {
    const name = `${dir}worksheets/sheet${n}.xml`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  throw new XlsxEditRefusal("The workbook has too many sheets.");
}

function freeRelId(relsXml: string): string {
  const used = new Set([...relsXml.matchAll(/\bId="([^"]*)"/g)].map((m) => m[1]));
  for (let n = 1; n <= 100_000; n++) if (!used.has(`rId${n}`)) return `rId${n}`;
  throw new XlsxEditRefusal("The workbook has too many relationships.");
}

/** Draft with a new, empty worksheet appended. */
export function addSheet(session: XlsxSession, draft: XlsxDraft, name: string): XlsxDraft {
  const problem = sheetNameProblem(name, draft.sheets.map((s) => s.name));
  if (problem) throw new XlsxEditRefusal(problem);
  const wb = session.workbook;
  if (wb.strict) throw new XlsxEditRefusal("This workbook uses Strict Open XML, which Mesa only displays.");
  const relsPart = relationshipsPartFor(wb.workbookPart);
  if (!session.pkg.parts.has(relsPart) || !wb.roundTrips(relsPart) || !wb.roundTrips("[Content_Types].xml") || !wb.roundTrips(wb.workbookPart)) {
    throw new XlsxEditRefusal("Mesa cannot add a sheet: a workbook part is not stored as plain UTF-8.");
  }
  const dir = wb.workbookPart.slice(0, wb.workbookPart.lastIndexOf("/") + 1);
  const part = freePartName(session, draft, dir);
  const relsXml = draft.relsXml ?? wb.partText(relsPart);
  const relId = freeRelId(relsXml);
  const sheetId = draft.sheets.reduce((max, s) => Math.max(max, Number(s.sheetId) || 0), 0) + 1;
  const contentTypes = draft.contentTypesXml ?? wb.partText("[Content_Types].xml");
  const index = indexWorksheet(NEW_SHEET_XML);
  return {
    ...draft,
    sheets: [...draft.sheets, { name, sheetId: String(sheetId), relId, part, kind: "worksheet", state: "visible" }],
    workbookXml: addSheetToWorkbook(draft.workbookXml, { name, sheetId, relId }),
    relsXml: appendToRoot(relsXml, `<Relationship Id="${relId}" Type="${workbookRelType("worksheet")}" Target="${part.slice(dir.length)}"/>`),
    contentTypesXml: appendToRoot(contentTypes, `<Override PartName="/${part}" ContentType="${WORKSHEET_TYPE}"/>`),
    addedParts: new Set([...draft.addedParts, part]),
    sheetDrafts: new Map([...draft.sheetDrafts, [part, { index, edits: new Map(), movedFormulas: false }]]),
  };
}

/** Number of edited cells not yet saved, for status text. */
