import { defaultFormat, type RtfDocument, type RtfFormat } from "../lib/rtfDocument";
import type { RtfEditUnit } from "../lib/rtfEdit";

/**
 * DOM side of the RTF editor. Each paragraph is a `<p>`; each format run a
 * `<span>` carrying its full format in `data-rtf-fmt`; embedded objects are
 * non-editable `<span data-rtf-atom>`. Reading the DOM back never trusts
 * computed styles: format comes from the nearest `data-rtf-fmt` ancestor,
 * so new text typed into a run takes that run's format.
 */

const FMT = "data-rtf-fmt";
const ATOM = "data-rtf-atom";
const PARA = "data-rtf-para";
const LINE = "data-rtf-line";

export interface RtfParagraph {
  /** Index into `RtfDocument.paragraphs`. */
  style: number;
  /** Format for text typed into the paragraph when it has no run. */
  fmt: RtfFormat;
  items: Exclude<RtfEditUnit, { kind: "par" }>[];
}

export function encodeFormat(f: RtfFormat): string {
  return [f.b ? 1 : 0, f.i ? 1 : 0, f.ul ? 1 : 0, f.strike ? 1 : 0, f.fs, f.f, f.cf, f.cb, f.hl, f.va].join(",");
}

export function decodeFormat(value: string | null): RtfFormat | null {
  if (!value) return null;
  const p = value.split(",");
  if (p.length !== 10) return null;
  const n = (k: number) => Number.parseInt(p[k], 10) || 0;
  const va = p[9] === "super" || p[9] === "sub" ? p[9] : "";
  return { b: p[0] === "1", i: p[1] === "1", ul: p[2] === "1", strike: p[3] === "1", fs: n(4) || 24, f: n(5), cf: n(6), cb: n(7), hl: n(8), va };
}

function cssFont(name: string): string {
  return `"${name.replace(/["\\]/g, "")}", var(--font)`;
}

/** Inline presentation for one format; colour index 0 follows the theme. */
export function styleFormat(el: HTMLElement, f: RtfFormat, doc: RtfDocument): void {
  el.setAttribute(FMT, encodeFormat(f));
  const s = el.style;
  s.fontWeight = f.b ? "700" : "";
  s.fontStyle = f.i ? "italic" : "";
  s.textDecoration = [f.ul ? "underline" : "", f.strike ? "line-through" : ""].filter(Boolean).join(" ");
  s.fontSize = `${f.fs / 2}pt`;
  const font = doc.fonts.get(f.f);
  s.fontFamily = font?.name ? cssFont(font.name) : "";
  s.color = (f.cf && doc.colors[f.cf]) || "";
  const bg = (f.hl && doc.colors[f.hl]) || (f.cb && doc.colors[f.cb]) || "";
  s.backgroundColor = bg;
  s.verticalAlign = f.va === "super" ? "super" : f.va === "sub" ? "sub" : "";
}

function styleParagraph(p: HTMLElement, doc: RtfDocument, index: number): void {
  const style = doc.paragraphs[index] ?? doc.paragraphs[doc.paragraphs.length - 1];
  p.setAttribute(PARA, String(index));
  if (!style) return;
  const twips = (t: number) => (t ? `${t / 20}pt` : "");
  p.style.textAlign = style.align === "left" ? "" : style.align;
  p.style.marginLeft = twips(style.li);
  p.style.marginRight = twips(style.ri);
  p.style.textIndent = twips(style.fi);
  p.style.marginTop = twips(style.sb);
  p.style.marginBottom = twips(style.sa);
}

/** The document's content split into paragraphs, as the editor shows it. */
export function paragraphsOf(doc: RtfDocument): RtfParagraph[] {
  const out: RtfParagraph[] = [{ style: 0, fmt: doc.endFmt, items: [] }];
  for (const unit of doc.units) {
    const current = out[out.length - 1];
    if (unit.kind === "par") {
      current.fmt = unit.fmt;
      out.push({ style: out.length, fmt: doc.endFmt, items: [] });
    } else if (unit.kind === "char") current.items.push({ kind: "char", ch: unit.ch, fmt: unit.fmt });
    else current.items.push({ kind: "atom", id: unit.id });
  }
  for (const p of out) {
    const first = p.items.find((item) => item.kind === "char");
    if (first && first.kind === "char") p.fmt = first.fmt;
  }
  return out;
}

