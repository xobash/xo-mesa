import { columnLetters, formatCellRef } from "../cellRef";
import { openOoxmlPackage } from "../ooxml/ooxmlPackage";
import { readZipContainer, writeZipContainer } from "../ooxml/zipContainer";
import { openXlsx } from "../ooxml/xlsxOpen";
import { encodeSpreadsheetText } from "../ooxml/xlsxText";
import { decodeXmlPart, decodeXmlText, escapeXmlAttribute, escapeXmlText, stripXmlIllegal } from "../ooxml/xmlScan";
import { openPresentation } from "../pptx/pptxSession";
import { BUILTIN_NUMBER_FORMATS } from "../ooxml/xlsxNumberFormat";
import type { LegacyOfficeContent } from "./legacyOffice";
import type { LegacyCell, LegacyWorkbook } from "./excelBinary";
import type { LegacyPresentation } from "./pptBinary";
import type { LegacyWordDocument } from "./wordBinary";

// Builds a new, minimal OOXML package (.docx, .xlsx or .pptx) from the text
// and values read from a legacy binary file, written by the package layer's
// own ZIP writer (fflate deflate; adding fflate's zip writer here would grow
// the entry chunk, which already holds fflate), and checks it by opening it
// through Mesa's own package layer. Only what the readers model is carried
// over; `CONVERSION_LOSSES` names what is lost. The original is never touched.

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const CT = "application/vnd.openxmlformats-officedocument";
/** A ZIP with no entries: just the end-of-central-directory record. */
const EMPTY_ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);

/** What the editable copy keeps and loses, shown in the confirmation. */
export const CONVERSION_LOSSES: Readonly<Record<LegacyOfficeContent["kind"], string>> = {
  word: "The copy keeps the main text, paragraphs, line and page breaks, tabs and tables (as plain cells). It loses all formatting (fonts, styles, lists, alignment), headers and footers, footnotes, comments, tracked changes, text boxes, images, drawings, embedded objects and macros. Fields keep only their shown result.",
  excel: "The copy keeps every worksheet's cell values (text, numbers, true/false, errors) and number formats, including dates. Formulas are not converted: each formula cell keeps only its last calculated value. It loses fonts, colours, borders, column widths, merged cells, comments, defined names, charts, chart sheets, images, pivot tables, data validation and macros.",
  powerpoint: "The copy keeps each slide's title, text and speaker notes, in slide order, on a plain layout. It loses the design and theme, text positions and formatting, images, charts, tables, shapes, animations, transitions, hidden-slide marks and macros.",
};


function xmlDoc(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${body}`;
}

function relationships(rels: readonly { id: string; type: string; target: string }[]): string {
  const items = rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type.startsWith("http") ? r.type : `${REL}/${r.type}`}" Target="${r.target}"/>`).join("");
  return xmlDoc(`<Relationships xmlns="${PKG_REL}">${items}</Relationships>`);
}

function contentTypes(overrides: readonly [string, string][]): string {
  const o = overrides.map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join("");
  return xmlDoc(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${o}</Types>`);
}

function zip(parts: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const edits = new Map<string, Uint8Array>();
  for (const [name, text] of Object.entries(parts)) edits.set(name, encoder.encode(text));
  return writeZipContainer(readZipContainer(EMPTY_ZIP), edits);
}

// ---------- Word ----------

function wordRun(text: string): string {
  if (!text) return "";
  let inner = "";
  for (const piece of text.split(/(\t|\n)/)) {
    if (piece === "\t") inner += "<w:tab/>";
    else if (piece === "\n") inner += "<w:br/>";
    else if (piece) inner += `<w:t xml:space="preserve">${escapeXmlText(piece)}</w:t>`;
  }
  return inner ? `<w:r>${inner}</w:r>` : "";
}

function wordParagraph(text: string, pageBreakBefore = false): string {
  const pPr = pageBreakBefore ? "<w:pPr><w:pageBreakBefore/></w:pPr>" : "";
  const run = wordRun(text);
  return pPr || run ? `<w:p>${pPr}${run}</w:p>` : "<w:p/>";
}

function wordTable(rows: readonly (readonly string[])[]): string {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const width = Math.max(400, Math.floor(9000 / cols));
  const grid = `<w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(cols)}</w:tblGrid>`;
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`;
  const tblPr = `<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders></w:tblPr>`;
  const body = rows.map((row) => {
    let cells = "";
    for (let c = 0; c < cols; c++) {
      const paragraphs = (row[c] ?? "").split("\n").map((line) => wordParagraph(line)).join("");
      cells += `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${paragraphs}</w:tc>`;
    }
    return `<w:tr>${cells}</w:tr>`;
  }).join("");
  return `<w:tbl>${tblPr}${grid}${body}</w:tbl>`;
}

