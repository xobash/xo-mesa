import { BUILTIN_NUMBER_FORMATS, compileNumberFormat, type CompiledNumberFormat } from "./xlsxNumberFormat";
import { decodeXmlText, localName, nextTag, readAttributes, type XmlTagAt } from "./xmlScan";

// The display subset of a SpreadsheetML style sheet (ECMA-376 Part 1, 18.8):
// number formats, bold/italic/underline/strike, explicit RGB font and solid
// fill colours, horizontal alignment and wrapping. Theme and indexed colours
// are not resolved; the cell then uses the sheet's default ink and paper.

export interface CellStyle {
  readonly numberFormat: CompiledNumberFormat;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  /** `#RRGGBB` or `null`. */
  readonly color: string | null;
  readonly fill: string | null;
  readonly align: "left" | "center" | "right" | null;
  readonly wrap: boolean;
}

interface Font { bold: boolean; italic: boolean; underline: boolean; strike: boolean; color: string | null }

const NO_FONT: Font = { bold: false, italic: false, underline: false, strike: false, color: null };
export const DEFAULT_CELL_STYLE: CellStyle = {
  numberFormat: compileNumberFormat("General"), ...NO_FONT, fill: null, align: null, wrap: false,
};

function rgb(value: string | undefined): string | null {
  const match = value ? /^(?:[0-9A-Fa-f]{2})?([0-9A-Fa-f]{6})$/.exec(value) : null;
  return match ? `#${match[1].toUpperCase()}` : null;
}

function flag(attrs: Map<string, string>): boolean {
  const val = attrs.get("val");
  return val === undefined || !(val === "0" || val === "false" || val === "none");
}

/** Visits the tags inside one top-level section (e.g. `fonts`), in order. */
function forEachSectionTag(xml: string, section: string, visit: (tag: XmlTagAt, name: string) => void): void {
  let at = 0;
  let inside = false;
  for (let guard = 0; guard <= xml.length; guard++) {
    const tag = nextTag(xml, at);
    if (!tag) return;
    at = tag.end;
    const name = localName(tag.qname);
    if (!inside) {
      if (name === section && tag.kind === "start") inside = true;
      continue;
    }
    if (name === section && tag.kind === "end") return;
    visit(tag, name);
  }
}

function attrsOf(xml: string, tag: XmlTagAt): Map<string, string> {
  return readAttributes(xml.slice(tag.attrStart, tag.attrEnd));
}

function parseNumberFormats(xml: string): Map<number, string> {
  const formats = new Map<number, string>();
  forEachSectionTag(xml, "numFmts", (tag, name) => {
    if (name !== "numFmt" || tag.kind === "end") return;
    const attrs = attrsOf(xml, tag);
    const id = Number(attrs.get("numFmtId"));
    if (Number.isInteger(id)) formats.set(id, decodeXmlText(attrs.get("formatCode") ?? ""));
  });
  return formats;
}

function parseFonts(xml: string): Font[] {
  const fonts: Font[] = [];
  let current: Font | null = null;
  forEachSectionTag(xml, "fonts", (tag, name) => {
    if (name === "font") {
      if (tag.kind === "start") current = { ...NO_FONT };
      else fonts.push(tag.kind === "empty" ? { ...NO_FONT } : current ?? { ...NO_FONT });
      return;
    }
    if (!current || tag.kind === "end") return;
    const attrs = attrsOf(xml, tag);
    if (name === "b") current.bold = flag(attrs);
    else if (name === "i") current.italic = flag(attrs);
    else if (name === "u") current.underline = flag(attrs);
    else if (name === "strike") current.strike = flag(attrs);
    else if (name === "color") current.color = rgb(attrs.get("rgb"));
  });
  return fonts;
}

function parseFills(xml: string): Array<string | null> {
  const fills: Array<string | null> = [];
  let solid = false;
  let color: string | null = null;
  forEachSectionTag(xml, "fills", (tag, name) => {
    if (name === "fill") {
      if (tag.kind === "start") { solid = false; color = null; }
      else fills.push(tag.kind === "empty" || !solid ? null : color);
      return;
    }
    if (tag.kind === "end") return;
    const attrs = attrsOf(xml, tag);
    if (name === "patternFill") solid = attrs.get("patternType") === "solid";
    else if (name === "fgColor") color = rgb(attrs.get("rgb"));
  });
  return fills;
}

interface Xf { numFmtId: number; fontId: number; fillId: number; align: CellStyle["align"]; wrap: boolean }

function parseCellXfs(xml: string): Xf[] {
  const xfs: Xf[] = [];
  forEachSectionTag(xml, "cellXfs", (tag, name) => {
    if (tag.kind === "end") return;
    const attrs = attrsOf(xml, tag);
    if (name === "xf") {
      xfs.push({
        numFmtId: Number(attrs.get("numFmtId") ?? 0), fontId: Number(attrs.get("fontId") ?? 0),
        fillId: Number(attrs.get("fillId") ?? 0), align: null, wrap: false,
      });
    } else if (name === "alignment" && xfs.length) {
      const last = xfs[xfs.length - 1];
      const horizontal = attrs.get("horizontal");
      last.align = horizontal === "center" || horizontal === "centerContinuous" ? "center"
        : horizontal === "right" ? "right" : horizontal === "left" ? "left" : null;
      last.wrap = attrs.get("wrapText") === "1" || attrs.get("wrapText") === "true";
    }
  });
  return xfs;
}

/** Cell styles indexed by the `s` attribute of a cell. */
export function parseCellStyles(xml: string): CellStyle[] {
  const formats = parseNumberFormats(xml);
  const fonts = parseFonts(xml);
  const fills = parseFills(xml);
  const compiled = new Map<number, CompiledNumberFormat>();
  const formatFor = (id: number): CompiledNumberFormat => {
    const cached = compiled.get(id);
    if (cached) return cached;
    const next = compileNumberFormat(formats.get(id) ?? BUILTIN_NUMBER_FORMATS[id] ?? "General");
    compiled.set(id, next);
    return next;
  };
  return parseCellXfs(xml).map((xf) => {
    const font = fonts[xf.fontId] ?? NO_FONT;
    return { numberFormat: formatFor(xf.numFmtId), ...font, fill: fills[xf.fillId] ?? null, align: xf.align, wrap: xf.wrap };
  });
}
