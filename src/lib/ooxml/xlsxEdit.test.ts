import { describe, expect, it } from "vitest";
import { buildPackage } from "./fixtures/ooxmlFixtures";
import {
  chartWorkbookParts, DATA_SHEET, macroWorkbookParts, MAIN_NS, OTHER_SHEET, pivotWorkbookParts, plainSheet,
  signedWorkbookParts, tableWorkbookParts, workbookParts, worksheetXml,
} from "./fixtures/xlsxFixtures";
import { openXlsx } from "./xlsxOpen";
import {
  addSheet, cellEditRefusal, cellView, createDraft, isDraftClean, renameSheet, setCellText,
  XlsxEditRefusal, type XlsxDraft, type XlsxSession,
} from "./xlsxDraft";
import { applySplices, shiftSheetRows } from "./xlsxPatch";
import { shiftRows } from "./xlsxRowShift";
import { indexWorksheet } from "./xlsxSheet";
import { MAX_SHEET_ROWS } from "../cellRef";
import { planXlsxSave, verifyXlsxBytes, writeXlsx } from "./xlsxSave";
import { xmlWellFormedProblem } from "./xmlWellFormed";
import { readZipContainer } from "./zipContainer";

/**
 * EXCEL EDITS CHANGE ONLY WHAT THE USER CHANGED.
 *
 * Mesa patches cells inside the original worksheet XML. Every other part
 * keeps its exact bytes, a no-op save returns the input, and a structural
 * edit Mesa cannot prove safe is refused with a reason.
 */

const SHEET1 = "xl/worksheets/sheet1.xml";
const SHEET2 = "xl/worksheets/sheet2.xml";

function open(parts = workbookParts()) {
  const bytes = buildPackage(parts);
  const opened = openXlsx(bytes);
  return { bytes, ...opened, draft: createDraft(opened.session) };
}