export function buildDocx(doc: LegacyWordDocument): Uint8Array {
  const body = doc.blocks.map((b) => (b.kind === "table" ? wordTable(b.rows) : wordParagraph(b.text, b.pageBreakBefore))).join("");
  return zip({
    "[Content_Types].xml": contentTypes([["word/document.xml", `${CT}.wordprocessingml.document.main+xml`]]),
    "_rels/.rels": relationships([{ id: "rId1", type: "officeDocument", target: "word/document.xml" }]),
    "word/document.xml": xmlDoc(`<w:document xmlns:w="${W_NS}" xmlns:r="${REL}"><w:body>${body}<w:p/><w:sectPr/></w:body></w:document>`),
  });
}

/** Visible text of the source, in order, as the copy's `w:t` runs must spell it. */
function wordExpectedText(doc: LegacyWordDocument): string {
  const out: string[] = [];
  for (const b of doc.blocks) {
    const texts = b.kind === "table" ? b.rows.flat() : [b.text];
    for (const t of texts) out.push(stripXmlIllegal(t.replace(/[\t\n]/g, "")));
  }
  return out.join("");
}

function verifyDocx(bytes: Uint8Array, doc: LegacyWordDocument): void {
  const pkg = openOoxmlPackage(bytes);
  if (pkg.kind !== "wordprocessing" || pkg.mainPart !== "word/document.xml") throw new Error("The new file is not a Word document.");
  const xml = decodeXmlPart(pkg.parts.get("word/document.xml")!);
  let text = "";
  const re = /<w:t xml:space="preserve">([^<]*)<\/w:t>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) text += decodeXmlText(m[1]);
  if (text !== wordExpectedText(doc)) throw new Error("The new Word file does not read back with the same text.");
}

// ---------- Excel ----------

interface StyleTable { readonly xfFor: Map<string, number>; readonly xml: string }

