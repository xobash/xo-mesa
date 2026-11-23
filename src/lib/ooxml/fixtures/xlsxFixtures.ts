import { contentTypes, relationships, xmlHeader, type FixtureParts } from "./ooxmlFixtures";

// Hand-written, licence-clean workbook fixtures. Packages are zipped by
// fflate (`buildPackage`), never by the code under test.

export const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SML = "application/vnd.openxmlformats-officedocument.spreadsheetml";
export const WORKBOOK_TYPE = `${SML}.sheet.main+xml`;
export const MACRO_WORKBOOK_TYPE = "application/vnd.ms-excel.sheet.macroEnabled.main+xml";

export function worksheetXml(body: string, extraNs = ""): string {
  return xmlHeader(`<worksheet xmlns="${MAIN_NS}" xmlns:r="${R_NS}"${extraNs}>${body}</worksheet>`);
}

export const STYLES_XML = xmlHeader(`<styleSheet xmlns="${MAIN_NS}">`
  + `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>`
  + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><i/><sz val="11"/><color rgb="FFC00000"/></font></fonts>`
  + `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
  + `<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills>`
  + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="1" fillId="2" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
  + `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment horizontal="center"/></xf>`
  + `<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
  + `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
  + `<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>`
  + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);

export const SHARED_STRINGS_XML = xmlHeader(`<sst xmlns="${MAIN_NS}" count="5" uniqueCount="5">`
  + `<si><t>Name</t></si><si><t>Share</t></si><si><t>Date</t></si>`
  + `<si><r><rPr><b/></rPr><t>Ali</t></r><r><t xml:space="preserve">ce &amp; co</t></r><rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si>`
  + `<si><t>Total_x000D_</t></si></sst>`);

/** Sheet "Data": header row, styles, numbers, a date, formulas with cached values, a merge, a frozen header. */
export const DATA_SHEET = worksheetXml(
  `<dimension ref="A1:D5"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
  + `<sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="20" customWidth="1"/></cols><sheetData>`
  + `<row r="1" spans="1:4"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c><c r="C1" s="1" t="s"><v>2</v></c></row>`
  + `<row r="2" spans="1:4"><c r="A2" t="s"><v>3</v></c><c r="B2" s="2"><v>0.25</v></c><c r="C2" s="3"><v>45292</v></c><c r="D2"><f>B2*2</f><v>0.5</v></c></row>`
  + `<row r="3" spans="1:4"><c r="A3" t="inlineStr"><is><t>Inline</t></is></c><c r="B3" t="b"><v>1</v></c><c r="D3" s="4"><f>SUM(B2:B3)</f><v>1234.5</v></c></row>`
  + `<row r="4" spans="1:4"><c r="A4" t="e"><v>#DIV/0!</v></c><c r="B4" t="s"><v>4</v></c></row>`
  + `<row r="5" spans="1:4"><c r="A5" t="str"><f>A2&amp;"!"</f><v>Alice &amp; co!</v></c></row>`
  + `</sheetData><mergeCells count="1"><mergeCell ref="B4:C4"/></mergeCells>`
  + `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`);

/** Sheet "Other": a cross-sheet formula into Data. */
export const OTHER_SHEET = worksheetXml(`<dimension ref="A1"/><sheetData><row r="1"><c r="A1"><f>Data!B2*10</f><v>2.5</v></c></row></sheetData>`);

export interface WorkbookOptions {
  sheets?: Array<{ name: string; xml: string | Uint8Array }>;
  definedNames?: string;
  extraParts?: FixtureParts;
  extraOverrides?: Record<string, string>;
  extraWorkbookRels?: Array<{ id: string; type: string; target: string; external?: boolean }>;
  sheetRels?: Record<number, Array<{ id: string; type: string; target: string; external?: boolean }>>;
  workbookType?: string;
  calcChain?: boolean;
}