function save(session: XlsxSession, draft: XlsxDraft) {
  const plan = planXlsxSave(session, draft);
  const bytes = writeXlsx(session.pkg.container, plan);
  verifyXlsxBytes(session.pkg.container, plan, bytes);
  return { plan, bytes, reopened: openXlsx(bytes) };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Raw local-record bytes of every entry, keyed by name. */
function rawEntries(bytes: Uint8Array): Map<string, string> {
  const container = readZipContainer(bytes);
  return new Map(container.entries.map((e) => [e.name, Array.from(bytes.subarray(e.localStart, e.localEnd)).join(",")]));
}

describe("xlsx viewer model", () => {
  it("shows strings, numbers through their formats, dates, booleans, errors and formulas", () => {
    const { session, draft } = open();
    const view = (row: number, col: number) => cellView(session, draft, SHEET1, row, col);
    expect(view(0, 0)).toMatchObject({ display: "Name", formula: false });
    expect(view(0, 0).style).toMatchObject({ bold: true, italic: true, fill: "#FFFF00", color: "#C00000", align: "center" });
    expect(view(1, 0).display).toBe("Alice & co"); // rich runs joined, phonetic run skipped
    expect(view(1, 1).display).toBe("25%");
    expect(view(1, 2)).toMatchObject({ display: "2024-01-01", edit: "2024-01-01" });
    expect(view(1, 3)).toMatchObject({ display: "0.5", edit: "=B2*2", formula: true });
    expect(view(2, 0).display).toBe("Inline");
    expect(view(2, 1).display).toBe("TRUE");
    expect(view(2, 3).display).toBe("1,234.50");
    expect(view(3, 0)).toMatchObject({ display: "#DIV/0!", error: true });
    expect(view(3, 1).display).toBe("Total\r");
    expect(view(4, 0)).toMatchObject({ display: "Alice & co!", edit: '=A2&"!"' });
    expect(view(9, 9).display).toBe("");
  });

  it("reads sheet layout: names, merges, frozen rows, column widths and used size", () => {
    const { session } = open();
    expect(session.workbook.sheets.map((s) => [s.name, s.part, s.kind])).toEqual([["Data", SHEET1, "worksheet"], ["Other", SHEET2, "worksheet"]]);
    const index = session.originalIndex(SHEET1);
    expect(index.merges).toEqual([{ top: 3, left: 1, bottom: 3, right: 2 }]);
    expect(index.frozenRows).toBe(1);
    expect(index.columnWidths.get(0)).toBe(20);
    expect([index.usedRows, index.usedColumns]).toEqual([5, 4]);
  });

  it("fills a shared formula from its anchor for display", () => {
    const sheet = worksheetXml(`<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>2</v></c></row>`
      + `<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>4</v></c></row></sheetData>`);
    const { session, draft } = open(workbookParts({ sheets: [{ name: "S", xml: sheet }], calcChain: false }));
    expect(cellView(session, draft, SHEET1, 1, 1).edit).toBe("=A2*2");
    expect(cellEditRefusal(session, draft, SHEET1, 0, 1)).toMatch(/anchor of a shared formula/);
    expect(cellEditRefusal(session, draft, SHEET1, 1, 1)).toBeNull();
  });
});

describe("xlsx save", () => {
  it("returns the original bytes for a draft with no effective change", () => {
    const { session, draft, bytes } = open();
    const same = setCellText(session, draft, SHEET1, 1, 1, "25%");
    expect(same).toBe(draft);
    const back = setCellText(session, setCellText(session, draft, SHEET1, 1, 1, "7"), SHEET1, 1, 1, "0.25");
    expect(isDraftClean(session, back)).toBe(true);
    const plan = planXlsxSave(session, back);
    expect(plan.changes.size).toBe(0);
    expect(writeXlsx(session.pkg.container, plan)).toBe(bytes);
  });

  it("a single value edit changes only that cell's XML and the recalculation flag", () => {
    const { session, draft, bytes } = open();
    const edited = setCellText(session, draft, SHEET1, 1, 1, "30%");
    const { plan, bytes: out, reopened } = save(session, edited);
    expect([...plan.changes.keys()].sort()).toEqual(["xl/workbook.xml", SHEET1]);
    expect(plan.droppedCalcChain).toBe(false);
    const before = rawEntries(bytes);
    const after = rawEntries(out);
    for (const [name, raw] of before) if (!plan.changes.has(name)) expect(after.get(name), name).toBe(raw);
    const oldSheet = text(session.pkg.parts.get(SHEET1)!);
    const newSheet = text(reopened.session.pkg.parts.get(SHEET1)!);
    expect(newSheet).toBe(oldSheet.replace('<c r="B2" s="2"><v>0.25</v></c>', '<c r="B2" s="2"><v>0.3</v></c>'));
    expect(text(reopened.session.pkg.parts.get("xl/workbook.xml")!)).toContain('<calcPr calcId="191029" fullCalcOnLoad="1"/>');
    expect(xmlWellFormedProblem(newSheet)).toBeNull();
    expect(cellView(reopened.session, createDraft(reopened.session), SHEET1, 1, 1).display).toBe("30%");
  });

  it("writes text as an inline string, keeps the style index and never touches shared strings", () => {
    const { session, draft } = open();
    const { plan, reopened } = save(session, setCellText(session, draft, SHEET1, 0, 0, "Full <name> & _x0041_"));
    expect(plan.changes.has("xl/sharedStrings.xml")).toBe(false);
    const sheet = text(reopened.session.pkg.parts.get(SHEET1)!);
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Full &lt;name&gt; &amp; _x005F_x0041_</t></is></c>');
    expect(cellView(reopened.session, createDraft(reopened.session), SHEET1, 0, 0)).toMatchObject({ display: "Full <name> & _x0041_" });
  });

  it("a new formula has no cached value; changing a formula into a value drops the stale calculation chain", () => {
    const { session, draft } = open();
    const formula = save(session, setCellText(session, draft, SHEET1, 1, 3, "=B2*3"));
    expect(text(formula.reopened.session.pkg.parts.get(SHEET1)!)).toContain('<c r="D2"><f>B2*3</f></c>');
    expect(formula.plan.droppedCalcChain).toBe(false);
    const value = save(session, setCellText(session, draft, SHEET1, 1, 3, "5"));
    expect(value.plan.droppedCalcChain).toBe(true);
    const pkg = value.reopened.session.pkg;
    expect(pkg.parts.has("xl/calcChain.xml")).toBe(false);
    expect(text(pkg.parts.get("xl/_rels/workbook.xml.rels")!)).not.toContain("calcChain");
    expect(text(pkg.parts.get("[Content_Types].xml")!)).not.toContain("calcChain");
    expect(text(pkg.parts.get("xl/sharedStrings.xml")!)).toBe(text(session.pkg.parts.get("xl/sharedStrings.xml")!));
  });

  it("adds cells to existing and new rows in order and grows the dimension", () => {
    const { session, draft } = open();
    let next = setCellText(session, draft, SHEET1, 3, 6, "far");
    next = setCellText(session, next, SHEET1, 9, 1, "TRUE");
    next = setCellText(session, next, SHEET1, 6, 0, "2024-02-30"); // not a real date: stays text
    const { reopened } = save(session, next);
    const sheet = text(reopened.session.pkg.parts.get(SHEET1)!);
    expect(sheet).toContain('<dimension ref="A1:G10"/>');
    expect(sheet).toContain('<row r="4">'); // spans no longer cover column G, so it is dropped
    expect(sheet.indexOf('<row r="7">')).toBeGreaterThan(sheet.indexOf('<row r="5"'));
    expect(sheet.indexOf('<row r="10">')).toBeGreaterThan(sheet.indexOf('<row r="7">'));
    const view = (r: number, c: number) => cellView(reopened.session, createDraft(reopened.session), SHEET1, r, c).display;
    expect([view(3, 6), view(9, 1), view(6, 0), view(3, 1)]).toEqual(["far", "TRUE", "2024-02-30", "Total\r"]);
  });

  it("refuses edits it would write wrongly, with a reason", () => {
    const { session, draft } = open(tableWorkbookParts());
    expect(cellEditRefusal(session, draft, SHEET1, 0, 1)).toMatch(/table header/);
    expect(cellEditRefusal(session, draft, SHEET1, 1, 1)).toBeNull();
    const array = worksheetXml(`<sheetData><row r="1"><c r="A1" vm="1"><v>1</v></c><c r="B1"><f t="array" ref="B1:B2">A1:A2*2</f><v>2</v></c></row><row r="2"><c r="B2"><v>4</v></c></row></sheetData>`);
    const other = open(workbookParts({ sheets: [{ name: "S", xml: array }], calcChain: false }));
    expect(cellEditRefusal(other.session, other.draft, SHEET1, 1, 1)).toMatch(/array formula/);
    expect(cellEditRefusal(other.session, other.draft, SHEET1, 0, 0)).toMatch(/rich data/);
    expect(() => setCellText(other.session, other.draft, SHEET1, 1, 1, "3")).toThrow(XlsxEditRefusal);
  });

  it("keeps a UTF-8 byte-order mark and refuses a sheet that is not valid UTF-8", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(plainSheet(2, 2))]);
    const withBom = open(workbookParts({ sheets: [{ name: "S", xml: bom }], calcChain: false }));
    const saved = save(withBom.session, setCellText(withBom.session, withBom.draft, SHEET1, 0, 0, "9")).reopened.session.pkg.parts.get(SHEET1)!;
    expect([...saved.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const latin1 = new TextEncoder().encode(worksheetXml('<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>caf#</t></is></c></row></sheetData>'));
    latin1[latin1.indexOf(0x23)] = 0xe9; // a Latin-1 "é" byte: not UTF-8
    const broken = open(workbookParts({ sheets: [{ name: "S", xml: latin1 }], calcChain: false }));
    expect(cellEditRefusal(broken.session, broken.draft, SHEET1, 0, 0)).toMatch(/not stored as plain UTF-8/);
  });

  it("verification rejects bytes that differ from the plan", () => {
    const { session, draft } = open();
    const plan = planXlsxSave(session, setCellText(session, draft, SHEET1, 1, 1, "1"));
    const other = buildPackage(workbookParts());
    expect(() => verifyXlsxBytes(session.pkg.container, plan, other)).toThrow(/lost the edit/);
  });
});

