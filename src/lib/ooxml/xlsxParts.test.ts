import { describe, expect, it } from "vitest";
import { buildPackage } from "./fixtures/ooxmlFixtures";
import { plainSheet, workbookParts, worksheetXml } from "./fixtures/xlsxFixtures";
import { rowShiftConflict, scanFormula, translateFormula } from "./xlsxFormula";
import { compileNumberFormat, formatGeneral, formatNumber } from "./xlsxNumberFormat";
import { sheetMentionPattern } from "./xlsxRefusals";
import { indexWorksheet, readRowCells } from "./xlsxSheet";
import { decodeSpreadsheetText, encodeSpreadsheetText } from "./xlsxText";
import { openXlsx } from "./xlsxOpen";
import { cellView, createDraft, setCellText } from "./xlsxDraft";
import { applyRowShift, prepareRowShift, shiftRows } from "./xlsxRowShift";
import { planXlsxSave } from "./xlsxSave";
import { createXlsxWorkerClient } from "./xlsxWorkerClient";
import { xmlWellFormedProblem } from "./xmlWellFormed";

describe("formula references", () => {
  it("finds cell, area, row and column references with sheet qualifiers, ignoring strings", () => {
    const scan = scanFormula(`SUM(A1:B$2)+'My ''Sheet'!C3+Other!4:5+D:D+"A9"+LOG10(E5)+Name1`);
    expect(scan.refs.map((r) => [r.kind, r.sheet, r.first.row, r.last.row])).toEqual([
      ["area", null, 0, 1], ["cell", "My 'Sheet", 2, 2], ["rows", "Other", 3, 4], ["cols", null, 0, 0], ["cell", null, 4, 4],
    ]);
    expect(scanFormula("INDIRECT(A1)").dynamicRefs).toBe(true);
  });

  it("translates relative parts only, and pushes references off the grid to #REF!", () => {
    expect(translateFormula("A1*$B$1+C$1+$D1+SUM(E:E)", 2, 1)).toBe("B3*$B$1+D$1+$D3+SUM(F:F)");
    expect(translateFormula("A1", -1, 0)).toBe("#REF!");
  });

  it("reports a conflict only for references on the target sheet at or below the moved row", () => {
    expect(rowShiftConflict("A1+B2", "S", "S", 2)).toBeNull();
    expect(rowShiftConflict("SUM(A1:A3)", "S", "S", 2)).toMatch(/A1:A3/);
    expect(rowShiftConflict("SUM(A:A)", "S", "S", 0)).toBeNull();
    expect(rowShiftConflict("T!A5", "S", "S", 2)).toBeNull();
    expect(rowShiftConflict("s!A5", "T", "S", 2)).toMatch(/A5/);
    expect(rowShiftConflict("OFFSET(A1,1,0)", "S", "S", 5)).toMatch(/INDIRECT or OFFSET/);
    expect(rowShiftConflict("Sheet1:Sheet3!A1", "S", "S", 5)).toMatch(/several sheets/);
  });

  it("recognizes sheet-name mentions without matching longer names", () => {
    const mention = sheetMentionPattern("Data");
    expect(mention.test("Data!$A$1")).toBe(true);
    expect(mention.test("<x sheet=\"data\"/>")).toBe(true);
    expect(mention.test("MyData!A1")).toBe(false);
    expect(mention.test("Dataset!A1")).toBe(false);
    expect(sheetMentionPattern("It's").test("'It''s'!A1")).toBe(true);
  });
});

describe("number formats", () => {
  const fmt = (code: string, value: number, date1904 = false) => formatNumber(value, compileNumberFormat(code), date1904);
  it("renders the common formats", () => {
    expect(fmt("0.00", 3.14159)).toBe("3.14");
    expect(fmt("#,##0", 1234567.8)).toBe("1,234,568");
    expect(fmt("0%", 0.256)).toBe("26%");
    expect(fmt("0.00E+00", 12345)).toBe("1.23E+04");
    expect(fmt('"$"#,##0.00;("$"#,##0.00)', -5)).toBe("($5.00)");
    expect(fmt("[$€-407] #,##0.00", 2.5)).toBe("€ 2.50");
    expect(fmt("yyyy-mm-dd", 45292)).toBe("2024-01-01");
    expect(fmt("h:mm", 0.5)).toBe("12:00");
    expect(fmt("m/d/yy h:mm", 45292.25)).toBe("2024-01-01 06:00");
    expect(fmt("yyyy-mm-dd", 0, true)).toBe("1904-01-01");
    expect(fmt("yyyy-mm-dd", 60)).toBe("1900-02-29");
    expect(fmt("yyyy-mm-dd", 61)).toBe("1900-03-01");
    expect(formatGeneral(1 / 3)).toBe("0.3333333333");
    expect(formatGeneral(1.23456789e15)).toBe("1.23457E+15");
  });
});

