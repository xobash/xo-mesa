import { NS, relById, xmlOf, type Deck, type DeckSlide, type PartView } from "./pptxDeck";
import { readTheme, resolveColor, themeTextColor, type ThemeInfo } from "./pptxColor";
import { renderTextBody, textBodyPlainText, type RenderText, type TextStyleContext } from "./pptxText";
import { textBodyEditRefusal, textBodyIndex } from "./pptxTextEdit";
import { attr, child, descendants, intAttr, nsAttr, path, type XmlDoc, type XmlEl } from "./xmlTree";

// Slide → positioned render model (EMU coordinates). Masters and layouts
// contribute background and non-placeholder shapes; placeholders inherit
// position and text style from their layout and master. Anything Mesa does
// not draw becomes a labelled placeholder, never a silent gap.

export interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly rot: number; readonly flipH: boolean; readonly flipV: boolean }

export type Fill = { readonly color: string } | { readonly image: string } | null;

export interface TextBodyRef { readonly part: string; readonly index: number }

export type RenderShape =
  | { readonly kind: "shape"; readonly key: string; readonly box: Box; readonly geometry: "rect" | "roundRect" | "ellipse" | "other";
      readonly geometryName: string; readonly fill: Fill; readonly line: { readonly color: string; readonly width: number } | null;
      readonly text: RenderText | null; readonly body: TextBodyRef | null; readonly editRefusal: string | null; readonly plain: string }
  | { readonly kind: "picture"; readonly key: string; readonly box: Box; readonly image: string | null; readonly label: string | null }
  | { readonly kind: "line"; readonly key: string; readonly box: Box; readonly color: string; readonly width: number }
  | { readonly kind: "table"; readonly key: string; readonly box: Box; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: "placeholder"; readonly key: string; readonly box: Box; readonly label: string };

export interface RenderSlide {
  readonly width: number;
  readonly height: number;
  readonly background: Fill;
  readonly shapes: readonly RenderShape[];
  readonly omitted: number;
}

export const MAX_SHAPES_PER_SLIDE = 4000;
const RENDERABLE_IMAGE = /^image\/(png|jpeg|gif|bmp|webp|svg\+xml)$/i;
const IMAGE_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml" };

/** MIME type of a renderable picture part, else `null` (EMF, WMF, TIFF …). */
export function imageMime(view: PartView, part: string): string | null {
  const declared = view.contentTypeOf(part);
  if (declared && RENDERABLE_IMAGE.test(declared)) return declared.toLowerCase();
  if (declared) return null;
  return IMAGE_BY_EXT[part.slice(part.lastIndexOf(".") + 1).toLowerCase()] ?? null;
}

interface Layer { readonly part: string; readonly doc: XmlDoc }

interface SlideContext {
  readonly view: PartView;
  readonly theme: ThemeInfo;
  readonly slide: Layer;
  readonly layout: Layer | null;
  readonly master: Layer | null;
  readonly defaultTextStyle: XmlEl | null;
}

interface Transform { readonly sx: number; readonly sy: number; readonly dx: number; readonly dy: number }
const IDENTITY: Transform = { sx: 1, sy: 1, dx: 0, dy: 0 };

function layer(view: PartView, part: string | null): Layer | null {
  const doc = part ? xmlOf(view, part) : null;
  return part && doc ? { part, doc } : null;
}

function readBox(xfrm: XmlEl | null, t: Transform): Box | null {
  const off = child(xfrm, "off");
  const ext = child(xfrm, "ext");
  if (!off || !ext) return null;
  return {
    x: intAttr(off, "x", 0) * t.sx + t.dx, y: intAttr(off, "y", 0) * t.sy + t.dy,
    w: Math.max(0, intAttr(ext, "cx", 0) * t.sx), h: Math.max(0, intAttr(ext, "cy", 0) * t.sy),
    rot: intAttr(xfrm, "rot", 0) / 60_000, flipH: attr(xfrm, "flipH") === "1", flipV: attr(xfrm, "flipV") === "1",
  };
}

