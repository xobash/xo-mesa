import { readRelationships, type OoxmlPackage } from "./ooxmlPackage";
import { parseCellStyles, type CellStyle } from "./xlsxStyles";
import { parseSharedStrings } from "./xlsxText";
import { decodeXmlPart, decodeXmlText, localName, nextTag, prefixOf, readAttributes } from "./xmlScan";
import { OoxmlPackageError } from "./zipContainer";

// Workbook-level model of an opened SpreadsheetML package (ECMA-376 Part 1,
// 18.2 workbook): the sheet list, defined names, date system and the parts a
// sheet needs to show values. Shared strings and styles parse on first use.

export const STRICT_SPREADSHEET_NS = "http://purl.oclc.org/ooxml/spreadsheetml/main";
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export type SheetKind = "worksheet" | "chartsheet" | "dialogsheet" | "macrosheet" | "unknown";

export interface WorkbookSheet {
  readonly name: string;
  readonly sheetId: string;
  readonly relId: string;
  /** Resolved part name, or `null` when the relationship is missing. */
  readonly part: string | null;
  readonly kind: SheetKind;
  readonly state: "visible" | "hidden" | "veryHidden";
}

export interface DefinedName {
  readonly name: string;
  readonly text: string;
  readonly localSheetId: number | null;
}

export interface XlsxWorkbook {
  readonly pkg: OoxmlPackage;
  readonly workbookPart: string;
  readonly workbookXml: string;
  /** SpreadsheetML prefix with colon, or "". */
  readonly pfx: string;
  readonly strict: boolean;
  readonly date1904: boolean;
  readonly sheets: readonly WorkbookSheet[];
  readonly definedNames: readonly DefinedName[];
  readonly sharedStringsPart: string | null;
  readonly stylesPart: string | null;
  readonly calcChainPart: string | null;
  sharedStrings(): readonly string[];
  styles(): readonly CellStyle[];
  /** Decoded XML text of a part (cached). */
  partText(part: string): string;
  /** True when the part decodes and re-encodes to the same bytes (UTF-8, no BOM change). */
  roundTrips(part: string): boolean;
}

function sheetKind(type: string): SheetKind {
  const tail = type.slice(type.lastIndexOf("/") + 1).toLowerCase();
  if (tail === "worksheet") return "worksheet";
  if (tail === "chartsheet") return "chartsheet";
  if (tail === "dialogsheet") return "dialogsheet";
  if (tail === "xlmacrosheet" || tail === "xlintlmacrosheet") return "macrosheet";
  return "unknown";
}

function relationshipId(attrs: Map<string, string>): string {
  for (const [name, value] of attrs) if (localName(name) === "id" && name.includes(":")) return value;
  return "";
}

function parseWorkbookXml(xml: string) {
  const sheets: Array<Omit<WorkbookSheet, "part" | "kind">> = [];
  const definedNames: DefinedName[] = [];
  let date1904 = false;
  let strict = false;
  let pfx = "";
  let at = 0;
  for (let guard = 0; guard <= xml.length; guard++) {
    const tag = nextTag(xml, at);
    if (!tag) break;
    at = tag.end;
    if (tag.kind === "end") continue;
    const name = localName(tag.qname);
    const attrs = readAttributes(xml.slice(tag.attrStart, tag.attrEnd));
    if (name === "workbook") {
      pfx = prefixOf(tag.qname) ? `${prefixOf(tag.qname)}:` : "";
      strict = [...attrs.values()].includes(STRICT_SPREADSHEET_NS);
    } else if (name === "workbookPr") {
      date1904 = attrs.get("date1904") === "1" || attrs.get("date1904") === "true";
    } else if (name === "sheet") {
      const state = attrs.get("state");
      sheets.push({
        name: decodeXmlText(attrs.get("name") ?? ""), sheetId: attrs.get("sheetId") ?? "", relId: relationshipId(attrs),
        state: state === "hidden" || state === "veryHidden" ? state : "visible",
      });
    } else if (name === "definedName" && tag.kind === "start") {
      const close = xml.indexOf("</", tag.end);
      const local = attrs.get("localSheetId");
      definedNames.push({
        name: decodeXmlText(attrs.get("name") ?? ""), text: decodeXmlText(xml.slice(tag.end, close < 0 ? tag.end : close)),
        localSheetId: local === undefined ? null : Number(local),
      });
    }
  }
  return { sheets, definedNames, date1904, strict, pfx };
}