/** A complete workbook: styles, shared strings, calculation chain, document properties. */
export function workbookParts(options: WorkbookOptions = {}): FixtureParts {
  const sheets = options.sheets ?? [{ name: "Data", xml: DATA_SHEET }, { name: "Other", xml: OTHER_SHEET }];
  const calcChain = options.calcChain ?? true;
  const parts: FixtureParts = {};
  const overrides: Record<string, string> = {
    "xl/workbook.xml": options.workbookType ?? WORKBOOK_TYPE,
    "xl/styles.xml": `${SML}.styles+xml`,
    "xl/sharedStrings.xml": `${SML}.sharedStrings+xml`,
    "docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml",
    ...(calcChain ? { "xl/calcChain.xml": `${SML}.calcChain+xml` } : {}),
  };
  const rels: Array<{ id: string; type: string; target: string; external?: boolean }> = [];
  sheets.forEach((sheet, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = sheet.xml;
    overrides[`xl/worksheets/sheet${i + 1}.xml`] = `${SML}.worksheet+xml`;
    rels.push({ id: `rId${i + 1}`, type: "worksheet", target: `worksheets/sheet${i + 1}.xml` });
    const sheetRels = options.sheetRels?.[i];
    if (sheetRels) parts[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = relationships(sheetRels);
  });
  rels.push({ id: "rId90", type: "styles", target: "styles.xml" }, { id: "rId91", type: "sharedStrings", target: "sharedStrings.xml" });
  if (calcChain) rels.push({ id: "rId92", type: "calcChain", target: "calcChain.xml" });
  rels.push(...(options.extraWorkbookRels ?? []));
  const sheetList = sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  return {
    "[Content_Types].xml": contentTypes({ ...overrides, ...options.extraOverrides }),
    "_rels/.rels": relationships([
      { id: "rId1", type: "officeDocument", target: "xl/workbook.xml" },
      { id: "rId2", type: "extended-properties", target: "docProps/app.xml" },
    ]),
    "docProps/app.xml": xmlHeader('<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>'),
    "xl/workbook.xml": xmlHeader(`<workbook xmlns="${MAIN_NS}" xmlns:r="${R_NS}"><workbookPr defaultThemeVersion="166925"/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="1000" windowHeight="800"/></bookViews><sheets>${sheetList}</sheets>${options.definedNames ? `<definedNames>${options.definedNames}</definedNames>` : ""}<calcPr calcId="191029"/></workbook>`),
    "xl/_rels/workbook.xml.rels": relationships(rels),
    "xl/styles.xml": STYLES_XML,
    "xl/sharedStrings.xml": SHARED_STRINGS_XML,
    ...(calcChain ? { "xl/calcChain.xml": xmlHeader(`<calcChain xmlns="${MAIN_NS}"><c r="D2" i="1"/><c r="D3"/><c r="A5"/><c r="A1" i="2"/></calcChain>`) } : {}),
    ...parts,
    ...options.extraParts,
  };
}

const CHART_TYPE = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const DRAWING_TYPE = "application/vnd.openxmlformats-officedocument.drawing+xml";

/** Workbook whose Data sheet has a drawing with a chart that plots Data!B2:B3. */
export function chartWorkbookParts(): FixtureParts {
  const dataWithDrawing = DATA_SHEET.replace("</worksheet>", '<drawing r:id="rId1"/></worksheet>');
  return workbookParts({
    sheets: [{ name: "Data", xml: dataWithDrawing }, { name: "Other", xml: OTHER_SHEET }],
    sheetRels: { 0: [{ id: "rId1", type: "drawing", target: "../drawings/drawing1.xml" }] },
    extraParts: {
      "xl/drawings/drawing1.xml": xmlHeader('<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>'),
      "xl/drawings/_rels/drawing1.xml.rels": relationships([{ id: "rId1", type: "chart", target: "../charts/chart1.xml" }]),
      "xl/charts/chart1.xml": xmlHeader('<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart><c:ser><c:val><c:numRef><c:f>Data!$B$2:$B$3</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>'),
    },
    extraOverrides: { "xl/drawings/drawing1.xml": DRAWING_TYPE, "xl/charts/chart1.xml": CHART_TYPE },
  });
}

/** Workbook with a pivot table on Other whose cache reads Data!A1:B3. */
export function pivotWorkbookParts(): FixtureParts {
  return workbookParts({
    sheetRels: { 1: [{ id: "rId1", type: "pivotTable", target: "../pivotTables/pivotTable1.xml" }] },
    extraWorkbookRels: [{ id: "rId93", type: "pivotCacheDefinition", target: "pivotCache/pivotCacheDefinition1.xml" }],
    extraParts: {
      "xl/pivotTables/pivotTable1.xml": xmlHeader(`<pivotTableDefinition xmlns="${MAIN_NS}" name="P1" cacheId="1"/>`),
      "xl/pivotCache/pivotCacheDefinition1.xml": xmlHeader(`<pivotCacheDefinition xmlns="${MAIN_NS}"><cacheSource type="worksheet"><worksheetSource ref="A1:B3" sheet="Data"/></cacheSource></pivotCacheDefinition>`),
    },
    extraOverrides: {
      "xl/pivotTables/pivotTable1.xml": `${SML}.pivotTable+xml`,
      "xl/pivotCache/pivotCacheDefinition1.xml": `${SML}.pivotCacheDefinition+xml`,
    },
  });
}

/** Macro-enabled workbook (.xlsm) with a VBA project part. */
export function macroWorkbookParts(): FixtureParts {
  return workbookParts({
    workbookType: MACRO_WORKBOOK_TYPE,
    extraWorkbookRels: [{ id: "rId94", type: "http://schemas.microsoft.com/office/2006/relationships/vbaProject", target: "vbaProject.bin" }],
    extraParts: { "xl/vbaProject.bin": new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]) },
    extraOverrides: { "xl/vbaProject.bin": "application/vnd.ms-office.vbaProject" },
  });
}