describe("xlsx rows and sheets", () => {
  const merges = '<mergeCells count="2"><mergeCell ref="A2:B3"/><mergeCell ref="C5:D5"/></mergeCells>';

  it("inserts a row: renumbers rows and cells, moves and grows merges, grows the dimension", () => {
    const { session, draft } = open(workbookParts({ sheets: [{ name: "S", xml: plainSheet(5, 4, merges) }], calcChain: false }));
    const { reopened, plan } = save(session, shiftRows(session, draft, SHEET1, 2, true));
    expect([...plan.changes.keys()]).toEqual([SHEET1]); // no formulas: no recalculation flag
    const sheet = text(reopened.session.pkg.parts.get(SHEET1)!);
    expect(sheet).toContain('<dimension ref="A1:D6"/>');
    expect(sheet).toContain('<row r="4" spans="1:4"><c r="A4"><v>30</v></c>');
    expect(sheet).not.toContain('<row r="3"');
    expect(sheet).toContain('<mergeCell ref="A2:B4"/><mergeCell ref="C6:D6"/>');
  });

  it("deletes a row: removes it, shrinks merges it crossed and drops merges inside it", () => {
    const { session, draft } = open(workbookParts({ sheets: [{ name: "S", xml: plainSheet(5, 4, merges) }], calcChain: false }));
    const sheet = text(save(session, shiftRows(session, draft, SHEET1, 4, false)).reopened.session.pkg.parts.get(SHEET1)!);
    expect(sheet).not.toContain('r="5"');
    expect(sheet).toContain('<mergeCells count="1"><mergeCell ref="A2:B3"/></mergeCells>');
    expect(sheet).toContain('<dimension ref="A1:D4"/>');
  });

  it("writes pending cell edits before moving rows", () => {
    const { session, draft } = open(workbookParts({ sheets: [{ name: "S", xml: plainSheet(3, 2) }], calcChain: false }));
    const moved = shiftRows(session, setCellText(session, draft, SHEET1, 2, 0, "x"), SHEET1, 0, true);
    expect(cellView(session, moved, SHEET1, 3, 0).display).toBe("x");
    expect(text(save(session, moved).reopened.session.pkg.parts.get(SHEET1)!)).toContain('<c r="A4" t="inlineStr">');
  });

  it("refuses row moves that would change a formula, a defined name or a chart, and allows safe ones", () => {
    const { session, draft } = open();
    expect(() => shiftRows(session, draft, SHEET1, 1, true)).toThrow(/formula in Data!D2 would change: it refers to B2/);
    expect(() => shiftRows(session, draft, SHEET2, 0, true)).not.toThrow(); // Data!B2 is unaffected by rows on Other
    const named = open(workbookParts({ sheets: [{ name: "S", xml: plainSheet(5, 2) }], definedNames: '<definedName name="Area">S!$A$4:$B$5</definedName>', calcChain: false }));
    expect(() => shiftRows(named.session, named.draft, SHEET1, 1, true)).toThrow(/defined name Area/);
    expect(() => shiftRows(named.session, named.draft, SHEET1, 5, true)).not.toThrow();
    const chart = open(chartWorkbookParts());
    expect(() => shiftRows(chart.session, chart.draft, SHEET1, 4, true)).toThrow(/drawings or charts/);
    const cf = plainSheet(3, 2, '<conditionalFormatting sqref="A1:A3"><cfRule type="cellIs" priority="1" operator="greaterThan"><formula>5</formula></cfRule></conditionalFormatting>');
    const conditional = open(workbookParts({ sheets: [{ name: "S", xml: cf }], calcChain: false }));
    expect(() => shiftRows(conditional.session, conditional.draft, SHEET1, 0, true)).toThrow(/conditional formatting/);
    const pivot = open(pivotWorkbookParts());
    expect(() => shiftRows(pivot.session, pivot.draft, SHEET2, 0, true)).toThrow(/linked pivotTable part/);
  });

  it("judges pending edits without writing them first: a replaced formula no longer blocks, a typed one does", () => {
    const sheet = worksheetXml(`<dimension ref="A1:B3"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="B2"><f>A3+1</f><v>4</v></c></row><row r="3"><c r="A3"><v>3</v></c></row></sheetData>`);
    const { session, draft } = open(workbookParts({ sheets: [{ name: "S", xml: sheet }], calcChain: false }));
    expect(() => shiftRows(session, draft, SHEET1, 0, true)).toThrow(/formula in S!B2 would change/);
    const replaced = setCellText(session, draft, SHEET1, 1, 1, "9");
    const moved = shiftRows(session, replaced, SHEET1, 0, true);
    expect(cellView(session, moved, SHEET1, 2, 1).display).toBe("9");
    const typed = setCellText(session, replaced, SHEET1, 0, 1, "=A3*2");
    expect(() => shiftRows(session, typed, SHEET1, 0, true)).toThrow(/formula in S!B1 would change/);
    const lastRow = setCellText(session, draft, SHEET1, MAX_SHEET_ROWS - 1, 0, "end");
    expect(() => shiftRows(session, lastRow, SHEET1, 2, true)).toThrow(/last row of the sheet is in use/);
  });

  it("allows a row move below every reference and drops the calculation chain when formulas move", () => {
    const sheet = worksheetXml(`<dimension ref="A1:B3"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><f>A1+1</f><v>2</v></c></row><row r="3"><c r="A3"><v>3</v></c></row></sheetData>`);
    const { session, draft } = open(workbookParts({ sheets: [{ name: "S", xml: sheet }] }));
    const { plan, reopened } = save(session, shiftRows(session, draft, SHEET1, 1, true));
    expect(plan.droppedCalcChain).toBe(true);
    expect(plan.recalc).toBe(true);
    expect(text(reopened.session.pkg.parts.get(SHEET1)!)).toContain('<row r="3"><c r="A3"><f>A1+1</f><v>2</v></c></row><row r="4"><c r="A4">');
  });

  it("renames a sheet only when nothing mentions its name", () => {
    const { session, draft } = open();
    expect(() => renameSheet(session, draft, 0, "Facts")).toThrow(/formula in Other!A1 may refer to it/);
    expect(() => renameSheet(session, draft, 1, "Bad:Name")).toThrow(/cannot contain/);
    expect(() => renameSheet(session, draft, 1, "data")).toThrow(/already has that name/);
    const { plan, reopened } = save(session, renameSheet(session, draft, 1, "Summary & Notes"));
    expect([...plan.changes.keys()]).toEqual(["xl/workbook.xml"]);
    expect(reopened.session.workbook.sheets.map((s) => s.name)).toEqual(["Data", "Summary & Notes"]);
    expect(text(reopened.session.pkg.parts.get("xl/workbook.xml")!)).toContain('name="Summary &amp; Notes"');
  });

  it("adds an empty sheet with its part, relationship and content type, and edits it", () => {
    const { session, draft } = open();
    const added = addSheet(session, draft, "New");
    const part = "xl/worksheets/sheet3.xml";
    const withCell = setCellText(session, added, part, 0, 0, "hello");
    const { plan, reopened } = save(session, withCell);
    expect([...plan.changes.keys()].sort()).toEqual(["[Content_Types].xml", "xl/_rels/workbook.xml.rels", "xl/workbook.xml", part].sort());
    expect(reopened.session.workbook.sheets.map((s) => [s.name, s.part])).toContainEqual(["New", part]);
    expect(cellView(reopened.session, createDraft(reopened.session), part, 0, 0).display).toBe("hello");
    for (const name of plan.changes.keys()) expect(xmlWellFormedProblem(text(reopened.session.pkg.parts.get(name)!)), name).toBeNull();
  });
});

