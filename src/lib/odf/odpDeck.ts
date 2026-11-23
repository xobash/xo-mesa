import type { Box, RenderShape, RenderSlide, TextBodyRef } from "../pptx/pptxRender";
import type { RenderParagraph, RenderRun, RenderText } from "../pptx/pptxText";
import { applySplices, descendants, type XmlDoc, type XmlEl, type XmlSplice } from "../pptx/xmlTree";
import { isOdf, lengthToEmu, odfAttr, prefixOfEl, ODF_NS } from "./odfNames";
import { CONTENT_PART, type OdfPackage } from "./odfPackage";
import { readOdfStyles, type OdfStyles } from "./odfStyles";
import { OdfEditRefusal, MAX_PARAGRAPH_CHARS, readParagraph, replaceItemsText, serializeItems, type OdfParagraph } from "./odfText";

// OpenDocument presentations (.odp): slides as the same positioned render
// model the PowerPoint view draws (EMU coordinates), text edits of existing
// text boxes and notes, and slide reordering. Edits splice content.xml.

export interface OdpSlide { readonly el: XmlEl; readonly name: string; readonly hidden: boolean }

export interface OdpNotes { readonly text: string; readonly body: TextBodyRef | null; readonly editRefusal: string | null }

export interface OdpDeck {
  readonly doc: XmlDoc;
  readonly styles: OdfStyles;
  readonly slides: readonly OdpSlide[];
  readonly width: number;
  readonly height: number;
  /** Text containers (text boxes and shapes holding text) in document order. */
  readonly containers: readonly XmlEl[];
}

const DEFAULT_WIDTH = 28 * 360000;
const DEFAULT_HEIGHT = 15.75 * 360000;
const MAX_SHAPES = 4000;
const SHAPES = new Set(["custom-shape", "rect", "ellipse", "circle", "polygon", "polyline", "path", "connector", "measure", "regular-polygon"]);

const isParagraph = (el: XmlEl) => isOdf(el, "text", "p") || isOdf(el, "text", "h");
const isContainer = (el: XmlEl) => isOdf(el, "draw", "text-box") || (el.ns === ODF_NS.draw && SHAPES.has(el.localName));

function presentationBody(doc: XmlDoc): XmlEl {
  const body = doc.root.children.find((c) => isOdf(c, "office", "body"));
  const presentation = body?.children.find((c) => isOdf(c, "office", "presentation"));
  if (!presentation) throw new OdfEditRefusal("This file has no OpenDocument presentation body.");
  return presentation;
}

function slideSize(stylesDoc: XmlDoc | null, firstPage: XmlEl | undefined): { width: number; height: number } {
  const master = odfAttr(firstPage, "draw", "master-page-name");
  const all = stylesDoc ? descendants(stylesDoc.root) : [];
  const masterEl = all.find((el) => isOdf(el, "style", "master-page") && (!master || odfAttr(el, "style", "name") === master));
  const layoutName = odfAttr(masterEl, "style", "page-layout-name");
  const layout = all.find((el) => isOdf(el, "style", "page-layout") && odfAttr(el, "style", "name") === layoutName);
  const props = layout?.children.find((c) => isOdf(c, "style", "page-layout-properties"));
  return {
    width: lengthToEmu(odfAttr(props, "fo", "page-width")) ?? DEFAULT_WIDTH,
    height: lengthToEmu(odfAttr(props, "fo", "page-height")) ?? DEFAULT_HEIGHT,
  };
}

function pageHidden(styles: OdfStyles, page: XmlEl): boolean {
  const entry = styles.byKey.get(`drawing-page:${odfAttr(page, "draw", "style-name") ?? ""}`);
  const props = entry?.el.children.find((c) => isOdf(c, "style", "drawing-page-properties"));
  return odfAttr(props, "presentation", "visibility") === "hidden";
}

export function readOdpDeck(doc: XmlDoc, stylesDoc: XmlDoc | null): OdpDeck {
  const body = presentationBody(doc);
  const styles = readOdfStyles(doc, stylesDoc);
  const pages = body.children.filter((c) => isOdf(c, "draw", "page"));
  const slides = pages.map((el, i) => ({ el, name: odfAttr(el, "draw", "name") ?? `Slide ${i + 1}`, hidden: pageHidden(styles, el) }));
  const containers = descendants(body).filter(isContainer);
  return { doc, styles, slides, containers, ...slideSize(stylesDoc, pages[0]) };
}

export function openOdpDeck(pkg: OdfPackage): OdpDeck {
  return readOdpDeck(pkg.content, pkg.styles);
}

// ---------- rendering ----------