/** Workbook carrying an XML digital signature. */
export function signedWorkbookParts(): FixtureParts {
  return workbookParts({
    extraParts: { "_xmlsignatures/sig1.xml": xmlHeader('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>') },
    extraOverrides: { "_xmlsignatures/sig1.xml": "application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml" },
  });
}

/** Workbook with a table on Data covering A1:C3 (header row 1). */
export function tableWorkbookParts(): FixtureParts {
  const dataWithTable = DATA_SHEET.replace("</worksheet>", '<tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>');
  return workbookParts({
    sheets: [{ name: "Data", xml: dataWithTable }, { name: "Other", xml: OTHER_SHEET }],
    sheetRels: { 0: [{ id: "rId1", type: "table", target: "../tables/table1.xml" }] },
    extraParts: { "xl/tables/table1.xml": xmlHeader(`<table xmlns="${MAIN_NS}" id="1" name="T" displayName="T" ref="A1:C3"><tableColumns count="3"><tableColumn id="1" name="Name"/><tableColumn id="2" name="Share"/><tableColumn id="3" name="Date"/></tableColumns></table>`) },
    extraOverrides: { "xl/tables/table1.xml": `${SML}.table+xml` },
  });
}

/** A plain sheet of numbers in A..`cols` for `rows` rows (no formulas). */
export function plainSheet(rows: number, cols: number, tail = ""): string {
  const body: string[] = [];
  for (let r = 1; r <= rows; r++) {
    let cells = "";
    for (let c = 0; c < cols; c++) cells += `<c r="${String.fromCharCode(65 + c)}${r}"><v>${r * 10 + c}</v></c>`;
    body.push(`<row r="${r}" spans="1:${cols}">${cells}</row>`);
  }
  const last = `${String.fromCharCode(64 + cols)}${rows}`;
  return worksheetXml(`<dimension ref="A1:${last}"/><sheetData>${body.join("")}</sheetData>${tail}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`);
}
