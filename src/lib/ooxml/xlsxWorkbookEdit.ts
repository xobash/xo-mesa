import { applySplices } from "./xlsxPatch";
import { findAttributeValue, escapeXmlAttribute, listTopLevel, localName, nextTag, prefixOf, readAttributes } from "./xmlScan";

// Small, targeted edits to workbook-level parts: the calculation flag, the
// calculation chain's references, the sheet list. Each edit inserts,
// replaces or removes one element or attribute and leaves the rest as is.

/** Elements that follow `calcPr` in CT_Workbook (ECMA-376 Part 1, 18.2.27). */
const AFTER_CALC_PR = new Set([
  "oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing",
  "fileRecoveryPr", "webPublishObjects", "extLst",
]);

/**
 * Workbook XML with `fullCalcOnLoad="1"` on `calcPr` (18.2.2), so Excel
 * recalculates every formula on open instead of trusting stale cached values.
 */
export function withFullCalcOnLoad(xml: string): string {
  const { root, rootClose, children } = listTopLevel(xml);
  const prefix = prefixOf(root.qname);
  const calc = children.find((c) => c.name === "calcPr");
  if (calc) {
    const tag = nextTag(xml, calc.start)!;
    const value = findAttributeValue(xml, tag.attrStart, tag.attrEnd, "fullCalcOnLoad");
    if (value) return xml.slice(value.start, value.end) === "1" ? xml : applySplices(xml, [{ start: value.start, end: value.end, text: "1" }]);
    return applySplices(xml, [{ start: tag.attrEnd, end: tag.attrEnd, text: ' fullCalcOnLoad="1"' }]);
  }
  const before = children.find((c) => AFTER_CALC_PR.has(c.name));
  const at = before ? before.start : rootClose;
  return applySplices(xml, [{ start: at, end: at, text: `<${prefix ? `${prefix}:` : ""}calcPr fullCalcOnLoad="1"/>` }]);
}

/** Removes the first top-level child element whose attributes satisfy `match`. */
export function withoutChild(xml: string, element: string, match: (attrs: Map<string, string>) => boolean): string {
  const { children } = listTopLevel(xml);
  for (const child of children) {
    if (child.name !== element) continue;
    const tag = nextTag(xml, child.start)!;
    if (match(readAttributes(xml.slice(tag.attrStart, tag.attrEnd)))) return applySplices(xml, [{ start: child.start, end: child.end, text: "" }]);
  }
  return xml;
}

/** Appends `text` as the last child of the root element. */
export function appendToRoot(xml: string, text: string): string {
  const { rootClose } = listTopLevel(xml);
  return applySplices(xml, [{ start: rootClose, end: rootClose, text }]);
}

/** Excel's sheet-name rules: 1-31 characters, none of `\ / ? * [ ] :`, no edge apostrophe, unique ignoring case. */
export function sheetNameProblem(name: string, others: readonly string[]): string | null {
  if (!name.trim()) return "A sheet name cannot be blank.";
  if (name.length > 31) return "A sheet name can have at most 31 characters.";
  if (/[\\/?*[\]:]/.test(name)) return "A sheet name cannot contain \\ / ? * [ ] or :.";
  if (name.startsWith("'") || name.endsWith("'")) return "A sheet name cannot start or end with an apostrophe.";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return "A sheet name cannot contain control characters.";
  if (name.toLowerCase() === "history") return "Excel reserves the sheet name History.";
  if (others.some((o) => o.toLowerCase() === name.toLowerCase())) return "Another sheet already has that name.";
  return null;
}

function sheetsElement(xml: string) {
  const { children } = listTopLevel(xml);
  return children.find((c) => c.name === "sheets") ?? null;
}

/** Workbook XML with the `index`-th sheet's name replaced. */
export function renameSheetInWorkbook(xml: string, index: number, name: string): string {
  const sheets = sheetsElement(xml);
  if (!sheets) throw new Error("The workbook has no sheet list.");
  let at = sheets.start;
  let seen = -1;
  for (let guard = 0; guard <= sheets.end - sheets.start; guard++) {
    const tag = nextTag(xml, at, sheets.end);
    if (!tag) break;
    at = tag.end;
    if (tag.kind === "end" || localName(tag.qname) !== "sheet" || ++seen !== index) continue;
    const value = findAttributeValue(xml, tag.attrStart, tag.attrEnd, "name");
    if (!value) break;
    return applySplices(xml, [{ start: value.start, end: value.end, text: escapeXmlAttribute(name) }]);
  }
  throw new Error("The sheet was not found in the workbook.");
}

/** Workbook XML with a new `<sheet>` appended to `<sheets>`. */
export function addSheetToWorkbook(xml: string, sheet: { name: string; sheetId: number; relId: string }): string {
  const sheets = sheetsElement(xml);
  if (!sheets) throw new Error("The workbook has no sheet list.");
  const root = listTopLevel(xml).root;
  const rootAttrs = readAttributes(xml.slice(root.attrStart, root.attrEnd));
  const relNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const declared = [...rootAttrs].find(([k, v]) => k.startsWith("xmlns:") && v === relNs)?.[0].slice(6);
  const relPrefix = declared ?? "r";
  const ns = declared ? "" : ` xmlns:r="${relNs}"`;
  const prefix = prefixOf(sheets.qname);
  const p = prefix ? `${prefix}:` : "";
  const text = `<${p}sheet name="${escapeXmlAttribute(sheet.name)}" sheetId="${sheet.sheetId}"${ns} ${relPrefix}:id="${sheet.relId}"/>`;
  const closeAt = xml.lastIndexOf("</", sheets.end - 1);
  if (nextTag(xml, sheets.start)!.kind === "empty") {
    return applySplices(xml, [{ start: sheets.start, end: sheets.end, text: `<${p}sheets>${text}</${p}sheets>` }]);
  }
  return applySplices(xml, [{ start: closeAt, end: closeAt, text }]);
}