function paragraphsOf(container: XmlEl): XmlEl[] {
  return descendants(container, (el) => isOdf(el, "draw", "frame") || (el !== container && isContainer(el))).filter(isParagraph);
}

function listDepth(p: XmlEl, container: XmlEl): number {
  let depth = 0;
  for (let at = p.parent; at && at !== container && depth < 10; at = at.parent) if (isOdf(at, "text", "list")) depth++;
  return depth;
}

function renderText(deck: OdpDeck, container: XmlEl, defaultSize: number, center: boolean, anchor: RenderText["anchor"]): RenderText {
  const paragraphs: RenderParagraph[] = paragraphsOf(container).map((p) => {
    const read = readParagraph(deck.doc, p);
    const base = deck.styles.look("paragraph", odfAttr(p, "text", "style-name"));
    const runs: RenderRun[] = [];
    for (const item of read.items) {
      if (item.kind !== "text") continue;
      const look = { ...base, ...deck.styles.look("text", item.style) };
      const run = { size: look.size ?? defaultSize, bold: !!look.bold, italic: !!look.italic, underline: !!look.underline, strike: !!look.strike, color: look.color ?? null, font: null };
      item.text.split("\n").forEach((part, i) => { if (i) runs.push({ ...run, text: "\n" }); if (part) runs.push({ ...run, text: part }); });
    }
    const level = listDepth(p, container);
    return {
      align: center ? "center" : "left", level, marginLeft: level ? level * 342900 : 0, indent: 0,
      bullet: level ? { text: "•", color: null } : null, runs, emptySize: runs[0]?.size ?? defaultSize,
    };
  });
  return { anchor, insets: [91440, 45720, 91440, 45720], wrap: true, paragraphs };
}

function boxOf(el: XmlEl): Box | null {
  const x = lengthToEmu(odfAttr(el, "svg", "x"));
  const y = lengthToEmu(odfAttr(el, "svg", "y"));
  const w = lengthToEmu(odfAttr(el, "svg", "width"));
  const h = lengthToEmu(odfAttr(el, "svg", "height"));
  if (x === null || y === null || w === null || h === null) return null;
  return { x, y, w: Math.max(0, w), h: Math.max(0, h), rot: 0, flipH: false, flipV: false };
}

function lineBox(el: XmlEl): { box: Box } | null {
  const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((k) => lengthToEmu(odfAttr(el, "svg", k)));
  if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
  return { box: { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), rot: 0, flipH: x2 < x1, flipV: y2 < y1 } };
}

function sizeFor(cls: string | null): number {
  if (cls === "title") return 4400;
  if (cls === "subtitle") return 3200;
  return 1800;
}

function bodyRef(deck: OdpDeck, container: XmlEl): TextBodyRef | null {
  const index = deck.containers.indexOf(container);
  return index < 0 ? null : { part: CONTENT_PART, index };
}

function textShape(deck: OdpDeck, key: string, box: Box, container: XmlEl, cls: string | null, fill: string | null, geometry: "rect" | "ellipse" | "other", name: string): RenderShape {
  const body = bodyRef(deck, container);
  const anchor = isOdf(container, "draw", "text-box") ? "top" : "middle";
  const text = paragraphsOf(container).length ? renderText(deck, container, sizeFor(cls), cls === "title" || cls === "subtitle", anchor) : null;
  const plain = paragraphsOf(container).map((p) => readParagraph(deck.doc, p).plain).join("\n");
  return {
    kind: "shape", key, box, geometry, geometryName: name, fill: fill ? { color: fill } : null, line: null,
    text, body, editRefusal: body ? containerRefusal(deck, container) : "Mesa cannot edit this text.", plain,
  };
}

