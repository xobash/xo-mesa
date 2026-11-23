import { NS } from "./pptxDeck";
import { escapeXmlText } from "../ooxml/xmlScan";
import { applySplices, child, descendants, plainText, type XmlDoc, type XmlEl, type XmlSplice } from "./xmlTree";

// Text edits inside one `p:txBody`, as splices of the original part text.
// Existing runs keep their `a:rPr`; only the `a:t` content that changed is
// rewritten. A new paragraph copies the previous paragraph's `a:pPr`, run
// properties and end-of-paragraph properties. Bodies holding anything Mesa
// cannot round-trip (line breaks, fields, math, comments in text) are refused.

/** An edit Mesa will not make, with a reason for the user. */
export class PptxEditRefusal extends Error {}

export const MAX_EDIT_TEXT_CHARS = 1_000_000;

const indexCache = new WeakMap<XmlDoc, Map<XmlEl, number>>();

/** Every `p:txBody` in the part, numbered in document order. */
export function textBodyIndex(doc: XmlDoc): ReadonlyMap<XmlEl, number> {
  let map = indexCache.get(doc);
  if (!map) {
    map = new Map();
    for (const el of descendants(doc.root)) if (el.localName === "txBody" && NS.p.has(el.ns)) map.set(el, map.size);
    indexCache.set(doc, map);
  }
  return map;
}

export function findTextBody(doc: XmlDoc, index: number): XmlEl | null {
  for (const [el, i] of textBodyIndex(doc)) if (i === index) return el;
  return null;
}

const PARAGRAPH_CHILDREN = new Set(["pPr", "r", "endParaRPr"]);

/** Why Mesa will not edit this text body, or `null` when it can. */
export function textBodyEditRefusal(doc: XmlDoc, body: XmlEl): string | null {
  if (!doc.utf8) return "This slide is stored as UTF-16, which Mesa does not edit.";
  const paragraphs = body.children.filter((c) => c.localName === "p");
  if (paragraphs.length === 0) return "This text box has no paragraphs.";
  for (const p of paragraphs) {
    if (p.hasMarkupText) return "This text holds XML comments or CDATA, which Mesa does not edit.";
    for (const node of p.children) {
      if (node.localName === "br") return "This text has a manual line break, which Mesa does not edit yet.";
      if (node.localName === "fld") return "This text has a field (such as a date or slide number), which Mesa does not edit.";
      if (!PARAGRAPH_CHILDREN.has(node.localName)) return "This text holds an object Mesa does not edit (for example an equation).";
      if (node.localName !== "r") continue;
      const t = child(node, "t");
      if (!t || plainText(doc, t) === null || node.children.some((c) => c.localName !== "rPr" && c.localName !== "t")) return "This text has a run Mesa cannot edit safely.";
    }
  }
  return null;
}

function runsOf(p: XmlEl): XmlEl[] {
  return p.children.filter((c) => c.localName === "r");
}

function runText(doc: XmlDoc, run: XmlEl): string {
  const t = child(run, "t");
  return t ? plainText(doc, t) ?? "" : "";
}

function paragraphText(doc: XmlDoc, p: XmlEl): string {
  return runsOf(p).map((r) => runText(doc, r)).join("");
}

function prefixOf(qname: string): string {
  const colon = qname.indexOf(":");
  return colon < 0 ? "" : qname.slice(0, colon + 1);
}

function source(doc: XmlDoc, el: XmlEl | null): string {
  return el ? doc.text.slice(el.start, el.end) : "";
}

/** `a:endParaRPr` and `a:rPr` share a schema type; reuse it under the run name. */
function runPropsFromEnd(doc: XmlDoc, end: XmlEl | null): string {
  if (!end) return "";
  const target = `${prefixOf(end.name)}rPr`;
  const text = source(doc, end);
  const opened = `<${target}${text.slice(end.name.length + 1)}`;
  return opened.endsWith(`</${end.name}>`) ? `${opened.slice(0, -(end.name.length + 3))}</${target}>` : opened;
}

function newRun(doc: XmlDoc, p: XmlEl, template: XmlEl, text: string): string {
  const a = prefixOf(p.name);
  const lastRun = runsOf(template).at(-1);
  const rPr = lastRun ? source(doc, child(lastRun, "rPr")) : runPropsFromEnd(doc, child(template, "endParaRPr"));
  return `<${a}r>${rPr}<${a}t>${escapeXmlText(text)}</${a}t></${a}r>`;
}

function newParagraph(doc: XmlDoc, template: XmlEl, text: string): string {
  const pPr = source(doc, child(template, "pPr"));
  const run = text === "" ? "" : newRun(doc, template, template, text);
  return `<${template.name}>${pPr}${run}${source(doc, child(template, "endParaRPr"))}</${template.name}>`;
}

