import { describe, expect, it } from "vitest";
import { LegacyOfficeError, openCompoundFile } from "./cfb";
import { legacyCellText } from "./excelBinary";
import { openLegacyOffice, type LegacyOfficeContent } from "./legacyOffice";
import { buildEditableCopy, verifyEditableCopy } from "./legacyConvert";
import { openOoxmlPackage } from "../ooxml/ooxmlPackage";
import { openXlsx } from "../ooxml/xlsxOpen";
import { openPresentation } from "../pptx/pptxSession";
import { decodeXmlPart } from "../ooxml/xmlScan";
import {
  biffRecord, buildCfb, buildDoc, buildDocStreams, buildPpt, buildXls, buildXlsWorkbookStream, fatEntryOffset, rkInt,
} from "./fixtures/legacyFixtures";

function put32(b: Uint8Array, at: number, v: number): void {
  new DataView(b.buffer, b.byteOffset).setUint32(at, v, true);
}

function refusal(run: () => unknown): LegacyOfficeError {
  try { run(); } catch (error) {
    if (error instanceof LegacyOfficeError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const big = new Uint8Array(5000).map((_, i) => i % 251);
const small = new Uint8Array([1, 2, 3, 4, 5]);

describe("compound file reader", () => {
  it("reads mini-stream and regular streams by name, without case", () => {
    const { bytes } = buildCfb([{ name: "Small", data: small }, { name: "Big", data: big }]);
    const cfb = openCompoundFile(bytes);
    expect(cfb.stream("small")).toEqual(small);
    expect(cfb.stream("BIG")).toEqual(big);
    expect(cfb.stream("missing")).toBeNull();
  });

  it("refuses a sector chain that loops back on itself", () => {
    const { bytes, layout } = buildCfb([{ name: "Big", data: big }]);
    const start = layout.streamStart.get("Big")!;
    put32(bytes, fatEntryOffset(start + 1), start);
    expect(refusal(() => openCompoundFile(bytes).stream("Big")).message).toMatch(/loops/);
  });

  it("refuses a chain pointing outside the file and a chain that ends early", () => {
    const { bytes, layout } = buildCfb([{ name: "Big", data: big }]);
    const start = layout.streamStart.get("Big")!;
    const outside = bytes.slice();
    put32(outside, fatEntryOffset(start), 0x00ffffff);
    expect(refusal(() => openCompoundFile(outside).stream("Big")).message).toMatch(/outside the file/);
    const early = bytes.slice();
    put32(early, fatEntryOffset(start), 0xfffffffe);
    expect(refusal(() => openCompoundFile(early).stream("Big")).message).toMatch(/truncated/);
  });

  it("refuses a truncated file, impossible counts and a directory loop", () => {
    const { bytes, layout } = buildCfb([{ name: "Big", data: big }, { name: "Small", data: small }]);
    expect(refusal(() => openCompoundFile(bytes.subarray(0, bytes.length - 2048)).stream("Big")).reason).toBe("malformed");
    const hugeFat = bytes.slice();
    put32(hugeFat, 44, 0x0fffffff);
    expect(refusal(() => openCompoundFile(hugeFat)).message).toMatch(/more FAT sectors than it has/);
    const loop = bytes.slice();
    const dir = (layout.dirStart + 1) * 512;
    put32(loop, dir + 128 + 72, 1); // first child's right sibling is itself
    expect(refusal(() => openCompoundFile(loop)).message).toMatch(/loops/);
    expect(refusal(() => openCompoundFile(new Uint8Array(600))).reason).toBe("malformed");
  });

  it("refuses files above the size limit before parsing", () => {
    const huge = new Uint8Array(64 * 1024 * 1024 + 1);
    huge.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(refusal(() => openCompoundFile(huge)).reason).toBe("tooLarge");
  });

  it("refuses encrypted OOXML packages stored as compound files", () => {
    const { bytes } = buildCfb([{ name: "EncryptionInfo", data: small }, { name: "EncryptedPackage", data: small }]);
    expect(refusal(() => openLegacyOffice(bytes, "doc")).reason).toBe("encrypted");
  });
});

describe("Word 97-2003 text", () => {
  it("joins compressed and UTF-16 pieces, keeps field results and marks page breaks", () => {
    const bytes = buildDoc([
      { text: "It’s plain\tand\x0Bbroken\r\x13 PAGE \x14" + "7\x15 shown\r", compressed: true },
      { text: "\x0CNext page Ж\r", compressed: false },
    ]);
    const content = openLegacyOffice(bytes, "doc");
    expect(content.kind).toBe("word");
    if (content.kind !== "word") return;
    expect(content.document.blocks).toEqual([
      { kind: "paragraph", text: "It’s plain\tand\nbroken", pageBreakBefore: false },
      { kind: "paragraph", text: "7 shown", pageBreakBefore: false },
      { kind: "paragraph", text: "Next page Ж", pageBreakBefore: true },
    ]);
  });

  it("reads tables from paragraph table flags, including multi-paragraph and empty cells", () => {
    const text = "Before\rA\rA2\x07\x07C\x07\x07D\x07E\x07\x07After\r";
    // Marks: Before\r, A\r(in cell), A2\x07, \x07 row, C\x07, \x07 row, D\x07, E\x07, \x07 row, After\r
    const flags = [[false, false], [true, false], [true, false], [true, true], [true, false], [true, true], [true, false], [true, false], [true, true], [false, false]];
    const bytes = buildDoc([{ text, compressed: true }], { paragraphFlags: (i) => ({ inTable: flags[i][0], rowEnd: flags[i][1] }) });
    const content = openLegacyOffice(bytes, "dot");
    if (content.kind !== "word") throw new Error("not word");
    expect(content.document.blocks).toEqual([
      { kind: "paragraph", text: "Before", pageBreakBefore: false },
      { kind: "table", rows: [["A\nA2"], ["C"], ["D", "E"]] },
      { kind: "paragraph", text: "After", pageBreakBefore: false },
    ]);
  });

  it("falls back to double cell marks for rows when there are no paragraph flags", () => {
    const content = openLegacyOffice(buildDoc([{ text: "A\x07B\x07\x07C\x07D\x07\x07Done\r", compressed: true }]), "doc");
    if (content.kind !== "word") throw new Error("not word");
    expect(content.document.blocks).toEqual([
      { kind: "table", rows: [["A", "B"], ["C", "D"]] },
      { kind: "paragraph", text: "Done", pageBreakBefore: false },
    ]);
  });

  it("refuses encrypted and pre-97 documents with a plain reason", () => {
    const encrypted = refusal(() => openLegacyOffice(buildDoc([{ text: "x\r", compressed: true }], { encrypted: true }), "doc"));
    expect(encrypted.reason).toBe("encrypted");
    expect(encrypted.message).toMatch(/password-protected/);
    expect(refusal(() => openLegacyOffice(buildDoc([{ text: "x\r", compressed: true }], { nFib: 104 }), "doc")).reason).toBe("unsupported");
  });

  it("refuses a piece that points outside the stream", () => {
    const streams = buildDocStreams([{ text: "hello\r", compressed: false }]);
    const table = streams[1].data;
    put32(table, 5 + 5 + 2 * 4 + 2, 0x00ffff00); // Prc (5) + Pcdt header (5) + two CPs, then the PCD fc
    expect(refusal(() => openLegacyOffice(buildCfb(streams).bytes, "doc")).message).toMatch(/outside its stream/);
  });
});

describe("Excel 97-2003 cells", () => {
  const sheets = [
    {
      name: "Data",
      cells: [
        { kind: "sst" as const, row: 0, col: 0, index: 0 },
        { kind: "sst" as const, row: 0, col: 1, index: 1 },
        { kind: "number" as const, row: 1, col: 0, value: 1.5 },
        { kind: "rk" as const, row: 1, col: 1, rk: rkInt(42) },
        { kind: "mulrk" as const, row: 2, col: 0, values: [{ rk: rkInt(7), xf: 0 }, { rk: rkInt(45292), xf: 1 }] },
        { kind: "bool" as const, row: 3, col: 0, value: true },
        { kind: "error" as const, row: 3, col: 1, code: 0x07 },
        { kind: "formulaNumber" as const, row: 4, col: 0, value: 99 },
        { kind: "formulaString" as const, row: 4, col: 1, value: "cached" },
        { kind: "label" as const, row: 5, col: 2, value: "label" },
        { kind: "number" as const, row: 6, col: 0, value: 0.125, xf: 2 },
      ],
    },
    { name: "Chart1", cells: [], type: 2 },
    { name: "Hidden", cells: [{ kind: "rk" as const, row: 0, col: 0, rk: rkInt(1) }], hidden: true },
  ];
  const options = { strings: ["Name", "A longer shared string"], splitSstAt: 20, formats: { 164: "0.0%" }, xfFormats: [0, 14, 164] };

  it("reads values, shared strings across CONTINUE, cached formula results and formats", () => {
    const content = openLegacyOffice(buildXls(sheets, options), "xls");
    if (content.kind !== "excel") throw new Error("not excel");
    const wb = content.workbook;
    expect(wb.sheets.map((s) => [s.name, s.hidden])).toEqual([["Data", false], ["Hidden", true]]);
    expect(wb.skippedSheets).toEqual(["Chart1"]);
    expect(wb.formulaCells).toBe(2);
    const data = wb.sheets[0];
    const text = new Map(data.cells.map((c) => [`${c.row},${c.col}`, legacyCellText(c, wb.date1904)]));
    expect(Object.fromEntries(text)).toEqual({
      "0,0": "Name", "0,1": "A longer shared string", "1,0": "1.5", "1,1": "42", "2,0": "7", "2,1": "2024-01-01",
      "3,0": "TRUE", "3,1": "#DIV/0!", "4,0": "99", "4,1": "cached", "5,2": "label", "6,0": "12.5%",
    });
    expect([data.rowCount, data.columnCount]).toEqual([7, 3]);
  });

  it("refuses encrypted, Excel 95 and truncated workbooks", () => {
    expect(refusal(() => openLegacyOffice(buildXls(sheets, { ...options, encrypted: true }), "xlt")).reason).toBe("encrypted");
    expect(refusal(() => openLegacyOffice(buildXls(sheets, { biffVersion: 0x0500 }), "xls")).reason).toBe("unsupported");
    const stream = buildXlsWorkbookStream(sheets, options);
    const cut = buildCfb([{ name: "Workbook", data: stream.subarray(0, stream.length - 3) }]).bytes;
    expect(refusal(() => openLegacyOffice(cut, "xls")).reason).toBe("malformed");
  });

  it("refuses an impossible shared string count without allocating it", () => {
    const stream = new Uint8Array([
      ...biffRecord(0x0809, [0, 6, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      ...biffRecord(0x00fc, [0xff, 0xff, 0xff, 0x7f, 0xff, 0xff, 0xff, 0x7f]),
      ...biffRecord(0x000a, []),
    ]);
    expect(refusal(() => openLegacyOffice(buildCfb([{ name: "Workbook", data: stream }]).bytes, "xls")).message).toMatch(/count is impossible/);
  });
});

describe("PowerPoint 97-2003 text", () => {
  const slides = [
    { title: "Welcome", body: "Point one\rPoint two\x0Bwrapped", box: "Box text", notes: "Speak slowly" },
    { title: "Second", body: "Only body" },
  ];

  it("reads slide order, titles, body, text boxes, notes and slide size", () => {
    const content = openLegacyOffice(buildPpt(slides), "ppt");
    if (content.kind !== "powerpoint") throw new Error("not powerpoint");
    expect(content.presentation.slides).toEqual([
      { title: "Welcome", body: ["Point one", "Point two\nwrapped", "Box text"], notes: ["Speak slowly"] },
      { title: "Second", body: ["Only body"], notes: [] },
    ]);
    expect([content.presentation.width, content.presentation.height]).toEqual([9_144_000, 6_858_000]);
  });

  it("refuses encrypted presentations and an edit history that loops", () => {
    expect(refusal(() => openLegacyOffice(buildPpt(slides, { encryptedToken: true }), "pps")).reason).toBe("encrypted");
    expect(refusal(() => openLegacyOffice(buildPpt(slides, { editLoop: true }), "pot")).message).toMatch(/loops back/);
  });
});

describe("editable copies", () => {
  const word = openLegacyOffice(buildDoc([{ text: "Title & <more>\rA\x07B\x07\x07Tail\x0Bline\r", compressed: true }]), "doc");
  const excel = openLegacyOffice(buildXls([
    { name: "Data & more", cells: [{ kind: "sst", row: 0, col: 0, index: 0 }, { kind: "rk", row: 1, col: 1, rk: rkInt(45292), xf: 1 }, { kind: "formulaNumber", row: 2, col: 0, value: 3 }] },
  ], { strings: ["x<y"], xfFormats: [0, 14], date1904: true }), "xls");
  const powerpoint = openLegacyOffice(buildPpt([{ title: "T & U", body: "One\rTwo", notes: "N" }, { title: "Two", body: "" }]), "ppt");

  it.each([["word", word], ["excel", excel], ["powerpoint", powerpoint]] as [string, LegacyOfficeContent][])("builds a %s copy that Mesa's own package layer reopens", (_, content) => {
    const bytes = buildEditableCopy(content);
    expect(() => verifyEditableCopy(content, bytes)).not.toThrow();
    expect(openOoxmlPackage(bytes).kind).toBe(content.kind === "word" ? "wordprocessing" : content.kind === "excel" ? "spreadsheet" : "presentation");
  });

  it("writes Word tables as real tables and escapes text", () => {
    const xml = decodeXmlPart(openOoxmlPackage(buildEditableCopy(word)).parts.get("word/document.xml")!);
    expect(xml).toContain("Title &amp; &lt;more&gt;");
    expect(xml.match(/<w:tr>/g)).toHaveLength(1);
    expect(xml).toContain("<w:t xml:space=\"preserve\">Tail</w:t><w:br/>");
  });

  it("keeps workbook values, the date format and the 1904 date system; formulas become values", () => {
    const opened = openXlsx(buildEditableCopy(excel));
    const wb = opened.session.workbook;
    expect(wb.sheets.map((s) => s.name)).toEqual(["Data & more"]);
    expect(wb.date1904).toBe(true);
    const sheet = wb.partText(wb.sheets[0].part!);
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">x&lt;y</t></is></c>');
    expect(sheet).toContain('<c r="B2" s="1"><v>45292</v></c>');
    expect(sheet).toContain('<c r="A3"><v>3</v></c>');
    expect(sheet).not.toContain("<f>");
    expect(wb.styles()[1].numberFormat.kind).toBe("date");
  });

  it("keeps slide order, titles and notes in the presentation copy", () => {
    const opened = openPresentation(buildEditableCopy(powerpoint), "pptx");
    expect(opened.deck.slides).toHaveLength(2);
    expect(opened.deck.slides[0].notesPart).not.toBeNull();
    expect(opened.deck.slides[1].notesPart).toBeNull();
    expect(opened.policy.canEdit).toBe(true);
    const slide1 = decodeXmlPart(opened.pkg.parts.get(opened.deck.slides[0].part)!);
    expect(slide1).toContain("<a:t>T &amp; U</a:t>");
    expect(slide1).toContain("<a:t>Two</a:t>");
  });

  it("the self-check refuses a copy that does not carry the content", () => {
    expect(() => verifyEditableCopy(word, buildEditableCopy(powerpoint))).toThrow();
    const other = openLegacyOffice(buildDoc([{ text: "Different\r", compressed: true }]), "doc");
    expect(() => verifyEditableCopy(word, buildEditableCopy(other))).toThrow(/same text/);
  });
});

// Spreading the shared-string table into push() overflowed the call stack
// past about 125k strings, so big data-export workbooks failed to open.
it("opens an .xls whose shared-string table holds 130,000 strings", () => {
  const strings = Array.from({ length: 130_000 }, (_, i) => `s${String(i).padStart(6, "0")}`);
  const bytes = buildXls([{ name: "Data", cells: [{ kind: "sst", row: 0, col: 0, index: 129_999 }] }], { strings, sstRecordBytes: 8000 });
  const content = openLegacyOffice(bytes, "xls");
  expect(JSON.stringify(content)).toContain("s129999");
});
