import { applySplices, descendants, type XmlDoc, type XmlEl } from "../pptx/xmlTree";
import { isOdf, lengthToEmu, odfAttr, odfCount } from "./odfNames";
import type { OdfPackage } from "./odfPackage";
import { readOdfStyles, type OdfStyles, type TextLook } from "./odfStyles";
import {
  OdfEditRefusal, MAX_PARAGRAPH_CHARS, StyleMaker, paragraphSplice, rangeHas, readParagraph, replaceItemsText, restyleRange,
  type FormatProp, type OdfParagraph,
} from "./odfText";

// OpenDocument text (.odt) as a flat block list for reading, and paragraph
// edits as splices of content.xml. Paragraphs are numbered in document order
// across the whole body; edits never add or remove paragraphs, so numbers
// stay stable across edits.

export interface OdtRun extends TextLook { readonly text: string }

export interface OdtParagraphBlock {
  readonly kind: "paragraph";
  /** Index into `OdtDocument.paragraphs`. */
  readonly index: number;
  /** Outline level for headings (1-10), 0 for body text. */
  readonly heading: number;
  /** Nesting depth inside lists (0 outside lists). */
  readonly listLevel: number;
  readonly runs: readonly OdtRun[];
}

export interface OdtTableBlock {
  readonly kind: "table";
  readonly key: number;
  /** Rows of cells; each cell lists paragraph indices. */
  readonly rows: readonly (readonly (readonly number[])[])[];
}

export interface OdtImageBlock { readonly kind: "image"; readonly key: number; readonly part: string | null; readonly width: number | null; readonly height: number | null; readonly label: string }

export type OdtBlock = OdtParagraphBlock | OdtTableBlock | OdtImageBlock;

export interface OdtDocument {
  readonly doc: XmlDoc;
  readonly styles: OdfStyles;
  readonly paragraphs: readonly OdfParagraph[];
  readonly paragraphStyle: readonly (string | null)[];
  /** Display runs of every paragraph, by paragraph index (table cells included). */
  readonly runs: readonly (readonly OdtRun[])[];
  readonly blocks: readonly OdtBlock[];
}

export const MAX_TABLE_CELLS = 20_000;

function officeText(doc: XmlDoc): XmlEl {
  const body = doc.root.children.find((c) => isOdf(c, "office", "body"));
  const text = body?.children.find((c) => isOdf(c, "office", "text"));
  if (!text) throw new OdfEditRefusal("This file has no OpenDocument text body.");
  return text;
}

const isParagraph = (el: XmlEl) => isOdf(el, "text", "p") || isOdf(el, "text", "h");

function tracksRegion(el: XmlEl): boolean {
  return isOdf(el, "text", "tracked-changes");
}

/** Paragraph indices whose position lies inside a tracked-change region (change-start ... change-end). */
function changedParagraphs(body: XmlEl, paragraphs: readonly XmlEl[]): Set<number> {
  const out = new Set<number>();
  const open = new Set<string>();
  const index = new Map(paragraphs.map((p, i) => [p, i]));
  let current = -1;
  for (const el of descendants(body, tracksRegion)) {
    const at = index.get(el);
    if (at !== undefined) { current = at; if (open.size) out.add(at); continue; }
    if (!isOdf(el, "text", "change-start") && !isOdf(el, "text", "change-end")) continue;
    const id = odfAttr(el, "text", "change-id") ?? "";
    if (el.localName === "change-start") open.add(id); else open.delete(id);
    if (current >= 0) out.add(current);
  }
  return out;
}

function runsOf(styles: OdfStyles, paragraphStyle: string | null, p: OdfParagraph): OdtRun[] {
  const base = styles.look("paragraph", paragraphStyle);
  const runs: OdtRun[] = [];
  for (const item of p.items) if (item.kind === "text") runs.push({ ...base, ...styles.look("text", item.style), text: item.text });
  return runs;
}