function groupTransform(grpSpPr: XmlEl | null, parent: Transform): Transform {
  const xfrm = child(grpSpPr, "xfrm");
  const off = child(xfrm, "off"); const ext = child(xfrm, "ext");
  const chOff = child(xfrm, "chOff"); const chExt = child(xfrm, "chExt");
  if (!off || !ext || !chOff || !chExt) return parent;
  const sx = intAttr(chExt, "cx", 0) ? intAttr(ext, "cx", 0) / intAttr(chExt, "cx", 1) : 1;
  const sy = intAttr(chExt, "cy", 0) ? intAttr(ext, "cy", 0) / intAttr(chExt, "cy", 1) : 1;
  const lx = intAttr(off, "x", 0) - intAttr(chOff, "x", 0) * sx;
  const ly = intAttr(off, "y", 0) - intAttr(chOff, "y", 0) * sy;
  return { sx: parent.sx * sx, sy: parent.sy * sy, dx: parent.sx * lx + parent.dx, dy: parent.sy * ly + parent.dy };
}

interface PlaceholderKey { readonly type: string; readonly idx: string | null }

function placeholderOf(shape: XmlEl): PlaceholderKey | null {
  const nv = shape.children.find((c) => c.localName.startsWith("nv"));
  const ph = path(nv, "nvPr", "ph");
  return ph ? { type: attr(ph, "type") ?? "obj", idx: attr(ph, "idx") } : null;
}

const MASTER_TYPE: Record<string, string> = { ctrTitle: "title", subTitle: "body", obj: "body" };

function findPlaceholder(scope: Layer | null, key: PlaceholderKey, byType: boolean): XmlEl | null {
  if (!scope) return null;
  const tree = path(scope.doc.root, "cSld", "spTree");
  const shapes = tree ? descendants(tree).filter((el) => el.localName === "sp" || el.localName === "pic") : [];
  const wanted = byType ? MASTER_TYPE[key.type] ?? key.type : key.type;
  const matchIdx = key.idx !== null ? shapes.find((s) => placeholderOf(s)?.idx === key.idx) : undefined;
  if (matchIdx && !byType) return matchIdx;
  return shapes.find((s) => {
    const ph = placeholderOf(s);
    return ph !== null && (byType ? (MASTER_TYPE[ph.type] ?? ph.type) === wanted : ph.type === key.type);
  }) ?? matchIdx ?? null;
}

function textStyleFor(ctx: SlideContext, key: PlaceholderKey | null): XmlEl | null {
  const styles = child(ctx.master?.doc.root, "txStyles");
  if (!key) return child(styles, "otherStyle");
  if (key.type === "title" || key.type === "ctrTitle") return child(styles, "titleStyle");
  if (key.type === "dt" || key.type === "ftr" || key.type === "sldNum" || key.type === "hdr") return child(styles, "otherStyle");
  return child(styles, "bodyStyle");
}

function readFill(holder: XmlEl | null, ctx: SlideContext, sourcePart: string, placeholderColor: string | null = null): Fill | undefined {
  const fill = holder?.children.find((c) => ["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"].includes(c.localName));
  if (!fill) return undefined;
  if (fill.localName === "noFill" || fill.localName === "grpFill") return null;
  if (fill.localName === "blipFill") {
    const id = nsAttr(child(fill, "blip"), NS.r, "embed");
    const rel = id ? relById(ctx.view, sourcePart, id) : null;
    return rel?.targetPart && imageMime(ctx.view, rel.targetPart) ? { image: rel.targetPart } : null;
  }
  const colorHolder = fill.localName === "gradFill" ? child(child(fill, "gsLst"), "gs") : fill.localName === "pattFill" ? child(fill, "fgClr") : fill;
  const color = resolveColor(colorHolder, ctx.theme, placeholderColor);
  return color ? { color } : null;
}

function styleRefColor(style: XmlEl | null, refName: string, ctx: SlideContext): string | null {
  const ref = child(style, refName);
  return ref && intAttr(ref, "idx", 0) > 0 ? resolveColor(ref, ctx.theme) : null;
}

interface Inherited { readonly box: Box | null; readonly spPrs: readonly XmlEl[]; readonly lstStyles: XmlEl[]; readonly bodyPrs: XmlEl[] }

