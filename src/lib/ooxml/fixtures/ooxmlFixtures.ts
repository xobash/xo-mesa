import { Zip, ZipDeflate, ZipPassThrough, strToU8, zipSync, type Zippable } from "fflate";

// Hand-made, licence-clean OOXML fixtures for tests. Packages are written by
// fflate (an independent ZIP writer), never by the code under test.

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const FIXED_TIME = new Date(2024, 0, 2, 3, 4, 6);

export type FixtureParts = Record<string, string | Uint8Array>;

export function xmlHeader(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${body}`;
}

export function contentTypes(overrides: Record<string, string>, defaults: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    rels: "application/vnd.openxmlformats-package.relationships+xml",
    xml: "application/xml",
    ...defaults,
  };
  const d = Object.entries(base).map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join("");
  const o = Object.entries(overrides).map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join("");
  return xmlHeader(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${d}${o}</Types>`);
}

export function relationships(rels: Array<{ id: string; type: string; target: string; external?: boolean }>): string {
  const items = rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type.startsWith("http") ? r.type : `${REL}/${r.type}`}" Target="${r.target}"${r.external ? ' TargetMode="External"' : ""}/>`).join("");
  return xmlHeader(`<Relationships xmlns="${PKG_RELS_NS}">${items}</Relationships>`);
}

export function wordDocumentXml(body: string, prefix = "w"): string {
  return xmlHeader(`<${prefix}:document xmlns:${prefix}="${W_NS}" xmlns:r="${R_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><${prefix}:body>${body}</${prefix}:body></${prefix}:document>`);
}

export const WORD_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

/** A minimal .docx; `extra` parts are added and may replace defaults. */
export function docxParts(body = "<w:p><w:r><w:t>Hello</w:t></w:r></w:p>", extra: FixtureParts = {}, extraOverrides: Record<string, string> = {}, docRels: Parameters<typeof relationships>[0] = []): FixtureParts {
  return {
    "[Content_Types].xml": contentTypes({ "word/document.xml": WORD_MAIN, "docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml", ...extraOverrides }),
    "_rels/.rels": relationships([
      { id: "rId1", type: "officeDocument", target: "word/document.xml" },
      { id: "rId2", type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", target: "docProps/core.xml" },
    ]),
    "word/document.xml": wordDocumentXml(body),
    "word/_rels/document.xml.rels": relationships(docRels),
    "docProps/core.xml": xmlHeader('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"/>'),
    ...extra,
  };
}

export function xlsxParts(extra: FixtureParts = {}, extraOverrides: Record<string, string> = {}): FixtureParts {
  return {
    "[Content_Types].xml": contentTypes({
      "xl/workbook.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
      "xl/worksheets/sheet1.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
      ...extraOverrides,
    }),
    "_rels/.rels": relationships([{ id: "rId1", type: "officeDocument", target: "xl/workbook.xml" }]),
    "xl/workbook.xml": xmlHeader('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="A" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": relationships([{ id: "rId1", type: "worksheet", target: "worksheets/sheet1.xml" }]),
    "xl/worksheets/sheet1.xml": xmlHeader('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>1</t></is></c></row></sheetData></worksheet>'),
    ...extra,
  };
}

export function pptxParts(extra: FixtureParts = {}, extraOverrides: Record<string, string> = {}): FixtureParts {
  return {
    "[Content_Types].xml": contentTypes({
      "ppt/presentation.xml": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
      "ppt/slides/slide1.xml": "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
      ...extraOverrides,
    }),
    "_rels/.rels": relationships([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }]),
    "ppt/presentation.xml": xmlHeader('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'),
    "ppt/_rels/presentation.xml.rels": relationships([{ id: "rId1", type: "slide", target: "slides/slide1.xml" }]),
    "ppt/slides/slide1.xml": xmlHeader('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'),
    ...extra,
  };
}

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? strToU8(value) : value;
}

/** Ordinary package: deflated entries, fixed timestamps, optional archive comment. */
export function buildPackage(parts: FixtureParts, options: { comment?: string; stored?: readonly string[] } = {}): Uint8Array {
  const files: Zippable = {};
  for (const [name, value] of Object.entries(parts)) {
    files[name] = [toBytes(value), { level: options.stored?.includes(name) ? 0 : 6, mtime: FIXED_TIME }];
  }
  const zipped = zipSync(files);
  if (!options.comment) return zipped;
  // fflate writes per-entry comments only; append an archive comment to the end record.
  const comment = strToU8(options.comment);
  const out = new Uint8Array(zipped.length + comment.length);
  out.set(zipped);
  out.set(comment, zipped.length);
  new DataView(out.buffer).setUint16(zipped.length - 2, comment.length, true);
  return out;
}

/** Streaming package: every entry carries a data descriptor (general-purpose flag bit 3). */
export function buildStreamedPackage(parts: FixtureParts): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, value] of Object.entries(parts)) {
    const entry = name.endsWith(".png") ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
    entry.mtime = FIXED_TIME;
    zip.add(entry);
    entry.push(toBytes(value), true);
  }
  zip.end();
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