/**
 * A ROW MOVE RENUMBERS EVERY CELL REFERENCE, WHATEVER ITS SPELLING.
 *
 * The usual `<c r="B12"` is renumbered without parsing; every other spelling
 * goes through the reference parser. Both must give the canonical reference
 * and leave all other text as it was.
 */
describe("xlsx row renumbering", () => {
  const sheet = (rows: string, pfx = "", tail = "") => pfx
    ? `<?xml version="1.0"?><x:worksheet xmlns:x="${MAIN_NS}"><x:sheetData>${rows}</x:sheetData>${tail}</x:worksheet>`
    : worksheetXml(`<sheetData>${rows}</sheetData>${tail}`);
  const dataOf = (xml: string) => xml.slice(xml.indexOf("sheetData>") + 10, xml.lastIndexOf("</"));

  it("renumbers plain, unusual and prefixed references alike", () => {
    const rows = `<row r="1"><c r="A1"><v>1</v></c><c r="a1"/><c r="$B$1"/><c s="3" r="C1"/><c  r="D1"/><c r='E1'/><c r="XFD1"/><c r="ZZ1" t="s"><v>0</v></c></row>`
      + `<row r="2"></row><row r="3"/>`
      + `<row r="999999" ht="20"><c r="AB999999" note="x>y &lt;c "><v>2</v></c><c r="AC999999"/></row>`
      + `<row r="1000000"><c r="A1000000"/></row>`;
    const moved = shiftSheetRows(indexWorksheet(sheet(rows)), 0, 1);
    expect(dataOf(moved)).toContain(
      `<row r="2"><c r="A2"><v>1</v></c><c r="A2"/><c r="B2"/><c s="3" r="C2"/><c  r="D2"/><c r='E2'/><c r="XFD2"/><c r="ZZ2" t="s"><v>0</v></c></row>`
      + `<row r="3"></row><row r="4"/>`
      + `<row r="1000000" ht="20"><c r="AB1000000" note="x>y &lt;c "><v>2</v></c><c r="AC1000000"/></row>`
      + `<row r="1000001"><c r="A1000001"/></row>`,
    );
    expect(xmlWellFormedProblem(moved)).toBeNull();
    const prefixed = shiftSheetRows(indexWorksheet(sheet(`<x:row r="4"><x:c r="A4"/><x:cols/><x:c r="b4"/></x:row><x:row r="5"></x:row>`, "x:")), 4, -1);
    expect(prefixed).toContain(`<x:sheetData><x:row r="4"><x:c r="A4"/><x:cols/><x:c r="b4"/></x:row></x:sheetData>`);
  });

  it("deletes a row and renumbers the rows after it, through rows without cells", () => {
    const empty = Array.from({ length: 40 }, (_, i) => `<row r="${i + 2}"></row>`).join("");
    const xml = sheet(`<row r="1"><c r="A1"/></row>${empty}<row r="42"><c r="A42"/><c r="B42"/></row>`, "", `<mergeCells count="1"><mergeCell ref="A42:B42"/></mergeCells>`);
    const moved = shiftSheetRows(indexWorksheet(xml), 0, -1);
    const index = indexWorksheet(moved);
    expect([index.rowCount, index.rowNumbers[0], index.rowNumbers[40]]).toEqual([41, 1, 41]);
    expect(moved).toContain(`<row r="41"><c r="A41"/><c r="B41"/></row></sheetData><mergeCells count="1"><mergeCell ref="A41:B41"/></mergeCells>`);
  });

  it("refuses a reference outside the grid as before", () => {
    expect(() => shiftSheetRows(indexWorksheet(sheet(`<row r="1"><c r="A1"/><c r="ZZZZ1"/></row>`)), 0, 1)).toThrow(TypeError);
  });

  it("reports formulas only when the cell data has one", () => {
    expect(indexWorksheet(sheet(`<row r="1"><c r="A1"><v>1</v></c></row>`, "", `<f>outside</f>`)).hasFormulas).toBe(false);
    expect(indexWorksheet(sheet(`<row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row>`)).hasFormulas).toBe(true);
    expect(indexWorksheet(sheet(`<row r="1"><c r="A1"><foo/></c></row>`)).hasFormulas).toBe(false);
  });

  it("applies splices in start order and keeps the given order at one position", () => {
    const splices = [{ start: 4, end: 5, text: "E" }, { start: 2, end: 2, text: "x" }, { start: 2, end: 2, text: "y" }, { start: 0, end: 1, text: "" }];
    expect(applySplices("abcdef", splices)).toBe("bxycdEf");
    expect(applySplices("abcdef", [...splices].reverse().reverse())).toBe("bxycdEf");
    expect(applySplices("abcdef", [{ start: 1, end: 2, text: "B" }, { start: 3, end: 3, text: "-" }])).toBe("aBc-def");
    expect(() => applySplices("abcdef", [{ start: 3, end: 5, text: "" }, { start: 1, end: 4, text: "" }])).toThrow(/Overlapping/);
    expect(() => applySplices("abcdef", [{ start: 1, end: 4, text: "" }, { start: 3, end: 5, text: "" }])).toThrow(/Overlapping/);
  });
});