function isHigh(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLow(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

function commonEnds(a: string, b: string): [number, number] {
  const limit = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < limit && a[pre] === b[pre]) pre++;
  if (pre > 0 && pre < limit && isHigh(a.charCodeAt(pre - 1))) pre--;
  let suf = 0;
  while (suf < limit - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  if (suf > 0 && isLow(a.charCodeAt(a.length - suf)) && a.length - suf > pre) suf--;
  return [pre, suf];
}

function setRunText(run: XmlEl, text: string): XmlSplice {
  const t = child(run, "t")!;
  const encoded = escapeXmlText(text);
  if (t.innerEnd === t.end) return { start: t.start, end: t.end, text: `<${t.name}>${encoded}</${t.name}>` };
  return { start: t.innerStart, end: t.innerEnd, text: encoded };
}

/** Splices that turn one paragraph's text into `text`, touching only the runs that change. */
function editParagraph(doc: XmlDoc, p: XmlEl, text: string): XmlSplice[] {
  const runs = runsOf(p);
  if (runs.length === 0) {
    if (text === "") return [];
    const end = child(p, "endParaRPr");
    const at = end ? end.start : p.innerEnd;
    if (p.innerEnd === p.end) return [{ start: p.start, end: p.end, text: newParagraph(doc, p, text) }];
    return [{ start: at, end: at, text: newRun(doc, p, p, text) }];
  }
  const texts = runs.map((r) => runText(doc, r));
  const old = texts.join("");
  if (old === text) return [];
  const [pre, suf] = commonEnds(old, text);
  const cutEnd = old.length - suf;
  const insert = text.slice(pre, text.length - suf);
  const splices: XmlSplice[] = [];
  let start = 0;
  let hostFound = false;
  for (let i = 0; i < runs.length; i++) {
    const t = texts[i];
    const end = start + t.length;
    const host = !hostFound && (pre === 0 ? i === 0 : start < pre && pre <= end);
    if (host) hostFound = true;
    const a = Math.min(t.length, Math.max(0, pre - start));
    const b = Math.max(a, Math.min(t.length, cutEnd - start));
    const next = t.slice(0, a) + (host ? insert : "") + t.slice(b);
    if (next !== t) splices.push(setRunText(runs[i], next));
    start = end;
  }
  return splices;
}

/** Normalizes editor text to paragraphs (one per line). */
export function editorParagraphs(text: string): string[] {
  if (text.length > MAX_EDIT_TEXT_CHARS) throw new PptxEditRefusal("This text is too long to save.");
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * New part text with the text body's paragraphs set to `text` (one paragraph
 * per line). Unchanged paragraphs keep their exact source.
 */
export function editTextBody(doc: XmlDoc, index: number, text: string): string {
  const body = findTextBody(doc, index);
  if (!body) throw new PptxEditRefusal("This text box changed; reopen the slide and try again.");
  const refusal = textBodyEditRefusal(doc, body);
  if (refusal) throw new PptxEditRefusal(refusal);
  const paragraphs = body.children.filter((c) => c.localName === "p");
  const lines = editorParagraphs(text);
  const old = paragraphs.map((p) => paragraphText(doc, p));
  let pre = 0;
  while (pre < old.length && pre < lines.length && old[pre] === lines[pre]) pre++;
  let suf = 0;
  while (suf < old.length - pre && suf < lines.length - pre && old[old.length - 1 - suf] === lines[lines.length - 1 - suf]) suf++;
  const oldMid = paragraphs.slice(pre, paragraphs.length - suf);
  const newMid = lines.slice(pre, lines.length - suf);
  const splices: XmlSplice[] = [];
  const paired = Math.min(oldMid.length, newMid.length);
  for (let i = 0; i < paired; i++) splices.push(...editParagraph(doc, oldMid[i], newMid[i]));
  for (let i = paired; i < oldMid.length; i++) splices.push({ start: oldMid[i].start, end: oldMid[i].end, text: "" });
  if (newMid.length > paired) {
    const before = paired > 0 ? oldMid[paired - 1] : pre > 0 ? paragraphs[pre - 1] : null;
    const template = before ?? paragraphs[pre] ?? paragraphs[paragraphs.length - 1];
    const at = before ? before.end : template.start;
    const added = newMid.slice(paired).map((line) => newParagraph(doc, template, line)).join("");
    splices.push({ start: at, end: at, text: added });
  }
  return splices.length ? applySplices(doc.text, splices) : doc.text;
}
