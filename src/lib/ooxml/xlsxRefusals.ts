import { formatCellRef, MAX_SHEET_ROWS, parseCellRef } from "../cellRef";
import { rowShiftConflict } from "./xlsxFormula";
import { findElement } from "./xlsxText";
import type { SheetIndex } from "./xlsxSheet";
import type { XlsxWorkbook } from "./xlsxWorkbook";
import { escapeRegExp } from "../regex";
import { decodeXmlText, escapeXmlAttribute, findAttributeValue, nextTag } from "./xmlScan";

// Proofs that a structural edit cannot change what other content means.
// Mesa does not rewrite references; when it cannot prove that nothing refers
// to the moved rows or the renamed sheet, it refuses with the reason.

/** Worksheet children that hold no cell references (CT_Worksheet, ECMA-376 Part 1, 18.3.1.99). */
const ROW_SAFE_CHILDREN = new Set([
  "sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "mergeCells", "sheetCalcPr",
  "sheetProtection", "printOptions", "pageMargins", "pageSetup", "headerFooter",
]);

const CHILD_LABEL: Readonly<Record<string, string>> = {
  conditionalFormatting: "conditional formatting", dataValidations: "data validation", hyperlinks: "hyperlinks",
  drawing: "drawings or charts", legacyDrawing: "comments or form controls", legacyDrawingHF: "header pictures",
  tableParts: "tables", autoFilter: "a filter", sortState: "a sort", extLst: "extended features",
  rowBreaks: "page breaks", colBreaks: "page breaks", protectedRanges: "protected ranges", scenarios: "scenarios",
  dataConsolidate: "data consolidation", customSheetViews: "custom views", phoneticPr: "phonetic settings",
  ignoredErrors: "ignored-error ranges", smartTags: "smart tags", cellWatches: "cell watches", oleObjects: "embedded objects",
  controls: "form controls", webPublishItems: "web publishing ranges", picture: "a background picture",
};

/** Package parts that never name a sheet: values, styles, metadata, relationships and binaries. */
function cannotReferToSheets(part: string, workbook: XlsxWorkbook): boolean {
  const lower = part.toLowerCase();
  if (part === workbook.workbookPart || part === workbook.sharedStringsPart || part === workbook.stylesPart || part === workbook.calcChainPart) return true;
  if (lower.endsWith(".rels") || lower === "[content_types].xml" || lower.startsWith("docprops/") || lower.includes("/theme/")) return true;
  if (lower.includes("/printersettings/") || lower.includes("/media/")) return true;
  return !/\.(xml|vml)$/i.test(part);
}

export interface FormulaVisit {
  readonly text: string;
  readonly row: number;
  readonly col: number;
  readonly shared: boolean;
}

/** Every `<f>` element of a worksheet, with its cell. Linear in the cell data. */
export function forEachFormula(index: SheetIndex, visit: (f: FormulaVisit) => string | null): string | null {
  const { xml, pfx } = index;
  let at = index.dataOpenEnd;
  for (let guard = 0; guard <= index.dataClose - index.dataOpenEnd; guard++) {
    const f = findElement(xml, `${pfx}f`, at, index.dataClose);
    if (f < 0) return null;
    const tag = nextTag(xml, f, index.dataClose)!;
    at = tag.end;
    const close = tag.kind === "start" ? xml.indexOf(`</${pfx}f>`, tag.end) : -1;
    const text = close > 0 ? decodeXmlText(xml.slice(tag.end, close)) : "";
    const cellAt = xml.lastIndexOf(`<${pfx}c`, f);
    const cellTag = nextTag(xml, cellAt, f);
    const ref = cellTag ? findAttributeValue(xml, cellTag.attrStart, cellTag.attrEnd, "r") : null;
    const address = ref ? parseCellRef(xml.slice(ref.start, ref.end)) : null;
    const type = findAttributeValue(xml, tag.attrStart, tag.attrEnd, "t");
    const result = visit({ text, row: address?.row ?? -1, col: address?.col ?? -1, shared: !!type && xml.slice(type.start, type.end) === "shared" });
    if (result) return result;
  }
  return null;
}

function nonDataText(index: SheetIndex): string {
  const data = index.children.find((c) => c.name === "sheetData");
  return data ? index.xml.slice(0, data.start) + index.xml.slice(data.end) : index.xml;
}

export interface WorkbookView {
  readonly workbook: XlsxWorkbook;
  readonly sheets: ReadonlyArray<{ name: string; part: string | null; kind: string }>;
  readonly definedNames: ReadonlyArray<{ name: string; text: string }>;
  indexOf(part: string): SheetIndex;
  /** Formulas typed in this session and not yet written into the sheet XML. */
  pendingFormulas(part: string): ReadonlyArray<{ text: string; row: number; col: number }>;
  /** Relationship types from a worksheet part (pivot tables, drawings, tables...). */
  sheetRelationTypes(part: string): readonly string[];
  /** A pending edit replaces this cell, so its stored formula no longer counts. */
  editedCell(part: string, row: number, col: number): boolean;
  /** A pending edit writes a value into the sheet's last possible row. */
  lastRowPending(part: string): boolean;
}

/**
 * Matches the ways a sheet name appears in a reference: `Name!`, `'Name'!`
 * (apostrophes doubled), a whole attribute value such as `sheet="Name"`,
 * and a quoted string that starts with it (as INDIRECT takes), in plain or
 * XML-escaped form, ignoring case.
 */