function imageOf(el: XmlEl, key: number): OdtImageBlock {
  const image = descendants(el).find((c) => isOdf(c, "draw", "image"));
  const href = odfAttr(image, "xlink", "href");
  const part = href && !/^[a-z][\w+.-]*:/i.test(href) ? href.replace(/^\.\//, "") : null;
  const width = lengthToEmu(odfAttr(el, "svg", "width"));
  const height = lengthToEmu(odfAttr(el, "svg", "height"));
  const label = image ? (part ? "Image" : "Linked image (not loaded)") : descendants(el).some((c) => isOdf(c, "draw", "object") || isOdf(c, "draw", "object-ole")) ? "Embedded object" : "Drawing";
  return { kind: "image", key, part, width, height, label };
}

function tableOf(el: XmlEl, key: number, paragraphIndex: ReadonlyMap<XmlEl, number>): OdtTableBlock {
  const rows: number[][][] = [];
  let cells = 0;
  for (const row of descendants(el, (c) => isOdf(c, "table", "table") && c !== el)) {
    if (!isOdf(row, "table", "table-row") || cells > MAX_TABLE_CELLS) continue;
    const out: number[][] = [];
    for (const cell of row.children) {
      if (!isOdf(cell, "table", "table-cell")) continue;
      const paragraphs = descendants(cell).filter(isParagraph).map((p) => paragraphIndex.get(p)).filter((i): i is number => i !== undefined);
      const repeat = Math.min(odfCount(cell, "table", "number-columns-repeated", 64), paragraphs.length ? 1 : 64);
      for (let r = 0; r < repeat && cells <= MAX_TABLE_CELLS; r++, cells++) out.push(paragraphs);
    }
    rows.push(out);
  }
  return { kind: "table", key, rows };
}

interface Pending { el: XmlEl; listLevel: number }

/** Blocks in reading order. Tables are flattened one level; frames become image blocks after their paragraph. */
function buildBlocks(body: XmlEl, paragraphIndex: ReadonlyMap<XmlEl, number>, runs: readonly (readonly OdtRun[])[]): OdtBlock[] {
  const blocks: OdtBlock[] = [];
  const todo: Pending[] = [...body.children].reverse().map((el) => ({ el, listLevel: 0 }));
  for (let guard = 0; todo.length && guard < 2_000_000; guard++) {
    const { el, listLevel } = todo.pop()!;
    if (isParagraph(el)) {
      const index = paragraphIndex.get(el)!;
      const heading = isOdf(el, "text", "h") ? Math.max(1, Math.min(10, Number(odfAttr(el, "text", "outline-level") ?? 1) || 1)) : 0;
      blocks.push({ kind: "paragraph", index, heading, listLevel, runs: runs[index] });
      for (const frame of el.children.concat(el.children.flatMap((c) => c.children))) if (isOdf(frame, "draw", "frame")) blocks.push(imageOf(frame, frame.start));
      continue;
    }
    if (isOdf(el, "table", "table")) { blocks.push(tableOf(el, el.start, paragraphIndex)); continue; }
    if (isOdf(el, "draw", "frame")) { blocks.push(imageOf(el, el.start)); continue; }
    if (isOdf(el, "text", "tracked-changes")) continue;
    const nested = isOdf(el, "text", "list") ? listLevel + 1 : listLevel;
    for (let i = el.children.length - 1; i >= 0; i--) todo.push({ el: el.children[i], listLevel: nested });
  }
  return blocks;
}

/** What a later read of the same document can take over from this one. */
interface OdtCarry {
  readonly doc: XmlDoc;
  readonly stylesDoc: XmlDoc | null;
  /** Root start tag and automatic styles: what a paragraph's reading and look depend on outside itself. */
  readonly rootTag: string;
  readonly automaticStyles: string;
  readonly elements: readonly XmlEl[];
  /** Paragraphs as read, before the tracked-change refusal is added. */
  readonly reads: readonly OdfParagraph[];
}

const carries = new WeakMap<OdtDocument, OdtCarry>();

function automaticStylesText(doc: XmlDoc): string {
  const el = doc.root.children.find((c) => isOdf(c, "office", "automatic-styles"));
  return el ? doc.text.slice(el.start, el.end) : "";
}

/**
 * Reads an .odt content part into paragraphs and blocks.
 *
 * `previous` is the model of an earlier text of the same opened package. A
 * paragraph whose XML is the same as the paragraph at the same position there
 * is taken over instead of read again, and keeps the same `runs` array when
 * the styles are the same too. An edit changes one paragraph, so a key press
 * in a long document reads one paragraph, not all of them.
 */
export function readOdtDocument(doc: XmlDoc, stylesDoc: XmlDoc | null, trackedChanges: boolean, previous: OdtDocument | null = null): OdtDocument {
  const body = officeText(doc);
  const styles = readOdfStyles(doc, stylesDoc);
  const elements = descendants(body, tracksRegion).filter(isParagraph);
  const rootTag = doc.text.slice(doc.root.start, doc.root.innerStart);
  const automaticStyles = automaticStylesText(doc);
  const carry = previous ? carries.get(previous) : undefined;
  const from = carry && carry.elements.length === elements.length && carry.doc.utf8 === doc.utf8 && carry.rootTag === rootTag ? carry : null;
  const sameStyles = !!from && from.stylesDoc === stylesDoc && from.automaticStyles === automaticStyles;
  const reads: OdfParagraph[] = [];
  const paragraphStyle: (string | null)[] = [];
  const runs: (readonly OdtRun[])[] = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const old = from?.elements[i];
    const same = !!from && !!old && old.end - old.start === el.end - el.start && doc.text.startsWith(from.doc.text.slice(old.start, old.end), el.start);
    reads.push(same ? { ...from.reads[i], el } : readParagraph(doc, el));
    paragraphStyle.push(odfAttr(el, "text", "style-name"));
    runs.push(same && sameStyles ? previous!.runs[i] : runsOf(styles, paragraphStyle[i], reads[i]));
  }
  const changed = trackedChanges ? changedParagraphs(body, elements) : new Set<number>();
  const paragraphs = changed.size
    ? reads.map((p, i) => (changed.has(i) && !p.refusal ? { ...p, refusal: "This paragraph is part of a tracked change, which Mesa does not edit." } : p))
    : reads;
  const paragraphIndex = new Map(elements.map((el, i) => [el, i]));
  const odt: OdtDocument = { doc, styles, paragraphs, paragraphStyle, runs, blocks: buildBlocks(body, paragraphIndex, runs) };
  carries.set(odt, { doc, stylesDoc, rootTag, automaticStyles, elements, reads });
  return odt;
}