function inherited(ctx: SlideContext, scope: Layer, key: PlaceholderKey | null, t: Transform): Inherited {
  const out: Inherited = { box: null, spPrs: [], lstStyles: [], bodyPrs: [] };
  if (!key) return out;
  const chain: XmlEl[] = [];
  if (scope.part === ctx.slide.part) {
    const fromLayout = findPlaceholder(ctx.layout, key, false);
    if (fromLayout) chain.push(fromLayout);
  }
  if (scope.part !== ctx.master?.part) {
    const fromMaster = findPlaceholder(ctx.master, key, true);
    if (fromMaster) chain.push(fromMaster);
  }
  let box: Box | null = null;
  const spPrs: XmlEl[] = [];
  for (const shape of chain) {
    const spPr = child(shape, "spPr");
    if (spPr) spPrs.push(spPr);
    box ??= readBox(child(spPr, "xfrm"), t);
    const body = child(shape, "txBody");
    const lst = child(body, "lstStyle"); if (lst) out.lstStyles.push(lst);
    const bodyPr = child(body, "bodyPr"); if (bodyPr) out.bodyPrs.push(bodyPr);
  }
  return { ...out, box, spPrs };
}

const PRESET_GEOMETRY: Record<string, "rect" | "roundRect" | "ellipse"> = { rect: "rect", roundRect: "roundRect", ellipse: "ellipse", flowChartProcess: "rect", flowChartAlternateProcess: "roundRect" };

interface ShapeInput { readonly el: XmlEl; readonly scope: Layer; readonly t: Transform; readonly inAlternate: boolean; readonly key: string }

function renderSp(ctx: SlideContext, input: ShapeInput, bodyIndexes: ReadonlyMap<XmlEl, number>): RenderShape | null {
  const { el, scope, t } = input;
  const ph = placeholderOf(el);
  const base = inherited(ctx, scope, ph, t);
  const spPr = child(el, "spPr");
  const box = readBox(child(spPr, "xfrm"), t) ?? base.box;
  if (!box) return null;
  const style = child(el, "style");
  let fill = readFill(spPr, ctx, scope.part);
  for (const inheritedSpPr of base.spPrs) fill = fill === undefined ? readFill(inheritedSpPr, ctx, scope.part) : fill;
  const fillColor = fill === undefined ? styleRefColor(style, "fillRef", ctx) : null;
  const ln = child(spPr, "ln");
  const lineFill = ln?.children.find((c) => c.localName === "noFill" || c.localName === "solidFill");
  const lineColor = lineFill ? (lineFill.localName === "solidFill" ? resolveColor(lineFill, ctx.theme) : null) : styleRefColor(style, "lnRef", ctx);
  const prst = attr(child(spPr, "prstGeom"), "prst") ?? (child(spPr, "custGeom") ? "custom" : "rect");
  const body = child(el, "txBody");
  const textCtx: TextStyleContext = {
    theme: ctx.theme,
    levelSources: [...base.lstStyles, textStyleFor(ctx, ph), scope.part === ctx.slide.part ? ctx.defaultTextStyle : null],
    bodyProps: base.bodyPrs,
    styleColor: styleRefColor(style, "fontRef", ctx) ?? themeTextColor(ctx.theme),
  };
  const index = body ? bodyIndexes.get(body) : undefined;
  const editable = body && scope.part === ctx.slide.part && index !== undefined;
  return {
    kind: "shape", key: input.key, box,
    geometry: PRESET_GEOMETRY[prst] ?? "other", geometryName: prst,
    fill: fill === undefined ? (fillColor ? { color: fillColor } : null) : fill,
    line: lineColor ? { color: lineColor, width: Math.max(0, intAttr(ln, "w", 12_700)) } : null,
    text: body ? renderTextBody(scope.doc, body, textCtx) : null,
    body: editable ? { part: scope.part, index } : null,
    editRefusal: editable ? (input.inAlternate ? "This text is inside alternate content, which Mesa does not edit." : textBodyEditRefusal(scope.doc, body)) : null,
    plain: body ? textBodyPlainText(scope.doc, body) : "",
  };
}