describe("xlsx capability gate", () => {
  it("warns for macros, charts and pivot tables, and refuses signed workbooks", () => {
    expect(open(macroWorkbookParts()).warnings.join(" ")).toMatch(/macros/);
    expect(open(chartWorkbookParts()).warnings.join(" ")).toMatch(/charts/);
    expect(open(pivotWorkbookParts()).warnings.join(" ")).toMatch(/pivot tables/);
    const plain = open();
    expect([plain.warnings, plain.refusals]).toEqual([[], []]);
    expect(open(signedWorkbookParts()).refusals.join(" ")).toMatch(/digitally signed/);
  });

  it("keeps unedited parts of a chart workbook byte-identical", () => {
    const { session, draft, bytes } = open(chartWorkbookParts());
    const { plan, bytes: out } = save(session, setCellText(session, draft, SHEET1, 1, 1, "0.5"));
    const before = rawEntries(bytes);
    const after = rawEntries(out);
    expect(after.get("xl/charts/chart1.xml")).toBe(before.get("xl/charts/chart1.xml"));
    expect([...plan.changes.keys()].sort()).toEqual(["xl/workbook.xml", SHEET1]);
  });

  it("reads a prefixed (x:) worksheet and workbook", () => {
    const sheet = DATA_SHEET.replace(`<worksheet xmlns="${MAIN_NS}"`, `<x:worksheet xmlns:x="${MAIN_NS}"`).replace(/<(\/?)(?!\?|x:worksheet)([a-zA-Z])/g, "<$1x:$2").replace("</worksheet>", "</x:worksheet>");
    const { session, draft } = open(workbookParts({ sheets: [{ name: "Data", xml: sheet }, { name: "Other", xml: OTHER_SHEET }] }));
    expect(cellView(session, draft, SHEET1, 1, 3).edit).toBe("=B2*2");
    const { reopened } = save(session, setCellText(session, draft, SHEET1, 6, 0, "p"));
    expect(text(reopened.session.pkg.parts.get(SHEET1)!)).toContain('<x:row r="7"><x:c r="A7" t="inlineStr"><x:is><x:t xml:space="preserve">p</x:t></x:is></x:c></x:row>');
  });
});