export function sheetMentionPattern(name: string): RegExp {
  const alternatives: string[] = [];
  for (const form of new Set([name, escapeXmlAttribute(name)])) {
    const plain = escapeRegExp(form);
    const quoted = escapeRegExp(form.replace(/'/g, "''"));
    alternatives.push(`(?:^|[^\\w.])${plain}!`, `'${quoted}'!`, `&apos;${quoted}&apos;!`, `="${plain}"`, `"'?${quoted}'?!`);
  }
  return new RegExp(alternatives.join("|"), "i");
}

function otherPartsMention(view: WorkbookView, name: string): string | null {
  const mention = sheetMentionPattern(name);
  const sheetParts = new Set(view.sheets.map((s) => s.part));
  for (const part of view.workbook.pkg.parts.keys()) {
    if (sheetParts.has(part) || cannotReferToSheets(part, view.workbook)) continue;
    if (mention.test(view.workbook.partText(part))) return `Mesa cannot prove that ${part} does not refer to this sheet`;
  }
  for (const sheet of view.sheets) {
    if (sheet.kind !== "worksheet" || !sheet.part) continue;
    if (mention.test(nonDataText(view.indexOf(sheet.part)))) return `settings on sheet ${sheet.name} may refer to this sheet`;
  }
  return null;
}

function structuralIssue(index: SheetIndex): string | null {
  if (index.structureIssue) return `the sheet's ${index.structureIssue}`;
  if (index.implicitRefs) return "some rows or cells in the sheet have no explicit address";
  const blocked = index.children.find((c) => !ROW_SAFE_CHILDREN.has(c.name));
  if (blocked) return `the sheet has ${CHILD_LABEL[blocked.name] ?? `a ${blocked.name} element`}, whose ranges Mesa does not move`;
  if (index.hasSharedFormulas || index.arrayRanges.length) return "the sheet has shared or array formulas, which Mesa does not move";
  return null;
}

/**
 * Why inserting (or deleting) a row at 0-based `row` of `sheetName` is
 * refused, or `null` when nothing that Mesa keeps unchanged can refer to the
 * moved rows. Pending cell edits need not be written first: a stored formula
 * that an edit replaces is skipped and the pending formulas are checked.
 */
export function rowShiftRefusal(view: WorkbookView, part: string, sheetName: string, row: number, insert: boolean): string | null {
  const index = view.indexOf(part);
  const issue = structuralIssue(index);
  if (issue) return issue;
  const linked = view.sheetRelationTypes(part).find((type) => !/\/printerSettings$/i.test(type));
  if (linked) return `the sheet has a linked ${linked.slice(linked.lastIndexOf("/") + 1)} part, whose position Mesa does not move`;
  const lastRowUsed = (index.rowCount > 0 && index.rowNumbers[index.rowCount - 1] >= MAX_SHEET_ROWS) || view.lastRowPending(part);
  if (insert && lastRowUsed) return "the last row of the sheet is in use";
  const mention = sheetMentionPattern(sheetName);
  for (const sheet of view.sheets) {
    if (sheet.kind !== "worksheet" || !sheet.part) continue;
    const own = sheet.part === part;
    const where = (r: number, c: number) => (r >= 0 ? `${sheet.name}!${formatCellRef(r, c)}` : sheet.name);
    const check = (f: { text: string; row: number; col: number; shared?: boolean }) => {
      if (f.shared && !own && mention.test(f.text)) return `a shared formula in ${where(f.row, f.col)} refers to this sheet`;
      const conflict = rowShiftConflict(f.text, own ? sheetName : sheet.name, sheetName, row);
      return conflict ? `the formula in ${where(f.row, f.col)} would change: ${conflict}` : null;
    };
    const stored = (f: FormulaVisit) => (view.editedCell(sheet.part!, f.row, f.col) ? null : check(f));
    const found = forEachFormula(view.indexOf(sheet.part), stored) ?? view.pendingFormulas(sheet.part).map(check).find(Boolean) ?? null;
    if (found) return found;
  }
  for (const name of view.definedNames) {
    const conflict = rowShiftConflict(name.text, null, sheetName, row);
    if (conflict) return `the defined name ${name.name} would change: ${conflict}`;
  }
  return otherPartsMention(view, sheetName);
}

/** Why renaming `sheetName` is refused, or `null` when no formula, name or other part mentions it. */
export function renameRefusal(view: WorkbookView, sheetName: string): string | null {
  const pattern = sheetMentionPattern(sheetName);
  for (const sheet of view.sheets) {
    if (sheet.kind !== "worksheet" || !sheet.part) continue;
    const mention = (f: { text: string; row: number; col: number }) =>
      pattern.test(f.text) ? `the formula in ${sheet.name}!${formatCellRef(Math.max(0, f.row), Math.max(0, f.col))} may refer to it` : null;
    const found = forEachFormula(view.indexOf(sheet.part), mention) ?? view.pendingFormulas(sheet.part).map(mention).find(Boolean) ?? null;
    if (found) return found;
  }
  const name = view.definedNames.find((n) => pattern.test(n.text));
  if (name) return `the defined name ${name.name} may refer to it`;
  return otherPartsMention(view, sheetName);
}
