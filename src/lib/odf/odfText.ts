import { decodeXmlText, escapeXmlAttribute, escapeXmlText } from "../ooxml/xmlScan";
import type { XmlDoc, XmlEl, XmlSplice } from "../pptx/xmlTree";
import { isOdf, odfAttr, prefixOfEl, rootPrefix, ODF_NS } from "./odfNames";
import type { OdfStyles, TextLook } from "./odfStyles";

// Paragraph text (text:p / text:h) as a flat item list, and edits that
// rewrite one paragraph's inner XML from that list. White space follows ODF
// 1.3 Part 3 section 6.1.2: literal runs of space, tab and line feed collapse
// to one space; text:s, text:tab and text:line-break carry the rest. Inline
// markers Mesa does not model (bookmarks, frames, comments) are kept as
// atoms at their text position. Anything else makes the paragraph read-only.

export type OdfItem =
  | { readonly kind: "text"; readonly text: string; readonly style: string | null }
  | { readonly kind: "atom"; readonly xml: string; readonly style: string | null };

export interface OdfParagraph {
  readonly el: XmlEl;
  readonly items: readonly OdfItem[];
  readonly plain: string;
  /** Why Mesa will not edit it, or `null`. */
  readonly refusal: string | null;
}

/** An edit Mesa will not make, with a reason for the user. */
export class OdfEditRefusal extends Error {}

export const MAX_PARAGRAPH_CHARS = 200_000;

const TEXT_ATOMS = new Set([
  "bookmark", "bookmark-start", "bookmark-end", "soft-page-break", "reference-mark", "reference-mark-start",
  "reference-mark-end", "toc-mark", "toc-mark-start", "toc-mark-end", "alphabetical-index-mark",
  "alphabetical-index-mark-start", "alphabetical-index-mark-end", "user-index-mark", "user-index-mark-start", "user-index-mark-end",
]);
const TRACKED = new Set(["change", "change-start", "change-end"]);
const SKIPPED_CONTENT = new Set(["note-body", "annotation", "tracked-changes"]);

function isAtom(el: XmlEl): boolean {
  if (el.ns === ODF_NS.draw) return true;
  if (el.ns === ODF_NS.office) return el.localName === "annotation" || el.localName === "annotation-end";
  return el.ns === ODF_NS.text && TEXT_ATOMS.has(el.localName);
}

function describe(el: XmlEl): string {
  if (isOdf(el, "text", "a")) return "a link";
  if (isOdf(el, "text", "note")) return "a footnote or endnote";
  if (isOdf(el, "text", "span")) return "nested formatting";
  if (el.ns === ODF_NS.text) return `a field (${el.localName})`;
  return `an element Mesa does not edit (${el.name})`;
}

interface Walk { items: OdfItem[]; refusal: string | null; lastSpace: boolean; chars: number }

/** Keeps at most one character past the limit, so the length refusal fires
 *  without first building a paragraph `text:s` counts could make huge. */
function pushText(walk: Walk, fullText: string, style: string | null): void {
  const text = fullText.slice(0, Math.max(0, MAX_PARAGRAPH_CHARS + 1 - walk.chars));
  if (!text) return;
  walk.chars += text.length;
  const last = walk.items[walk.items.length - 1];
  if (last?.kind === "text" && last.style === style) walk.items[walk.items.length - 1] = { kind: "text", text: last.text + text, style };
  else walk.items.push({ kind: "text", text, style });
}

/** Literal character data, collapsed. `lastSpace` starts true so leading white space drops. */
function pushLiteral(walk: Walk, raw: string, style: string | null): void {
  if (!raw) return;
  let out = "";
  for (const ch of decodeXmlText(raw)) {
    const space = ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
    if (space && walk.lastSpace) continue;
    out += space ? " " : ch;
    walk.lastSpace = space;
  }
  pushText(walk, out, style);
}

function refuse(walk: Walk, why: string): void {
  walk.refusal ??= why;
}