describe("worksheet index and text", () => {
  it("indexes rows lazily and parses one row's cells on demand", () => {
    const index = indexWorksheet(plainSheet(4, 3));
    expect(index.rowCount).toBe(4);
    expect([index.usedRows, index.usedColumns]).toEqual([4, 3]);
    expect(readRowCells(index, 2).map((c) => [c.row, c.col, c.value])).toEqual([[2, 0, "30"], [2, 1, "31"], [2, 2, "32"]]);
  });

  it("flags unordered rows and comments inside cell data as structure issues", () => {
    expect(indexWorksheet(worksheetXml('<sheetData><row r="2"/><row r="1"/></sheetData>')).structureIssue).toMatch(/out of order/);
    expect(indexWorksheet(worksheetXml('<sheetData><!-- x --><row r="1"/></sheetData>')).structureIssue).toMatch(/comments/);
  });

  it("round-trips the _xHHHH_ escape and control characters", () => {
    const value = "a_x0041_\u0001\r\nb";
    expect(decodeSpreadsheetText(encodeSpreadsheetText(value).replace(/&amp;/g, "&"))).toBe(value);
  });

  it("checks well-formedness", () => {
    expect(xmlWellFormedProblem('<?xml version="1.0"?>\r\n<a x="1"><b/>t &amp; u</a>')).toBeNull();
    expect(xmlWellFormedProblem("<a><b></a>")).toMatch(/does not match/);
    expect(xmlWellFormedProblem('<a x="1" x="2"/>')).toMatch(/twice/);
    expect(xmlWellFormedProblem("<a>&bad</a>")).toMatch(/reference/);
    expect(xmlWellFormedProblem("<a/><b/>")).toMatch(/more than one root/);
    expect(xmlWellFormedProblem("<a>")).toMatch(/not closed/);
  });
});

describe("large sheets", () => {
  it("opens a 100,000-row sheet by indexing rows, not cells, and moves a row near the end", () => {
    const rows = 100_000;
    const sheet = plainSheet(rows, 6);
    const bytes = buildPackage(workbookParts({ sheets: [{ name: "Big", xml: sheet }], calcChain: false }));
    const started = performance.now();
    const { session } = openXlsx(bytes);
    const index = session.originalIndex("xl/worksheets/sheet1.xml");
    const opened = performance.now() - started;
    expect(index.rowCount).toBe(rows);
    expect(session.rowCells(index, rows - 1).get(5)?.value).toBe(String(rows * 10 + 5));
    const draft = shiftRows(session, createDraft(session), "xl/worksheets/sheet1.xml", rows - 2, true);
    expect(draft.sheetDrafts.get("xl/worksheets/sheet1.xml")!.index.rowNumbers[rows - 1]).toBe(rows + 1);
    // A generous bound: it only catches accidental quadratic work.
    expect(opened).toBeLessThan(15_000);
  }, 60_000);
});

describe("per-row parsing cost", () => {
  it("reading a row's cells costs the same whether the sheet below it is small or eight times larger", () => {
    const small = indexWorksheet(plainSheet(4_000, 6));
    const large = indexWorksheet(plainSheet(32_000, 6));
    const run = (index: ReturnType<typeof indexWorksheet>) => {
      const started = performance.now();
      for (let i = 0; i < 400; i++) readRowCells(index, i);
      return performance.now() - started;
    };
    let smallBest = Infinity;
    let largeBest = Infinity;
    for (let round = 0; round < 5; round++) {
      smallBest = Math.min(smallBest, run(small));
      largeBest = Math.min(largeBest, run(large));
    }
    // Before the bounded element search, each missing <f>/<v>/<is> lookup scanned to the end of the sheet.
    expect(largeBest).toBeLessThan(Math.max(4 * smallBest, 5));
  });
});

describe("spreadsheet worker client", () => {
  it("opens with the first sheet indexed, indexes other sheets, and writes verified bytes (in-thread fallback)", async () => {
    const client = createXlsxWorkerClient();
    const bytes = buildPackage(workbookParts());
    const opened = await client.open(bytes);
    const { session } = opened;
    expect(session.hasIndex("xl/worksheets/sheet1.xml")).toBe(true);
    expect(session.hasIndex("xl/worksheets/sheet2.xml")).toBe(false);
    session.adoptIndex("xl/worksheets/sheet2.xml", await client.index(session.workbook.partText("xl/worksheets/sheet2.xml")));
    expect(cellView(session, createDraft(session), "xl/worksheets/sheet2.xml", 0, 0).edit).toBe("=Data!B2*10");
    const plan = planXlsxSave(session, setCellText(session, createDraft(session), "xl/worksheets/sheet2.xml", 1, 0, "7"));
    const written = await client.write(plan);
    expect(cellView(openXlsx(written).session, createDraft(openXlsx(written).session), "xl/worksheets/sheet2.xml", 1, 0).display).toBe("7");
    await expect(client.write({ ...plan, expectations: [{ part: "xl/worksheets/sheet2.xml", row: 1, col: 0, input: { kind: "number", value: "8" } }] })).rejects.toThrow(/does not read back/);
    await expect(createXlsxWorkerClient().open(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    client.dispose();
  });

  it("moves rows through the worker protocol with the same result as the in-thread path", async () => {
    const client = createXlsxWorkerClient();
    const { session } = await client.open(buildPackage(workbookParts({ sheets: [{ name: "S", xml: plainSheet(50, 3) }], calcChain: false })));
    const part = "xl/worksheets/sheet1.xml";
    const draft = setCellText(session, createDraft(session), part, 4, 1, "x");
    const job = prepareRowShift(session, draft, part, 2, false);
    const viaWorker = applyRowShift(draft, job, await client.shiftRows(job));
    const inThread = shiftRows(session, draft, part, 2, false);
    expect(viaWorker.sheetDrafts.get(part)!.index.xml).toBe(inThread.sheetDrafts.get(part)!.index.xml);
    expect([...viaWorker.sheetDrafts.get(part)!.index.rowNumbers]).toEqual([...inThread.sheetDrafts.get(part)!.index.rowNumbers]);
    expect(cellView(session, viaWorker, part, 3, 1).display).toBe("x");
    client.dispose();
  });
});
