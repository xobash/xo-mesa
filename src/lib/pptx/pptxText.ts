import { resolveColor, resolveTypeface, type ThemeInfo } from "./pptxColor";
import { attr, child, intAttr, plainText, type XmlDoc, type XmlEl } from "./xmlTree";

// DrawingML text body → render model. Properties resolve through the
// paragraph, then level styles in priority order (shape list style,
// layout and master placeholder list styles, master text styles,
// presentation default text style). Unmodelled properties are ignored.

export interface RenderRun {
  readonly text: string;
  /** Font size in hundredths of a point. */
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly color: string | null;
  readonly font: string | null;
}

export interface RenderParagraph {
  readonly align: "left" | "center" | "right" | "justify";
  readonly level: number;
  /** Left margin and first-line indent, EMU. */
  readonly marginLeft: number;
  readonly indent: number;
  readonly bullet: { readonly text: string; readonly color: string | null } | null;
  readonly runs: readonly RenderRun[];
  /** Size of an empty paragraph's line, hundredths of a point. */
  readonly emptySize: number;
}

export interface RenderText {
  readonly anchor: "top" | "middle" | "bottom";
  /** Insets in EMU: left, top, right, bottom. */
  readonly insets: readonly [number, number, number, number];
  readonly wrap: boolean;
  readonly paragraphs: readonly RenderParagraph[];
}

export interface TextStyleContext {
  readonly theme: ThemeInfo;
  /** `lstStyle`-like containers holding `lvl1pPr`…`lvl9pPr`, highest priority first. */
  readonly levelSources: readonly (XmlEl | null)[];
  /** `bodyPr` elements, highest priority first. */
  readonly bodyProps: readonly (XmlEl | null)[];
  /** Text colour from the shape style's font reference. */
  readonly styleColor: string | null;
}

const DEFAULT_SIZE = 1800;
const ALIGN: Record<string, RenderParagraph["align"]> = { l: "left", ctr: "center", r: "right", just: "justify", dist: "justify" };
const ANCHOR: Record<string, RenderText["anchor"]> = { t: "top", ctr: "middle", b: "bottom" };
const SYMBOL_FONTS = /wingdings|symbol|webdings/i;

function levelProps(ctx: TextStyleContext, pPr: XmlEl | null, level: number): XmlEl[] {
  const out: XmlEl[] = [];
  if (pPr) out.push(pPr);
  for (const source of ctx.levelSources) {
    const lvl = child(source, `lvl${level + 1}pPr`);
    if (lvl) out.push(lvl);
  }
  return out;
}

function firstAttr(chain: readonly (XmlEl | null)[], name: string): string | null {
  for (const el of chain) {
    const value = attr(el, name);
    if (value !== null) return value;
  }
  return null;
}

function firstChild(chain: readonly (XmlEl | null)[], locals: readonly string[]): XmlEl | null {
  for (const el of chain) {
    const found = el?.children.find((c) => locals.includes(c.localName));
    if (found) return found;
  }
  return null;
}

function resolveRun(ctx: TextStyleContext, rPr: XmlEl | null, defaults: readonly XmlEl[], text: string, scale: number): RenderRun {
  const chain = [rPr, ...defaults];
  const flag = (name: string) => { const v = firstAttr(chain, name); return v === "1" || v === "true"; };
  const underline = firstAttr(chain, "u");
  const strike = firstAttr(chain, "strike");
  const fill = firstChild(chain, ["solidFill", "noFill", "gradFill"]);
  const size = Number(firstAttr(chain, "sz")) || DEFAULT_SIZE;
  const caps = firstAttr(chain, "cap");
  const latin = firstChild(chain, ["latin"]);
  return {
    text: caps === "all" ? text.toUpperCase() : text,
    size: Math.max(100, Math.round(size * scale)),
    bold: flag("b"), italic: flag("i"),
    underline: underline !== null && underline !== "none",
    strike: strike !== null && strike !== "noStrike",
    color: fill?.localName === "solidFill" ? resolveColor(fill, ctx.theme) : fill?.localName === "gradFill" ? resolveColor(child(child(fill, "gsLst"), "gs"), ctx.theme) : ctx.styleColor,
    font: resolveTypeface(attr(latin, "typeface"), ctx.theme),
  };
}

const ROMAN: ReadonlyArray<[number, string]> = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];

function roman(n: number): string {
  let rest = Math.min(3999, Math.max(1, n));
  let out = "";
  for (const [value, digits] of ROMAN) while (rest >= value) { out += digits; rest -= value; }
  return out;
}

function alpha(n: number): string {
  const letter = String.fromCharCode(97 + ((Math.max(1, n) - 1) % 26));
  return letter.repeat(Math.floor((Math.max(1, n) - 1) / 26) + 1);
}