/** One element inside a paragraph; returns the frame to descend into, if any. */
function visit(doc: XmlDoc, walk: Walk, el: XmlEl, style: string | null, depth: number): { el: XmlEl; style: string | null } | null {
  if (isOdf(el, "text", "s")) {
    const room = MAX_PARAGRAPH_CHARS + 1 - walk.chars;
    pushText(walk, " ".repeat(Math.max(0, Math.min(10_000, room, Math.max(1, Number(odfAttr(el, "text", "c") ?? 1) || 1)))), style);
    return null;
  }
  if (isOdf(el, "text", "tab")) { pushText(walk, "\t", style); return null; }
  if (isOdf(el, "text", "line-break")) { pushText(walk, "\n", style); return null; }
  if (el.ns === ODF_NS.text && TRACKED.has(el.localName)) { refuse(walk, "This paragraph is part of a tracked change, which Mesa does not edit."); return null; }
  if (isAtom(el)) { walk.items.push({ kind: "atom", xml: doc.text.slice(el.start, el.end), style }); return null; }
  if (SKIPPED_CONTENT.has(el.localName)) { refuse(walk, `This paragraph contains ${describe(el)}, which Mesa keeps but does not edit.`); return null; }
  if (isOdf(el, "text", "span") && depth === 0) return { el, style: odfAttr(el, "text", "style-name") };
  refuse(walk, `This paragraph contains ${describe(el)}, which Mesa keeps but does not edit.`);
  return el.children.length || el.innerEnd > el.innerStart ? { el, style } : null;
}

interface Frame { el: XmlEl; style: string | null; next: number; pos: number; depth: number }

/** Reads a paragraph's text and inline structure without recursion. */
export function readParagraph(doc: XmlDoc, el: XmlEl): OdfParagraph {
  const walk: Walk = { items: [], refusal: null, lastSpace: true, chars: 0 };
  if (!doc.utf8) refuse(walk, "This document is stored as UTF-16, which Mesa does not edit.");
  const stack: Frame[] = [{ el, style: null, next: 0, pos: el.innerStart, depth: 0 }];
  for (let guard = 0; stack.length && guard < 4 * (el.end - el.start + 2); guard++) {
    const top = stack[stack.length - 1];
    if (top.el.hasMarkupText) refuse(walk, "This paragraph holds XML comments or CDATA, which Mesa does not edit.");
    const next = top.el.children[top.next];
    if (!next) {
      pushLiteral(walk, doc.text.slice(top.pos, top.el.innerEnd), top.style);
      stack.pop();
      continue;
    }
    pushLiteral(walk, doc.text.slice(top.pos, next.start), top.style);
    top.next += 1;
    top.pos = next.end;
    const inner = visit(doc, walk, next, top.style, top.depth);
    if (inner) stack.push({ el: inner.el, style: inner.style, next: 0, pos: inner.el.innerStart, depth: top.depth + 1 });
  }
  const plain = itemsText(walk.items);
  if (plain.length > MAX_PARAGRAPH_CHARS) refuse(walk, "This paragraph is too long to edit here.");
  return { el, items: walk.items, plain, refusal: walk.refusal };
}

export function itemsText(items: readonly OdfItem[]): string {
  let out = "";
  for (const item of items) if (item.kind === "text") out += item.text;
  return out;
}

// ---------- writing ----------

/** Encodes text for paragraph content; spaces that would collapse become text:s. */
export function encodeOdfText(text: string, prefix: string, before = "", after = ""): string {
  const out: string[] = [];
  const p = prefix ? `${prefix}:` : "";
  let i = 0;
  for (let guard = 0; i < text.length && guard <= text.length; guard++) {
    const ch = text[i];
    if (ch === " ") {
      let n = 1;
      while (text[i + n] === " ") n++;
      const prev = i > 0 ? text[i - 1] : before;
      const next = i + n < text.length ? text[i + n] : after;
      const literal = prev !== "" && !/\s/.test(prev) && next !== "" && !/\s/.test(next);
      const counted = literal ? n - 1 : n;
      if (literal) out.push(" ");
      if (counted > 0) out.push(counted === 1 ? `<${p}s/>` : `<${p}s ${p}c="${counted}"/>`);
      i += n;
      continue;
    }
    if (ch === "\t") out.push(`<${p}tab/>`);
    else if (ch === "\n") out.push(`<${p}line-break/>`);
    else if (ch !== "\r") out.push(escapeXmlText(ch));
    i += 1;
  }
  return out.join("");
}

