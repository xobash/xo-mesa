import { openOoxmlPackage, relationshipsPartFor, saveOoxmlPackage, type OoxmlPartChanges } from "./ooxmlPackage";
import { storedCellEquals, type CellInput } from "./xlsxCells";
import type { XlsxDraft, XlsxSession } from "./xlsxDraft";
import { keyAddress, patchSheetCells } from "./xlsxPatch";
import { findRow, indexWorksheet, readRowCells } from "./xlsxSheet";
import { encodePartLike, openXlsxWorkbook } from "./xlsxWorkbook";
import { withFullCalcOnLoad, withoutChild } from "./xlsxWorkbookEdit";
import { xmlWellFormedProblem } from "./xmlWellFormed";
import { pdfBytesEqual } from "../pdfBytes";
import { firstAlteredEntry, type ZipContainer } from "./zipContainer";

// Turns a draft into package changes, and checks the written package before
// it replaces the file: every changed part is well-formed XML, every other
// part is byte-identical, and each edited cell reads back as typed.

export interface CellExpectation {
  readonly part: string;
  readonly row: number;
  readonly col: number;
  readonly input: CellInput;
}

export interface XlsxSavePlan {
  readonly changes: OoxmlPartChanges;
  readonly expectations: readonly CellExpectation[];
  /** `fullCalcOnLoad` was set: cached formula results may be stale until Excel recalculates. */
  readonly recalc: boolean;
  /** The calculation chain was removed because formula cells moved, appeared or disappeared. */
  readonly droppedCalcChain: boolean;
  readonly sheetNames: readonly string[];
}

const FORMULA_ELEMENT = /<(?:[A-Za-z_][\w.-]*:)?f[\s/>]/;

function workbookHasFormulas(session: XlsxSession, draft: XlsxDraft): boolean {
  return draft.sheets.some((s) => s.kind === "worksheet" && s.part && !draft.addedParts.has(s.part) && FORMULA_ELEMENT.test(session.workbook.partText(s.part)));
}

interface SheetResult { text: string; formulaLayoutChanged: boolean; formulaEdited: boolean }

function planSheet(session: XlsxSession, draft: XlsxDraft, part: string): SheetResult {
  const sheet = draft.sheetDrafts.get(part)!;
  let formulaLayoutChanged = sheet.movedFormulas;
  let formulaEdited = false;
  for (const [key, input] of sheet.edits) {
    const { row, col } = keyAddress(key);
    const before = session.rowCells(sheet.index, row).get(col);
    const had = !!before?.formula;
    const has = input.kind === "formula";
    if (had !== has) formulaLayoutChanged = true;
    if (has || had) formulaEdited = true;
  }
  return { text: patchSheetCells(sheet.index, sheet.edits), formulaLayoutChanged, formulaEdited };
}

/** The part changes a save would write. Empty changes mean a no-op save. */
export function planXlsxSave(session: XlsxSession, draft: XlsxDraft): XlsxSavePlan {
  const wb = session.workbook;
  const changes = new Map<string, Uint8Array | null>();
  const expectations: CellExpectation[] = [];
  let sheetChanged = false;
  let layoutChanged = false;
  let formulaEdited = false;
  for (const part of draft.sheetDrafts.keys()) {
    const result = planSheet(session, draft, part);
    const added = draft.addedParts.has(part);
    if (added || result.text !== wb.partText(part)) {
      changes.set(part, encodePartLike(added ? undefined : wb.pkg.parts.get(part), result.text));
      sheetChanged = true;
    }
    layoutChanged ||= result.formulaLayoutChanged;
    formulaEdited ||= result.formulaEdited;
    for (const [key, input] of draft.sheetDrafts.get(part)!.edits) expectations.push({ part, ...keyAddress(key), input });
  }
  const recalc = sheetChanged && (formulaEdited || workbookHasFormulas(session, draft));
  const workbookXml = recalc ? withFullCalcOnLoad(draft.workbookXml) : draft.workbookXml;
  if (workbookXml !== wb.workbookXml) changes.set(wb.workbookPart, encodePartLike(wb.pkg.parts.get(wb.workbookPart), workbookXml));
  const relsPart = relationshipsPartFor(wb.workbookPart);
  let relsXml = draft.relsXml;
  let contentTypesXml = draft.contentTypesXml;
  const dropCalcChain = layoutChanged && wb.calcChainPart !== null;
  if (dropCalcChain) {
    const chain = wb.calcChainPart!;
    changes.set(chain, null);
    relsXml = withoutChild(relsXml ?? wb.partText(relsPart), "Relationship", (a) => /\/calcChain$/.test(a.get("Type") ?? ""));
    contentTypesXml = withoutChild(contentTypesXml ?? wb.partText("[Content_Types].xml"), "Override", (a) => (a.get("PartName") ?? "").toLowerCase() === `/${chain}`.toLowerCase());
  }
  if (relsXml !== null && relsXml !== wb.partText(relsPart)) changes.set(relsPart, encodePartLike(wb.pkg.parts.get(relsPart), relsXml));
  if (contentTypesXml !== null && contentTypesXml !== wb.partText("[Content_Types].xml")) {
    changes.set("[Content_Types].xml", encodePartLike(wb.pkg.parts.get("[Content_Types].xml"), contentTypesXml));
  }
  return { changes, expectations, recalc, droppedCalcChain: dropCalcChain, sheetNames: draft.sheets.map((s) => s.name) };
}

/** Writes the package bytes for a plan; returns the original bytes for a no-op plan. */
export function writeXlsx(container: ZipContainer, plan: Pick<XlsxSavePlan, "changes">): Uint8Array {
  return saveOoxmlPackage({ container }, plan.changes);
}

/**
 * Re-opens written bytes through the package layer and checks them against
 * the plan. Throws with the first problem found.
 */
export function verifyXlsxBytes(original: ZipContainer, plan: XlsxSavePlan, candidate: Uint8Array): void {
  const pkg = openOoxmlPackage(candidate);
  const altered = firstAlteredEntry(original, pkg.container, (name) => plan.changes.has(name));
  if (altered !== null) throw new Error(`The saved workbook changed ${altered}, which Mesa did not edit.`);
  for (const [name, bytes] of plan.changes) {
    const written = pkg.parts.get(name);
    if (bytes === null) { if (written) throw new Error(`The saved workbook still has ${name}.`); continue; }
    if (!written || !pdfBytesEqual(written, bytes)) throw new Error(`The saved workbook lost the edit to ${name}.`);
    const problem = xmlWellFormedProblem(new TextDecoder().decode(written));
    if (problem) throw new Error(`The edited part ${name} is not well-formed XML: ${problem}.`);
  }
  const workbook = openXlsxWorkbook(pkg);
  if (workbook.sheets.map((s) => s.name).join("\u0000") !== plan.sheetNames.join("\u0000")) throw new Error("The saved workbook's sheet list does not match the edit.");
  const indexes = new Map<string, ReturnType<typeof indexWorksheet>>();
  for (const expectation of plan.expectations) {
    let index = indexes.get(expectation.part);
    if (!index) { index = indexWorksheet(workbook.partText(expectation.part)); indexes.set(expectation.part, index); }
    const i = findRow(index, expectation.row + 1);
    const cell = i >= 0 ? readRowCells(index, i).find((c) => c.col === expectation.col) : undefined;
    if (!storedCellEquals(workbook, index, cell, expectation.input)) throw new Error("An edited cell does not read back as typed.");
  }
}