/** Bullet label for an auto-number scheme such as `arabicPeriod` or `romanUcParenR`. */
export function autoNumberLabel(scheme: string, n: number): string {
  const base = scheme.startsWith("alphaLc") ? alpha(n) : scheme.startsWith("alphaUc") ? alpha(n).toUpperCase()
    : scheme.startsWith("romanLc") ? roman(n) : scheme.startsWith("romanUc") ? roman(n).toUpperCase() : String(n);
  if (scheme.endsWith("ParenBoth")) return `(${base})`;
  if (scheme.endsWith("ParenR")) return `${base})`;
  if (scheme.endsWith("Plain")) return base;
  return `${base}.`;
}

interface Numbering { counters: number[] }

function resolveBullet(ctx: TextStyleContext, props: readonly XmlEl[], level: number, hasText: boolean, numbering: Numbering): RenderParagraph["bullet"] {
  for (let deeper = level + 1; deeper < numbering.counters.length; deeper++) numbering.counters[deeper] = 0;
  const kind = firstChild(props, ["buNone", "buChar", "buAutoNum", "buBlip"]);
  if (!kind || kind.localName === "buNone" || !hasText) {
    if (kind?.localName !== "buAutoNum") numbering.counters[level] = 0;
    return null;
  }
  const color = resolveColor(firstChild(props, ["buClr"]), ctx.theme);
  if (kind.localName === "buBlip") return { text: "•", color };
  if (kind.localName === "buAutoNum") {
    const start = intAttr(kind, "startAt", 1);
    numbering.counters[level] = (numbering.counters[level] || start - 1) + 1;
    return { text: autoNumberLabel(attr(kind, "type") ?? "arabicPeriod", numbering.counters[level]), color };
  }
  const font = attr(firstChild(props, ["buFont"]), "typeface") ?? "";
  const char = attr(kind, "char") ?? "•";
  return { text: SYMBOL_FONTS.test(font) ? "•" : char, color };
}

function paragraphRuns(doc: XmlDoc, ctx: TextStyleContext, p: XmlEl, defaults: readonly XmlEl[], scale: number): RenderRun[] {
  const runs: RenderRun[] = [];
  for (const node of p.children) {
    if (node.localName === "r" || node.localName === "fld") {
      const t = child(node, "t");
      const text = t ? plainText(doc, t) ?? "" : "";
      runs.push(resolveRun(ctx, child(node, "rPr"), defaults, text, scale));
    } else if (node.localName === "br") runs.push(resolveRun(ctx, child(node, "rPr"), defaults, "\n", scale));
  }
  return runs;
}

/** Render model for one `txBody` element. */
export function renderTextBody(doc: XmlDoc, body: XmlEl, ctx: TextStyleContext): RenderText {
  const bodyChain = [child(body, "bodyPr"), ...ctx.bodyProps];
  const inset = (name: string, fallback: number) => Number(firstAttr(bodyChain, name) ?? fallback) || 0;
  const autofit = firstChild(bodyChain, ["normAutofit", "noAutofit", "spAutoFit"]);
  const scale = autofit?.localName === "normAutofit" ? Math.min(1, Math.max(0.1, intAttr(autofit, "fontScale", 100_000) / 100_000)) : 1;
  const numbering: Numbering = { counters: new Array(9).fill(0) };
  const lstStyle = child(body, "lstStyle");
  const scoped: TextStyleContext = lstStyle ? { ...ctx, levelSources: [lstStyle, ...ctx.levelSources] } : ctx;
  const paragraphs: RenderParagraph[] = body.children.filter((c) => c.localName === "p").map((p) => {
    const pPr = child(p, "pPr");
    const level = Math.min(8, Math.max(0, intAttr(pPr, "lvl", 0)));
    const props = levelProps(scoped, pPr, level);
    const defaults = props.map((el) => child(el, "defRPr")).filter((el): el is XmlEl => el !== null);
    const runs = paragraphRuns(doc, scoped, p, defaults, scale);
    const endSize = resolveRun(scoped, child(p, "endParaRPr"), defaults, "", scale).size;
    return {
      align: ALIGN[firstAttr(props, "algn") ?? "l"] ?? "left",
      level,
      marginLeft: Number(firstAttr(props, "marL") ?? 0) || 0,
      indent: Number(firstAttr(props, "indent") ?? 0) || 0,
      bullet: resolveBullet(scoped, props, level, runs.some((r) => r.text.trim() !== ""), numbering),
      runs,
      emptySize: endSize,
    };
  });
  return {
    anchor: ANCHOR[firstAttr(bodyChain, "anchor") ?? "t"] ?? "top",
    insets: [inset("lIns", 91_440), inset("tIns", 45_720), inset("rIns", 91_440), inset("bIns", 45_720)],
    wrap: firstAttr(bodyChain, "wrap") !== "none",
    paragraphs,
  };
}

/** Plain text of a text body: paragraphs joined by newlines, line breaks as spaces. */
export function textBodyPlainText(doc: XmlDoc, body: XmlEl): string {
  return body.children.filter((c) => c.localName === "p").map((p) => p.children.map((node) => {
    if (node.localName === "br") return " ";
    const t = node.localName === "r" || node.localName === "fld" ? child(node, "t") : null;
    return t ? plainText(doc, t) ?? "" : "";
  }).join("")).join("\n");
}