/** Last (or first) character of a neighbouring text item; "" for an atom or none. */
function neighbour(items: readonly OdfItem[], index: number, last: boolean): string {
  const item = items[index];
  if (item?.kind !== "text" || !item.text) return "";
  return last ? item.text[item.text.length - 1] : item.text[0];
}

/** Inner XML for a paragraph's items: spans for styled runs, atoms verbatim. */
export function serializeItems(items: readonly OdfItem[], prefix: string): string {
  const out: string[] = [];
  const p = prefix ? `${prefix}:` : "";
  let open: string | null = null;
  for (const [index, item] of items.entries()) {
    if (item.style !== open) {
      if (open !== null) out.push(`</${p}span>`);
      if (item.style !== null) out.push(`<${p}span ${p}style-name="${escapeXmlAttribute(item.style)}">`);
      open = item.style;
    }
    out.push(item.kind === "text" ? encodeOdfText(item.text, prefix, neighbour(items, index - 1, true), neighbour(items, index + 1, false)) : item.xml);
  }
  if (open !== null) out.push(`</${p}span>`);
  return out.join("");
}

function normalizeItems(items: readonly OdfItem[]): OdfItem[] {
  const out: OdfItem[] = [];
  for (const item of items) {
    if (item.kind === "text") {
      if (!item.text) continue;
      const last = out[out.length - 1];
      if (last?.kind === "text" && last.style === item.style) { out[out.length - 1] = { ...last, text: last.text + item.text }; continue; }
    }
    out.push(item);
  }
  return out;
}

/** Splits text items so that `at` falls on an item boundary; returns the index of the first item at or after `at`. */
function splitAt(items: OdfItem[], at: number): number {
  let pos = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== "text") { if (pos >= at) return i; continue; }
    if (pos >= at) return i;
    const end = pos + item.text.length;
    if (at < end) {
      items.splice(i, 1, { ...item, text: item.text.slice(0, at - pos) }, { ...item, text: item.text.slice(at - pos) });
      return i + 1;
    }
    pos = end;
  }
  return items.length;
}