export function unitsOf(paragraphs: readonly RtfParagraph[]): RtfEditUnit[] {
  const out: RtfEditUnit[] = [];
  paragraphs.forEach((p, k) => {
    if (k > 0) out.push({ kind: "par" });
    out.push(...p.items);
  });
  return out;
}

type AtomIndex = ReadonlyMap<number, Extract<RtfDocument["units"][number], { kind: "atom" }>>;

export function atomIndex(doc: RtfDocument): AtomIndex {
  const out = new Map<number, Extract<RtfDocument["units"][number], { kind: "atom" }>>();
  for (const unit of doc.units) if (unit.kind === "atom") out.set(unit.id, unit);
  return out;
}

function renderParagraph(doc: RtfDocument, atoms: AtomIndex, p: RtfParagraph): HTMLElement {
  const el = document.createElement("p");
  el.className = "rtf-paragraph";
  styleParagraph(el, doc, p.style);
  el.setAttribute(FMT, encodeFormat(p.fmt));
  let span: HTMLElement | null = null;
  let spanFmt = "";
  for (const item of p.items) {
    if (item.kind === "atom") {
      span = null;
      const unit = atoms.get(item.id);
      const atom = document.createElement("span");
      atom.className = "rtf-atom";
      atom.contentEditable = "false";
      atom.setAttribute(ATOM, String(item.id));
      atom.textContent = unit ? unit.text || unit.label : "[object]";
      if (unit) styleFormat(atom, unit.fmt, doc);
      el.append(atom);
      continue;
    }
    if (item.ch === "\n") {
      span = null;
      const br = document.createElement("br");
      br.setAttribute(LINE, "");
      el.append(br);
      continue;
    }
    const key = encodeFormat(item.fmt);
    if (!span || spanFmt !== key) {
      span = document.createElement("span");
      styleFormat(span, item.fmt, doc);
      spanFmt = key;
      el.append(span);
    }
    span.append(item.ch);
  }
  // An empty or line-ending paragraph needs a placeholder to keep its height.
  if (!p.items.length || el.lastChild instanceof HTMLBRElement) el.append(document.createElement("br"));
  return el;
}

export function renderRtf(root: HTMLElement, doc: RtfDocument, paragraphs: readonly RtfParagraph[]): void {
  const fragment = document.createDocumentFragment();
  const atoms = atomIndex(doc);
  for (const p of paragraphs) fragment.append(renderParagraph(doc, atoms, p));
  root.replaceChildren(fragment);
  for (const span of root.querySelectorAll("span")) span.normalize();
}

/** The nearest stored format for a node inside the editor. */
function formatAt(node: Node, root: HTMLElement, fallback: RtfFormat): RtfFormat {
  let el: Element | null = node instanceof Element ? node : node.parentElement;
  let format: RtfFormat | null = null;
  const tags = { b: false, i: false, u: false, s: false };
  while (el && el !== root && !format) {
    format = decodeFormat(el.getAttribute(FMT));
    const tag = el.tagName;
    if (tag === "B" || tag === "STRONG") tags.b = true;
    if (tag === "I" || tag === "EM") tags.i = true;
    if (tag === "U") tags.u = true;
    if (tag === "S" || tag === "STRIKE" || tag === "DEL") tags.s = true;
    el = el.parentElement;
  }
  const f = { ...(format ?? fallback) };
  if (tags.b) f.b = true;
  if (tags.i) f.i = true;
  if (tags.u) f.ul = true;
  if (tags.s) f.strike = true;
  return f;
}

function isPlaceholderBreak(br: Element, block: Element): boolean {
  if (br.hasAttribute(LINE)) return false;
  let next: Node | null = br;
  // A trailing <br> only holds the line open.
  while (next && next !== block) {
    if (next.nextSibling) return false;
    next = next.parentNode;
  }
  return true;
}