function renderPic(ctx: SlideContext, input: ShapeInput, box: Box): RenderShape {
  const blip = path(input.el, "blipFill", "blip");
  const embed = nsAttr(blip, NS.r, "embed");
  const rel = embed ? relById(ctx.view, input.scope.part, embed) : null;
  const target = rel && !rel.external && rel.targetPart && ctx.view.parts.has(rel.targetPart) ? rel.targetPart : null;
  const nvPr = path(input.el, "nvPicPr", "nvPr");
  const media = nvPr ? descendants(nvPr).find((c) => ["videoFile", "audioFile", "quickTimeFile", "media"].includes(c.localName)) : undefined;
  const mediaLabel = media ? (media.localName === "audioFile" ? "Audio" : "Video") : null;
  if (target && imageMime(ctx.view, target)) return { kind: "picture", key: input.key, box, image: target, label: mediaLabel };
  const ext = target ? target.slice(target.lastIndexOf(".") + 1).toUpperCase() : "";
  const label = mediaLabel ?? (nsAttr(blip, NS.r, "link") ? "Linked picture (not loaded)" : target ? `Picture (${ext} is not displayed)` : "Picture (missing)");
  return { kind: "picture", key: input.key, box, image: null, label };
}

function renderFrame(input: ShapeInput, box: Box): RenderShape {
  const data = path(input.el, "graphic", "graphicData");
  const uri = attr(data, "uri") ?? "";
  const tbl = child(data, "tbl");
  if (tbl) {
    const rows = tbl.children.filter((r) => r.localName === "tr").slice(0, 200).map((tr) => tr.children.filter((c) => c.localName === "tc").slice(0, 50)
      .map((tc) => { const body = child(tc, "txBody"); return body ? textBodyPlainText(input.scope.doc, body) : ""; }));
    return { kind: "table", key: input.key, box, rows };
  }
  const label = /\/chart$/.test(uri) ? "Chart" : /chartex/i.test(uri) ? "Chart" : /diagram/.test(uri) ? "SmartArt graphic" : /ole/.test(uri) ? "Embedded object" : "Object";
  return { kind: "placeholder", key: input.key, box, label: `${label} (not displayed)` };
}

function renderLeaf(ctx: SlideContext, input: ShapeInput, bodyIndexes: ReadonlyMap<XmlEl, number>): RenderShape | null {
  const { el, t } = input;
  if (el.localName === "sp") return renderSp(ctx, input, bodyIndexes);
  const xfrm = el.localName === "graphicFrame" ? child(el, "xfrm") : child(child(el, "spPr"), "xfrm");
  const box = readBox(xfrm, t) ?? (el.localName === "pic" ? inherited(ctx, input.scope, placeholderOf(el), t).box : null);
  if (!box) return null;
  if (el.localName === "pic") return renderPic(ctx, input, box);
  if (el.localName === "graphicFrame") return renderFrame(input, box);
  if (el.localName === "cxnSp") {
    const ln = child(child(el, "spPr"), "ln");
    const color = resolveColor(child(ln, "solidFill"), ctx.theme) ?? styleRefColor(child(el, "style"), "lnRef", ctx) ?? "#808080";
    return { kind: "line", key: input.key, box, color, width: Math.max(6_350, intAttr(ln, "w", 12_700)) };
  }
  return { kind: "placeholder", key: input.key, box, label: el.localName === "contentPart" ? "Ink (not displayed)" : `${el.localName} (not displayed)` };
}

interface Frame { readonly items: readonly XmlEl[]; index: number; readonly t: Transform; readonly inAlternate: boolean }

function alternateBranch(el: XmlEl): XmlEl[] {
  const fallback = child(el, "Fallback");
  return fallback ? fallback.children : [];
}