/** Replaces the paragraph's text with `next`, changing only the differing middle. Atoms are kept. */
export function replaceItemsText(items: readonly OdfItem[], next: string): OdfItem[] {
  const old = itemsText(items);
  if (old === next) return [...items];
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head++;
  let tail = 0;
  while (tail < old.length - head && tail < next.length - head && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const work = [...items];
  const from = splitAt(work, head);
  const to = splitAt(work, old.length - tail);
  const removed = work.slice(from, to);
  const styleSource = work[from - 1]?.kind === "text" ? work[from - 1] : removed.find((i) => i.kind === "text") ?? work[to] ?? work[from - 1];
  const inserted: OdfItem = { kind: "text", text: next.slice(head, next.length - tail), style: styleSource?.style ?? null };
  const keptAtoms = removed.filter((i) => i.kind === "atom");
  return normalizeItems([...work.slice(0, from), inserted, ...keptAtoms, ...work.slice(to)]);
}

/** Restyles text items in [start, end) with `restyle(style)`. */
export function restyleRange(items: readonly OdfItem[], start: number, end: number, restyle: (style: string | null) => string | null): OdfItem[] {
  const work = [...items];
  const from = splitAt(work, start);
  const to = splitAt(work, end);
  for (let i = from; i < to; i++) {
    const item = work[i];
    if (item.kind === "text") work[i] = { ...item, style: restyle(item.style) };
  }
  return normalizeItems(work);
}

/** Splice that replaces a paragraph's inner XML; an empty element is expanded. */
export function paragraphSplice(doc: XmlDoc, el: XmlEl, items: readonly OdfItem[]): XmlSplice {
  const inner = serializeItems(items, prefixOfEl(el));
  if (el.innerStart === el.end && doc.text[el.end - 2] === "/") {
    const startTag = doc.text.slice(el.start, el.end - 2).replace(/\s+$/, "");
    return { start: el.start, end: el.end, text: `${startTag}>${inner}</${el.name}>` };
  }
  return { start: el.innerStart, end: el.innerEnd, text: inner };
}

// ---------- formatting ----------

export type FormatProp = "bold" | "italic";

const PROP_ATTRS: Record<FormatProp, readonly [string, string]> = { bold: ["font-weight", "bold"], italic: ["font-style", "italic"] };
const OFF_VALUE: Record<FormatProp, string> = { bold: "normal", italic: "normal" };

/**
 * Creates automatic text styles that add or remove bold or italic on top of
 * an existing span style. New styles go into content.xml's own
 * `office:automatic-styles`, so styles.xml never changes. Each base style
 * and change is created once per edit.
 */
export class StyleMaker {
  private readonly made = new Map<string, string>();
  private readonly xml: string[] = [];
  private counter = 0;

  constructor(private readonly doc: XmlDoc, private readonly styles: OdfStyles) {}

  look(paragraphStyle: string | null, span: string | null): TextLook {
    return { ...this.styles.look("paragraph", paragraphStyle), ...this.styles.look("text", span) };
  }

  derive(base: string | null, prop: FormatProp, on: boolean): string {
    const key = `${base ?? ""}\u0000${prop}\u0000${on}`;
    const hit = this.made.get(key);
    if (hit) return hit;
    const sp = rootPrefix(this.doc.root, "style");
    const fo = rootPrefix(this.doc.root, "fo");
    if (!sp || !fo) throw new OdfEditRefusal("This document does not declare the style namespaces, so Mesa cannot add formatting.");
    let name = "";
    for (let guard = 0; guard < 100_000 && (!name || this.styles.names.has(name)); guard++) name = `Mesa_T${++this.counter}`;
    const entry = base ? this.styles.byKey.get(`text:${base}`) : undefined;
    const [attrLocal, onValue] = PROP_ATTRS[prop];
    const value = on ? onValue : OFF_VALUE[prop];
    let parent = "";
    let copied = "";
    if (entry?.automaticInContent) {
      const parentName = odfAttr(entry.el, "style", "parent-style-name");
      if (parentName) parent = ` ${sp}:parent-style-name="${escapeXmlAttribute(parentName)}"`;
      const props = entry.el.children.find((c) => isOdf(c, "style", "text-properties"));
      for (const [qname, raw] of props?.attrs ?? []) {
        const local = qname.slice(qname.indexOf(":") + 1);
        if (local === attrLocal || local === `${attrLocal}-asian` || local === `${attrLocal}-complex`) continue;
        copied += ` ${qname}="${raw.replace(/"/g, "&quot;")}"`;
      }
    } else if (base) parent = ` ${sp}:parent-style-name="${escapeXmlAttribute(base)}"`;
    const set = ` ${fo}:${attrLocal}="${value}" ${sp}:${attrLocal}-asian="${value}" ${sp}:${attrLocal}-complex="${value}"`;
    this.xml.push(`<${sp}:style ${sp}:name="${name}" ${sp}:family="text"${parent}><${sp}:text-properties${copied}${set}/></${sp}:style>`);
    this.made.set(key, name);
    return name;
  }

  /** The splice that adds the new styles, or `null` when none were made. */
  splice(): XmlSplice | null {
    if (!this.xml.length) return null;
    const auto = this.doc.root.children.find((c) => isOdf(c, "office", "automatic-styles"));
    const added = this.xml.join("");
    if (!auto) {
      const body = this.doc.root.children.find((c) => isOdf(c, "office", "body"));
      const op = rootPrefix(this.doc.root, "office");
      if (!body || !op) throw new OdfEditRefusal("This document has no place for new styles.");
      return { start: body.start, end: body.start, text: `<${op}:automatic-styles>${added}</${op}:automatic-styles>` };
    }
    if (auto.innerStart === auto.end && this.doc.text[auto.end - 2] === "/") {
      const startTag = this.doc.text.slice(auto.start, auto.end - 2).replace(/\s+$/, "");
      return { start: auto.start, end: auto.end, text: `${startTag}>${added}</${auto.name}>` };
    }
    return { start: auto.innerEnd, end: auto.innerEnd, text: added };
  }
}

/** True when every text character in [start, end) has the property on. */
export function rangeHas(items: readonly OdfItem[], start: number, end: number, has: (style: string | null) => boolean): boolean {
  let pos = 0;
  let any = false;
  for (const item of items) {
    if (item.kind !== "text") continue;
    const s = Math.max(start, pos);
    const e = Math.min(end, pos + item.text.length);
    if (e > s) { any = true; if (!has(item.style)) return false; }
    pos += item.text.length;
  }
  return any;
}