export function openOdtDocument(pkg: OdfPackage): OdtDocument {
  return readOdtDocument(pkg.content, pkg.styles, pkg.policy.trackedChanges);
}

export type OdtEdit =
  | { readonly kind: "text"; readonly paragraph: number; readonly text: string }
  | { readonly kind: "format"; readonly paragraph: number; readonly start: number; readonly end: number; readonly prop: FormatProp };

function editable(odt: OdtDocument, index: number): OdfParagraph {
  const p = odt.paragraphs[index];
  if (!p) throw new OdfEditRefusal("That paragraph is no longer in the document.");
  if (p.refusal) throw new OdfEditRefusal(p.refusal);
  return p;
}

/** Applies one edit to the content text; returns the new text (unchanged when the edit is a no-op). */
export function applyOdtEdit(odt: OdtDocument, edit: OdtEdit): string {
  const p = editable(odt, edit.paragraph);
  if (edit.kind === "text") {
    if (edit.text.length > MAX_PARAGRAPH_CHARS) throw new OdfEditRefusal("That text is too long for one paragraph.");
    const items = replaceItemsText(p.items, edit.text);
    if (items.length === p.items.length && items.every((item, i) => item === p.items[i])) return odt.doc.text;
    return applySplices(odt.doc.text, [paragraphSplice(odt.doc, p.el, items)]);
  }
  const start = Math.max(0, Math.min(edit.start, p.plain.length));
  const end = Math.max(start, Math.min(edit.end, p.plain.length));
  if (end === start) throw new OdfEditRefusal("Select some text in the paragraph first.");
  const maker = new StyleMaker(odt.doc, odt.styles);
  const paragraphStyle = odt.paragraphStyle[edit.paragraph];
  const on = !rangeHas(p.items, start, end, (style) => !!maker.look(paragraphStyle, style)[edit.prop]);
  const items = restyleRange(p.items, start, end, (style) => maker.derive(style, edit.prop, on));
  const splices = [paragraphSplice(odt.doc, p.el, items)];
  const styleSplice = maker.splice();
  if (styleSplice) splices.push(styleSplice);
  return applySplices(odt.doc.text, splices);
}