/** Walks one shape tree in z-order with an explicit stack. */
function walkTree(ctx: SlideContext, scope: Layer, skipPlaceholders: boolean, out: RenderShape[], budget: { left: number; omitted: number }): void {
  const tree = path(scope.doc.root, "cSld", "spTree");
  if (!tree) return;
  const bodyIndexes = textBodyIndex(scope.doc);
  const stack: Frame[] = [{ items: tree.children, index: 0, t: IDENTITY, inAlternate: false }];
  for (let guard = 0; stack.length && guard < 1_000_000; guard++) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.items.length) { stack.pop(); continue; }
    const el = frame.items[frame.index++];
    if (el.localName === "grpSp") { stack.push({ items: el.children, index: 0, t: groupTransform(child(el, "grpSpPr"), frame.t), inAlternate: frame.inAlternate }); continue; }
    if (el.localName === "AlternateContent") { stack.push({ items: alternateBranch(el), index: 0, t: frame.t, inAlternate: true }); continue; }
    if (!["sp", "pic", "graphicFrame", "cxnSp", "contentPart"].includes(el.localName)) continue;
    if (skipPlaceholders && placeholderOf(el)) continue;
    if (budget.left <= 0) { budget.omitted++; continue; }
    const shape = renderLeaf(ctx, { el, scope, t: frame.t, inAlternate: frame.inAlternate, key: `${scope.part}@${el.start}` }, bodyIndexes);
    if (shape) { out.push(shape); budget.left--; }
  }
}

function backgroundOf(ctx: SlideContext, scope: Layer | null): Fill | undefined {
  const bg = path(scope?.doc.root, "cSld", "bg");
  if (!bg || !scope) return undefined;
  const bgPr = child(bg, "bgPr");
  if (bgPr) return readFill(bgPr, ctx, scope.part) ?? null;
  const color = resolveColor(child(bg, "bgRef"), ctx.theme);
  return color ? { color } : undefined;
}

function showsMasterShapes(scope: Layer | null): boolean {
  return scope?.doc.root.attrs.get("showMasterSp") !== "0";
}

/** Builds the render model for one slide of the deck. */
export function renderSlide(view: PartView, deck: Deck, slide: DeckSlide): RenderSlide {
  const slideLayer = layer(view, slide.part);
  if (!slideLayer) return { width: deck.width, height: deck.height, background: null, shapes: [], omitted: 0 };
  const master = layer(view, slide.masterPart);
  const theme = readTheme(slide.themePart ? xmlOf(view, slide.themePart)?.root ?? null : null, master?.doc.root ?? null);
  const ctx: SlideContext = {
    view, theme, slide: slideLayer, layout: layer(view, slide.layoutPart), master,
    defaultTextStyle: child(xmlOf(view, deck.presentationPart)?.root, "defaultTextStyle"),
  };
  const shapes: RenderShape[] = [];
  const budget = { left: MAX_SHAPES_PER_SLIDE, omitted: 0 };
  if (showsMasterShapes(slideLayer)) {
    if (ctx.master && showsMasterShapes(ctx.layout)) walkTree(ctx, ctx.master, true, shapes, budget);
    if (ctx.layout) walkTree(ctx, ctx.layout, true, shapes, budget);
  }
  walkTree(ctx, slideLayer, false, shapes, budget);
  let background = backgroundOf(ctx, slideLayer);
  if (background === undefined) background = backgroundOf(ctx, ctx.layout);
  if (background === undefined) background = backgroundOf(ctx, ctx.master);
  return { width: deck.width, height: deck.height, background: background ?? { color: "#ffffff" }, shapes, omitted: budget.omitted };
}

export interface RenderNotes {
  readonly text: string;
  readonly body: TextBodyRef | null;
  readonly editRefusal: string | null;
}

/** Speaker notes: the notes slide's body placeholder. */
export function renderNotes(view: PartView, slide: DeckSlide): RenderNotes {
  const doc = slide.notesPart ? xmlOf(view, slide.notesPart) : null;
  if (!doc || !slide.notesPart) return { text: "", body: null, editRefusal: "This slide has no notes part. Mesa does not add one." };
  const tree = path(doc.root, "cSld", "spTree");
  const indexes = textBodyIndex(doc);
  const shape = tree ? descendants(tree).find((el) => el.localName === "sp" && placeholderOf(el)?.type === "body") : undefined;
  const body = child(shape, "txBody");
  const index = body ? indexes.get(body) : undefined;
  if (!body || index === undefined) return { text: "", body: null, editRefusal: "The notes page has no notes text box. Mesa does not add one." };
  return { text: textBodyPlainText(doc, body), body: { part: slide.notesPart, index }, editRefusal: textBodyEditRefusal(doc, body) };
}