function buildStyles(workbook: LegacyWorkbook): StyleTable {
  const builtinByCode = new Map<string, number>();
  for (const [id, code] of Object.entries(BUILTIN_NUMBER_FORMATS)) builtinByCode.set(code, Number(id));
  const xfFor = new Map<string, number>([["General", 0]]);
  const numFmtIds: number[] = [0];
  const custom: string[] = [];
  for (const sheet of workbook.sheets) {
    for (const cell of sheet.cells) {
      if (cell.value.kind !== "number" || xfFor.has(cell.format)) continue;
      let id = builtinByCode.get(cell.format);
      if (id === undefined) { id = 164 + custom.length; custom.push(cell.format); }
      xfFor.set(cell.format, numFmtIds.length);
      numFmtIds.push(id);
    }
  }
  const numFmts = custom.length
    ? `<numFmts count="${custom.length}">${custom.map((code, i) => `<numFmt numFmtId="${164 + i}" formatCode="${escapeXmlAttribute(code)}"/>`).join("")}</numFmts>`
    : "";
  const xfs = numFmtIds.map((id) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0"${id ? ' applyNumberFormat="1"' : ""}/>`).join("");
  const xml = xmlDoc(`<styleSheet xmlns="${S_NS}">${numFmts}<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${numFmtIds.length}">${xfs}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  return { xfFor, xml };
}

function cellXml(cell: LegacyCell, xfFor: Map<string, number>): string {
  const ref = formatCellRef(cell.row, cell.col);
  const v = cell.value;
  if (v.kind === "text") return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${encodeSpreadsheetText(v.value)}</t></is></c>`;
  if (v.kind === "bool") return `<c r="${ref}" t="b"><v>${v.value ? 1 : 0}</v></c>`;
  if (v.kind === "error" || !Number.isFinite(v.value)) return `<c r="${ref}" t="e"><v>${v.kind === "error" ? escapeXmlText(v.value) : "#NUM!"}</v></c>`;
  const xf = xfFor.get(cell.format) ?? 0;
  return `<c r="${ref}"${xf ? ` s="${xf}"` : ""}><v>${String(v.value)}</v></c>`;
}

function worksheetXml(cells: readonly LegacyCell[], xfFor: Map<string, number>, rows: number, cols: number): string {
  const byAddress = new Map<number, LegacyCell>();
  for (const cell of cells) byAddress.set(cell.row * 16384 + cell.col, cell);
  const sorted = [...byAddress.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  const out: string[] = [];
  let row = -1;
  for (const cell of sorted) {
    if (cell.row !== row) {
      if (row >= 0) out.push("</row>");
      row = cell.row;
      out.push(`<row r="${row + 1}">`);
    }
    out.push(cellXml(cell, xfFor));
  }
  if (row >= 0) out.push("</row>");
  const dimension = rows > 0 && cols > 0 ? `A1:${columnLetters(cols - 1)}${rows}` : "A1";
  return xmlDoc(`<worksheet xmlns="${S_NS}"><dimension ref="${dimension}"/><sheetData>${out.join("")}</sheetData></worksheet>`);
}

/** Worksheets the copy will hold: at least one, and at least one visible. */
function copySheets(workbook: LegacyWorkbook): { name: string; hidden: boolean; index: number }[] {
  const sheets = workbook.sheets.map((s, index) => ({ name: s.name, hidden: s.hidden, index }));
  if (sheets.length === 0) return [{ name: "Sheet1", hidden: false, index: -1 }];
  if (sheets.every((s) => s.hidden)) sheets[0].hidden = false;
  return sheets;
}

export function buildXlsx(workbook: LegacyWorkbook): Uint8Array {
  const styles = buildStyles(workbook);
  const sheets = copySheets(workbook);
  const parts: Record<string, string> = {};
  const overrides: [string, string][] = [
    ["xl/workbook.xml", `${CT}.spreadsheetml.sheet.main+xml`],
    ["xl/styles.xml", `${CT}.spreadsheetml.styles+xml`],
  ];
  const rels: { id: string; type: string; target: string }[] = [];
  sheets.forEach((s, i) => {
    const source = s.index >= 0 ? workbook.sheets[s.index] : null;
    parts[`xl/worksheets/sheet${i + 1}.xml`] = worksheetXml(source?.cells ?? [], styles.xfFor, source?.rowCount ?? 0, source?.columnCount ?? 0);
    overrides.push([`xl/worksheets/sheet${i + 1}.xml`, `${CT}.spreadsheetml.worksheet+xml`]);
    rels.push({ id: `rId${i + 1}`, type: "worksheet", target: `worksheets/sheet${i + 1}.xml` });
  });
  rels.push({ id: `rId${sheets.length + 1}`, type: "styles", target: "styles.xml" });
  const sheetList = sheets.map((s, i) => `<sheet name="${escapeXmlAttribute(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`).join("");
  return zip({
    "[Content_Types].xml": contentTypes(overrides),
    "_rels/.rels": relationships([{ id: "rId1", type: "officeDocument", target: "xl/workbook.xml" }]),
    "xl/workbook.xml": xmlDoc(`<workbook xmlns="${S_NS}" xmlns:r="${REL}">${workbook.date1904 ? '<workbookPr date1904="1"/>' : ""}<sheets>${sheetList}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": relationships(rels),
    "xl/styles.xml": styles.xml,
    ...parts,
  });
}

function verifyXlsx(bytes: Uint8Array, workbook: LegacyWorkbook): void {
  const opened = openXlsx(bytes);
  const wb = opened.session.workbook;
  const expected = copySheets(workbook).map((s) => stripXmlIllegal(s.name));
  if (wb.sheets.length !== expected.length || wb.sheets.some((s, i) => s.name !== expected[i] || !s.part || s.kind !== "worksheet")) {
    throw new Error("The new workbook does not read back with the same sheets.");
  }
  if (wb.date1904 !== workbook.date1904) throw new Error("The new workbook does not keep the date system.");
  if (opened.refusals.length > 0) throw new Error(`The new workbook would not be editable: ${opened.refusals.join("; ")}.`);
  wb.styles();
}

// ---------- PowerPoint ----------

const DEFAULT_SLIDE = { cx: 9_144_000, cy: 6_858_000 };

function theme(): string {
  const colors = [["dk1", '<a:sysClr val="windowText" lastClr="000000"/>'], ["lt1", '<a:sysClr val="window" lastClr="FFFFFF"/>'],
    ["dk2", '<a:srgbClr val="1F2937"/>'], ["lt2", '<a:srgbClr val="E5E7EB"/>'], ["accent1", '<a:srgbClr val="2563EB"/>'],
    ["accent2", '<a:srgbClr val="DC2626"/>'], ["accent3", '<a:srgbClr val="16A34A"/>'], ["accent4", '<a:srgbClr val="9333EA"/>'],
    ["accent5", '<a:srgbClr val="0891B2"/>'], ["accent6", '<a:srgbClr val="EA580C"/>'], ["hlink", '<a:srgbClr val="2563EB"/>'],
    ["folHlink", '<a:srgbClr val="7C3AED"/>']].map(([n, c]) => `<a:${n}>${c}</a:${n}>`).join("");
  const font = (face: string) => `<a:latin typeface="${face}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return xmlDoc(`<a:theme xmlns:a="${A_NS}" name="Mesa"><a:themeElements><a:clrScheme name="Mesa">${colors}</a:clrScheme>` +
    `<a:fontScheme name="Mesa"><a:majorFont>${font("Calibri")}</a:majorFont><a:minorFont>${font("Calibri")}</a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="Mesa"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${`<a:ln w="6350">${fill}</a:ln>`.repeat(3)}</a:lnStyleLst>` +
    `<a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme>` +
    `</a:themeElements></a:theme>`);
}

const NS_DECL = `xmlns:a="${A_NS}" xmlns:r="${REL}" xmlns:p="${P_NS}"`;
const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
const CLR_MAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

function paragraphsXml(paragraphs: readonly string[]): string {
  if (paragraphs.length === 0) return '<a:p><a:endParaRPr lang="en-US"/></a:p>';
  return paragraphs.map((p) => {
    const runs = p.split("\n").map((line) => (line ? `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXmlText(line)}</a:t></a:r>` : "")).join("<a:br><a:rPr lang=\"en-US\"/></a:br>");
    return `<a:p>${runs}</a:p>`;
  }).join("");
}

function placeholder(id: number, name: string, ph: string, paragraphs: readonly string[] | null, xfrm = ""): string {
  const body = paragraphs ? `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphsXml(paragraphs)}</p:txBody>` : "";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xfrm}</p:spPr>${body}</p:sp>`;
}

function box(x: number, y: number, cx: number, cy: number): string {
  return `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
}

export function buildPptx(presentation: LegacyPresentation): Uint8Array {
  const cx = presentation.width ?? DEFAULT_SLIDE.cx;
  const cy = presentation.height ?? DEFAULT_SLIDE.cy;
  const margin = Math.round(cx / 20);
  const titleBox = box(margin, Math.round(cy / 24), cx - 2 * margin, Math.round(cy / 6));
  const bodyBox = box(margin, Math.round(cy / 4), cx - 2 * margin, Math.round((cy * 2) / 3));
  const parts: Record<string, string> = {};
  const overrides: [string, string][] = [
    ["ppt/presentation.xml", `${CT}.presentationml.presentation.main+xml`],
    ["ppt/presProps.xml", `${CT}.presentationml.presProps+xml`],
    ["ppt/slideMasters/slideMaster1.xml", `${CT}.presentationml.slideMaster+xml`],
    ["ppt/slideLayouts/slideLayout1.xml", `${CT}.presentationml.slideLayout+xml`],
    ["ppt/theme/theme1.xml", `${CT}.theme+xml`],
  ];
  const presRels = [
    { id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
    { id: "rId2", type: "presProps", target: "presProps.xml" },
    { id: "rId3", type: "theme", target: "theme/theme1.xml" },
  ];
  const hasNotes = presentation.slides.some((s) => s.notes.length > 0);
  if (hasNotes) {
    presRels.push({ id: "rId4", type: "notesMaster", target: "notesMasters/notesMaster1.xml" });
    overrides.push(["ppt/notesMasters/notesMaster1.xml", `${CT}.presentationml.notesMaster+xml`], ["ppt/theme/theme2.xml", `${CT}.theme+xml`]);
    parts["ppt/notesMasters/notesMaster1.xml"] = xmlDoc(`<p:notesMaster ${NS_DECL}><p:cSld><p:spTree>${GROUP}${placeholder(2, "Notes Placeholder 1", '<p:ph type="body" idx="1"/>', [], box(685800, 4343400, 5486400, 4114800))}</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/></p:notesMaster>`);
    parts["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = relationships([{ id: "rId1", type: "theme", target: "../theme/theme2.xml" }]);
    parts["ppt/theme/theme2.xml"] = theme();
  }
  const slideIds: string[] = [];
  presentation.slides.forEach((slide, i) => {
    const n = i + 1;
    const rId = `rId${10 + i}`;
    presRels.push({ id: rId, type: "slide", target: `slides/slide${n}.xml` });
    slideIds.push(`<p:sldId id="${256 + i}" r:id="${rId}"/>`);
    overrides.push([`ppt/slides/slide${n}.xml`, `${CT}.presentationml.slide+xml`]);
    const shapes = placeholder(2, "Title 1", '<p:ph type="title"/>', [slide.title]) + placeholder(3, "Content 2", '<p:ph idx="1"/>', slide.body);
    parts[`ppt/slides/slide${n}.xml`] = xmlDoc(`<p:sld ${NS_DECL}><p:cSld><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    const slideRels = [{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }];
    if (slide.notes.length > 0) {
      slideRels.push({ id: "rId2", type: "notesSlide", target: `../notesSlides/notesSlide${n}.xml` });
      overrides.push([`ppt/notesSlides/notesSlide${n}.xml`, `${CT}.presentationml.notesSlide+xml`]);
      parts[`ppt/notesSlides/notesSlide${n}.xml`] = xmlDoc(`<p:notes ${NS_DECL}><p:cSld><p:spTree>${GROUP}${placeholder(2, "Notes Placeholder 1", '<p:ph type="body" idx="1"/>', slide.notes)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
      parts[`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`] = relationships([
        { id: "rId1", type: "notesMaster", target: "../notesMasters/notesMaster1.xml" },
        { id: "rId2", type: "slide", target: `../slides/slide${n}.xml` },
      ]);
    }
    parts[`ppt/slides/_rels/slide${n}.xml.rels`] = relationships(slideRels);
  });
  const notesMasterList = hasNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId4"/></p:notesMasterIdLst>' : "";
  const sldIdLst = slideIds.length ? `<p:sldIdLst>${slideIds.join("")}</p:sldIdLst>` : "";
  return zip({
    "[Content_Types].xml": contentTypes(overrides),
    "_rels/.rels": relationships([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }]),
    "ppt/presentation.xml": xmlDoc(`<p:presentation ${NS_DECL}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${notesMasterList}${sldIdLst}<p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": relationships(presRels),
    "ppt/presProps.xml": xmlDoc(`<p:presentationPr ${NS_DECL}/>`),
    "ppt/slideMasters/slideMaster1.xml": xmlDoc(`<p:sldMaster ${NS_DECL}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}` +
      placeholder(2, "Title Placeholder 1", '<p:ph type="title"/>', [], titleBox) + placeholder(3, "Text Placeholder 2", '<p:ph type="body" idx="1"/>', [], bodyBox) +
      `</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
      `<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3600"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle><p:otherStyle/></p:txStyles></p:sldMaster>`),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": relationships([
      { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: "theme", target: "../theme/theme1.xml" },
    ]),
    "ppt/slideLayouts/slideLayout1.xml": xmlDoc(`<p:sldLayout ${NS_DECL} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${GROUP}` +
      placeholder(2, "Title 1", '<p:ph type="title"/>', []) + placeholder(3, "Content Placeholder 2", '<p:ph idx="1"/>', []) +
      `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": relationships([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]),
    "ppt/theme/theme1.xml": theme(),
    ...parts,
  });
}

function verifyPptx(bytes: Uint8Array, presentation: LegacyPresentation): void {
  const opened = openPresentation(bytes, "pptx");
  const slides = opened.deck.slides;
  if (slides.length !== presentation.slides.length || opened.deck.missingSlides > 0) throw new Error("The new presentation does not read back with the same slides.");
  slides.forEach((s, i) => {
    if (!s.layoutPart || !s.masterPart || !s.themePart) throw new Error("A slide in the new presentation has no layout.");
    if ((presentation.slides[i].notes.length > 0) !== (s.notesPart !== null)) throw new Error("The new presentation does not keep the speaker notes.");
  });
  if (!opened.policy.canEdit) throw new Error(`The new presentation would not be editable: ${opened.policy.refusals.join("; ")}.`);
}

/** Builds the editable copy's bytes. */
export function buildEditableCopy(content: LegacyOfficeContent): Uint8Array {
  if (content.kind === "word") return buildDocx(content.document);
  if (content.kind === "excel") return buildXlsx(content.workbook);
  return buildPptx(content.presentation);
}

/** Opens `bytes` through Mesa's package layer and checks it carries `content`. Throws when not. */
export function verifyEditableCopy(content: LegacyOfficeContent, bytes: Uint8Array): void {
  if (content.kind === "word") verifyDocx(bytes, content.document);
  else if (content.kind === "excel") verifyXlsx(bytes, content.workbook);
  else verifyPptx(bytes, content.presentation);
}