/**
 * True when decoding and re-encoding gives the same bytes: valid UTF-8 (a
 * fatal decoder rejects malformed and overlong sequences), not UTF-16.
 * `encodePartLike` restores a UTF-8 byte-order mark.
 */
function isStrictUtf8(bytes: Uint8Array): boolean {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** UTF-8 bytes for edited part text, keeping the original part's byte-order mark. */
export function encodePartLike(original: Uint8Array | undefined, text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!original || original[0] !== UTF8_BOM[0] || original[1] !== UTF8_BOM[1] || original[2] !== UTF8_BOM[2]) return body;
  const out = new Uint8Array(body.length + 3);
  out.set(UTF8_BOM);
  out.set(body, 3);
  return out;
}

/** Opens the workbook model of a spreadsheet package. Throws `OoxmlPackageError` when it is not one. */
export function openXlsxWorkbook(pkg: OoxmlPackage): XlsxWorkbook {
  if (pkg.kind !== "spreadsheet" || !pkg.mainPart) throw new OoxmlPackageError("malformed", "This package is not an Excel workbook.");
  const workbookPart = pkg.mainPart;
  const texts = new Map<string, string>();
  const partText = (part: string): string => {
    const cached = texts.get(part);
    if (cached !== undefined) return cached;
    const bytes = pkg.parts.get(part);
    if (!bytes) throw new OoxmlPackageError("malformed", `The workbook part ${part} is missing.`);
    const text = decodeXmlPart(bytes);
    texts.set(part, text);
    return text;
  };
  const workbookXml = partText(workbookPart);
  const parsed = parseWorkbookXml(workbookXml);
  const rels = readRelationships(pkg, workbookPart);
  const relPart = (suffix: string) => rels.find((r) => !r.external && r.type.endsWith(suffix) && r.targetPart && pkg.parts.has(r.targetPart))?.targetPart ?? null;
  const sheets = parsed.sheets.map((sheet): WorkbookSheet => {
    const rel = rels.find((r) => r.id === sheet.relId && !r.external);
    const part = rel?.targetPart && pkg.parts.has(rel.targetPart) ? rel.targetPart : null;
    return { ...sheet, part, kind: rel ? sheetKind(rel.type) : "unknown" };
  });
  const sharedStringsPart = relPart("/sharedStrings");
  const stylesPart = relPart("/styles");
  let strings: string[] | null = null;
  let styles: CellStyle[] | null = null;
  const roundTrip = new Map<string, boolean>();
  const prefixFor = (xml: string) => {
    const root = nextTag(xml, 0);
    const p = root ? prefixOf(root.qname) : "";
    return p ? `${p}:` : "";
  };
  return {
    pkg, workbookPart, workbookXml, pfx: parsed.pfx, strict: parsed.strict, date1904: parsed.date1904,
    sheets, definedNames: parsed.definedNames, sharedStringsPart, stylesPart, calcChainPart: relPart("/calcChain"),
    sharedStrings: () => {
      if (!strings) {
        const xml = sharedStringsPart ? partText(sharedStringsPart) : "";
        strings = xml ? parseSharedStrings(xml, prefixFor(xml)) : [];
      }
      return strings;
    },
    styles: () => (styles ??= stylesPart ? parseCellStyles(partText(stylesPart)) : []),
    partText,
    roundTrips: (part) => {
      const known = roundTrip.get(part);
      if (known !== undefined) return known;
      const bytes = pkg.parts.get(part);
      const same = !!bytes && isStrictUtf8(bytes);
      roundTrip.set(part, same);
      return same;
    },
  };
}

/** Workbook relationship type URI for a part kind, e.g. `worksheet`. */
export function workbookRelType(kind: string): string {
  return `${REL_TYPE}/${kind}`;
}