function frameShape(deck: OdpDeck, el: XmlEl, box: Box, key: string): RenderShape {
  const cls = odfAttr(el, "presentation", "class");
  const textBox = el.children.find((c) => isOdf(c, "draw", "text-box"));
  if (textBox) return textShape(deck, key, box, textBox, cls, deck.styles.fill(odfAttr(el, "draw", "style-name") ?? odfAttr(el, "presentation", "style-name")), "rect", "text-box");
  const image = el.children.find((c) => isOdf(c, "draw", "image"));
  if (image) {
    const href = odfAttr(image, "xlink", "href");
    const part = href && !/^[a-z][\w+.-]*:/i.test(href) ? href.replace(/^\.\//, "") : null;
    return { kind: "picture", key, box, image: part, label: part ? null : "Linked picture (not loaded)" };
  }
  const table = el.children.find((c) => isOdf(c, "table", "table"));
  if (table) {
    const rows = descendants(table).filter((r) => isOdf(r, "table", "table-row")).slice(0, 200)
      .map((r) => r.children.filter((c) => isOdf(c, "table", "table-cell")).slice(0, 50).map((c) => paragraphsOf(c).map((p) => readParagraph(deck.doc, p).plain).join("\n")));
    return { kind: "table", key, box, rows };
  }
  const object = el.children.some((c) => isOdf(c, "draw", "object") || isOdf(c, "draw", "object-ole"));
  return { kind: "placeholder", key, box, label: object ? "Chart or embedded object" : cls ? `Empty ${cls} placeholder` : "Frame" };
}

function shapeOf(deck: OdpDeck, el: XmlEl): RenderShape | null {
  const key = String(el.start);
  if (isOdf(el, "draw", "line")) {
    const line = lineBox(el);
    return line ? { kind: "line", key, box: line.box, color: "#3465a4", width: 12700 } : null;
  }
  const box = boxOf(el);
  if (!box) return null;
  if (isOdf(el, "draw", "frame")) return frameShape(deck, el, box, key);
  if (el.ns === ODF_NS.draw && SHAPES.has(el.localName)) {
    const geometry = el.localName === "rect" ? "rect" : el.localName === "ellipse" || el.localName === "circle" ? "ellipse" : "other";
    return textShape(deck, key, box, el, odfAttr(el, "presentation", "class"), deck.styles.fill(odfAttr(el, "draw", "style-name")), geometry, el.localName);
  }
  return null;
}

/** One slide as a positioned render model. Groups are flattened (ODF group children use page coordinates). */
export function renderOdpSlide(deck: OdpDeck, slide: OdpSlide): RenderSlide {
  const shapes: RenderShape[] = [];
  let omitted = 0;
  const todo = [...slide.el.children].reverse();
  for (let guard = 0; todo.length && guard < 200_000; guard++) {
    const el = todo.pop()!;
    if (isOdf(el, "presentation", "notes")) continue;
    if (isOdf(el, "draw", "g")) { for (let i = el.children.length - 1; i >= 0; i--) todo.push(el.children[i]); continue; }
    const shape = shapeOf(deck, el);
    if (!shape) continue;
    if (shapes.length >= MAX_SHAPES) omitted++;
    else shapes.push(shape);
  }
  const bg = deck.styles.byKey.get(`drawing-page:${odfAttr(slide.el, "draw", "style-name") ?? ""}`);
  const bgProps = bg?.el.children.find((c) => isOdf(c, "style", "drawing-page-properties"));
  const bgColor = odfAttr(bgProps, "draw", "fill") === "solid" ? odfAttr(bgProps, "draw", "fill-color") : null;
  return { width: deck.width, height: deck.height, background: bgColor && /^#[0-9a-f]{6}$/i.test(bgColor) ? { color: bgColor } : null, shapes, omitted };
}

export function odpNotes(deck: OdpDeck, slide: OdpSlide): OdpNotes {
  const notes = slide.el.children.find((c) => isOdf(c, "presentation", "notes"));
  const frame = notes ? descendants(notes).find((el) => isOdf(el, "draw", "frame") && odfAttr(el, "presentation", "class") === "notes") : undefined;
  const box = frame?.children.find((c) => isOdf(c, "draw", "text-box"));
  if (!box) return { text: "", body: null, editRefusal: "This slide has no notes area. Add one in LibreOffice Impress to write notes." };
  return { text: paragraphsOf(box).map((p) => readParagraph(deck.doc, p).plain).join("\n"), body: bodyRef(deck, box), editRefusal: containerRefusal(deck, box) };
}

// ---------- editing ----------

/** Why Mesa will not edit a text container, or `null`. */
export function containerRefusal(deck: OdpDeck, container: XmlEl): string | null {
  const paragraphs = paragraphsOf(container);
  if (!paragraphs.length && !isOdf(container, "draw", "text-box")) return "This shape has no text.";
  for (const p of paragraphs) {
    const read = readParagraph(deck.doc, p);
    if (read.refusal) return read.refusal;
    if (read.plain.includes("\n")) return "This text has a manual line break, which Mesa does not edit yet.";
  }
  return null;
}

/** The highest ancestor of `p` below `container` that holds no other paragraph. */
function unitOf(p: XmlEl, container: XmlEl): XmlEl {
  let unit = p;
  for (let at = p.parent; at && at !== container; at = at.parent) {
    if (descendants(at).filter(isParagraph).length !== 1) break;
    unit = at;
  }
  return unit;
}

function paragraphWithInner(doc: XmlDoc, p: XmlEl, inner: string): string {
  if (p.innerStart === p.end && doc.text[p.end - 2] === "/") return `${doc.text.slice(p.start, p.end - 2).replace(/\s+$/, "")}>${inner}</${p.name}>`;
  return doc.text.slice(p.start, p.innerStart) + inner + doc.text.slice(p.innerEnd, p.end);
}

function cloneUnit(doc: XmlDoc, unit: XmlEl, p: XmlEl, read: OdfParagraph, line: string): string {
  const style = read.items.find((i) => i.kind === "text")?.style ?? null;
  const inner = serializeItems(line ? [{ kind: "text", text: line, style }] : [], prefixOfEl(p));
  const text = doc.text.slice(unit.start, p.start) + paragraphWithInner(doc, p, inner) + doc.text.slice(p.end, unit.end);
  return text.replace(/\s(?:xml|text):id="[^"]*"/g, "");
}

/** New content text with a text container's paragraphs set to `text` (one paragraph per line). */
export function editContainerText(deck: OdpDeck, index: number, text: string): string {
  const container = deck.containers[index];
  if (!container) throw new OdfEditRefusal("That text box is no longer in the presentation.");
  const refusal = containerRefusal(deck, container);
  if (refusal) throw new OdfEditRefusal(refusal);
  if (text.length > MAX_PARAGRAPH_CHARS) throw new OdfEditRefusal("That text is too long for one text box.");
  const doc = deck.doc;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const paragraphs = paragraphsOf(container);
  const splices: XmlSplice[] = [];
  if (!paragraphs.length) {
    const prefix = [...container.nsMap].find(([key, uri]) => key && uri === ODF_NS.text)?.[0];
    if (!prefix) throw new OdfEditRefusal("This presentation does not declare the text namespace.");
    const inner = lines.map((line) => `<${prefix}:p>${serializeItems(line ? [{ kind: "text", text: line, style: null }] : [], prefix)}</${prefix}:p>`).join("");
    const empty = container.innerStart === container.end;
    splices.push(empty
      ? { start: container.start, end: container.end, text: `${doc.text.slice(container.start, container.end - 2).replace(/\s+$/, "")}>${inner}</${container.name}>` }
      : { start: container.innerEnd, end: container.innerEnd, text: inner });
    return applySplices(doc.text, splices);
  }
  const reads = paragraphs.map((p) => readParagraph(doc, p));
  for (let i = 0; i < Math.min(lines.length, paragraphs.length); i++) {
    if (reads[i].plain === lines[i]) continue;
    const items = replaceItemsText(reads[i].items, lines[i]);
    const inner = serializeItems(items, prefixOfEl(paragraphs[i]));
    splices.push({ start: paragraphs[i].start, end: paragraphs[i].end, text: paragraphWithInner(doc, paragraphs[i], inner) });
  }
  const lastIndex = paragraphs.length - 1;
  if (lines.length > paragraphs.length) {
    const unit = unitOf(paragraphs[lastIndex], container);
    const added = lines.slice(paragraphs.length).map((line) => cloneUnit(doc, unit, paragraphs[lastIndex], reads[lastIndex], line)).join("");
    splices.push({ start: unit.end, end: unit.end, text: added });
  }
  for (let i = lines.length; i < paragraphs.length; i++) {
    const unit = unitOf(paragraphs[i], container);
    splices.push({ start: unit.start, end: unit.end, text: "" });
  }
  return applySplices(doc.text, mergeContained(splices));
}

/** Drops splices nested inside a removal (a removed unit swallows its paragraph's edit). */
function mergeContained(splices: XmlSplice[]): XmlSplice[] {
  return splices.filter((s) => !splices.some((o) => o !== s && o.text === "" && o.start <= s.start && s.end <= o.end && (o.start !== s.start || o.end !== s.end)));
}

/** New content text with slide `from` moved to position `to`. */
export function moveOdpSlide(deck: OdpDeck, from: number, to: number): string {
  const pages = deck.slides.map((s) => s.el);
  if (from === to || !pages[from] || !pages[to]) return deck.doc.text;
  const body = pages[0].parent!;
  const first = body.children.indexOf(pages[0]);
  const last = body.children.indexOf(pages[pages.length - 1]);
  if (last - first + 1 !== pages.length) throw new OdfEditRefusal("Other content sits between the slides, so Mesa does not reorder them.");
  const text = deck.doc.text;
  const sources = pages.map((p) => text.slice(p.start, p.end));
  const gaps = pages.slice(1).map((p, i) => text.slice(pages[i].end, p.start));
  const [moved] = sources.splice(from, 1);
  sources.splice(to, 0, moved);
  const joined = sources.map((s, i) => (i ? gaps[i - 1] + s : s)).join("");
  return applySplices(text, [{ start: pages[0].start, end: pages[pages.length - 1].end, text: joined }]);
}