function readBlock(block: Element, root: HTMLElement, fallback: RtfParagraph): RtfParagraph {
  const fmt = decodeFormat(block.getAttribute(FMT)) ?? fallback.fmt;
  const style = Number.parseInt(block.getAttribute(PARA) ?? "", 10);
  const para: RtfParagraph = { style: Number.isFinite(style) ? style : fallback.style, fmt, items: [] };
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (node instanceof Element && node.hasAttribute(ATOM)) {
      para.items.push({ kind: "atom", id: Number(node.getAttribute(ATOM)) });
      node = walker.nextSibling() ?? nextOutside(walker, block);
      continue;
    }
    if (node instanceof HTMLBRElement && !isPlaceholderBreak(node, block)) {
      para.items.push({ kind: "char", ch: "\n", fmt: formatAt(node, root, fmt) });
    } else if (node.nodeType === Node.TEXT_NODE) {
      const f = formatAt(node, root, fmt);
      for (const ch of (node.nodeValue ?? "").split("")) para.items.push({ kind: "char", ch: ch === "\r" ? "\n" : ch, fmt: f });
    }
    node = walker.nextNode();
  }
  return para;
}

/** Next node after the current subtree, staying inside `block`. */
function nextOutside(walker: TreeWalker, block: Element): Node | null {
  let current: Node | null = walker.currentNode;
  while (current && current !== block) {
    walker.currentNode = current;
    const sibling = walker.nextSibling();
    if (sibling) return sibling;
    current = current.parentNode;
  }
  return null;
}

/** Read the editor DOM back into paragraphs. */
export function readRtf(root: HTMLElement, doc: RtfDocument): RtfParagraph[] {
  const out: RtfParagraph[] = [];
  const fallback: RtfParagraph = { style: 0, fmt: doc.endFmt ?? defaultFormat(), items: [] };
  for (const child of Array.from(root.childNodes)) {
    const previous = out[out.length - 1] ?? fallback;
    if (child instanceof Element) out.push(readBlock(child, root, previous));
    else if (child.nodeType === Node.TEXT_NODE && child.nodeValue) {
      out.push({ style: previous.style, fmt: previous.fmt, items: child.nodeValue.split("").map((ch) => ({ kind: "char", ch, fmt: previous.fmt })) });
    }
  }
  if (!out.length) out.push(fallback);
  return out;
}

type FormatChange = (f: RtfFormat) => RtfFormat;

/** Text nodes inside `range` that are editable (not inside an object). */
function selectedTextNodes(root: HTMLElement, range: Range): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (range.intersectsNode(node) && !node.parentElement?.closest(`[${ATOM}]`) && node.length) out.push(node);
    node = walker.nextNode() as Text | null;
  }
  return out;
}

/** Formats of the selected text, for toggles. */
export function selectedFormats(root: HTMLElement, range: Range, doc: RtfDocument): RtfFormat[] {
  return selectedTextNodes(root, range).map((node) => formatAt(node, root, doc.endFmt));
}

/** Re-wrap the selected text with a changed format; returns false when nothing was selected. */
export function applyRtfFormat(root: HTMLElement, range: Range, doc: RtfDocument, change: FormatChange): boolean {
  if (range.collapsed) return false;
  const nodes = selectedTextNodes(root, range);
  const wrapped: HTMLElement[] = [];
  for (const node of nodes) {
    let target = node;
    if (node === range.endContainer && range.endOffset < target.length) target.splitText(range.endOffset);
    if (node === range.startContainer && range.startOffset > 0) target = target.splitText(range.startOffset);
    if (!target.length) continue;
    const span = document.createElement("span");
    styleFormat(span, change(formatAt(target, root, doc.endFmt)), doc);
    target.replaceWith(span);
    span.append(target);
    wrapped.push(span);
  }
  if (!wrapped.length) return false;
  const selection = root.ownerDocument.getSelection();
  const next = document.createRange();
  next.setStartBefore(wrapped[0]);
  next.setEndAfter(wrapped[wrapped.length - 1]);
  selection?.removeAllRanges();
  selection?.addRange(next);
  return true;
}

/** Insert plain text at the selection (paste); line breaks become RTF line breaks. */
export function insertPlainText(root: HTMLElement, text: string): void {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;
  range.deleteContents();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const node = document.createTextNode(lines.join("\n"));
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}
