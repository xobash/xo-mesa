import { OoxmlPackageError } from "./zipContainer";

// Linear, non-recursive start-tag scanner for OOXML parts. It never builds a
// tree, so nesting depth cannot exhaust the stack. Each character is visited
// a bounded number of times. Comments, processing instructions and CDATA are
// skipped; a DOCTYPE is refused (OOXML forbids DTDs, and a downstream DOM
// parser could expand entity definitions).

export interface XmlStartTag {
  /** Qualified name, e.g. `w:ins`. */
  readonly qname: string;
  /** Text between the name and the closing `>` (attributes, optional `/`). */
  readonly attributes: string;
  /** Index just after the tag's closing `>`. */
  readonly end: number;
}

const UTF8 = new TextDecoder("utf-8");

export function decodeXmlPart(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return UTF8.decode(bytes); // strips a UTF-8 BOM
}

/** Refuses the part as XML Mesa does not open. */
export function refuseXml(message: string): never {
  throw new OoxmlPackageError("unsupportedXml", message);
}

/** Index after the next `marker` at or after `from`; refuses a truncated construct. */
export function skipPast(xml: string, from: number, marker: string): number {
  const end = xml.indexOf(marker, from);
  if (end < 0) refuseXml("An XML part is truncated.");
  return end + marker.length;
}

/** Index after the tag's closing `>`, honouring quoted attribute values. */
export function tagEnd(xml: string, from: number): number {
  let quote = "";
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i + 1;
  }
  return refuseXml("An XML part is truncated.");
}

/** Index where the element name starting at `from` stops (whitespace, `/` or `>`), at most `limit`. */
export function nameEnd(xml: string, from: number, limit: number): number {
  for (let i = from; i < limit; i++) {
    const ch = xml.charCodeAt(i);
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0x2f || ch === 0x3e) return i;
  }
  return limit;
}

export interface XmlTagAt {
  readonly kind: "start" | "end" | "empty";
  readonly qname: string;
  /** Index of `<`. */
  readonly start: number;
  /** Index after `>`. */
  readonly end: number;
  /** Attribute text range (between the name and `/>` or `>`). */
  readonly attrStart: number;
  readonly attrEnd: number;
}

/**
 * The next element tag at or after `from` (before `limit`), skipping
 * comments, processing instructions and CDATA. `null` when none is left.
 * Refuses a DTD and a truncated construct.
 */
export function nextTag(xml: string, from: number, limit = xml.length): XmlTagAt | null {
  let at = from;
  for (let guard = 0; guard <= limit; guard++) {
    const open = xml.indexOf("<", at);
    if (open < 0 || open >= limit) return null;
    if (xml.startsWith("<!--", open)) { at = skipPast(xml, open + 4, "-->"); continue; }
    if (xml.startsWith("<![CDATA[", open)) { at = skipPast(xml, open + 9, "]]>"); continue; }
    if (xml.startsWith("<?", open)) { at = skipPast(xml, open + 2, "?>"); continue; }
    if (xml.startsWith("<!", open)) refuseXml("An XML part declares a DTD, which Office Open XML does not allow.");
    const end = tagEnd(xml, open + 1);
    const isEnd = xml[open + 1] === "/";
    const nameStart = isEnd ? open + 2 : open + 1;
    const close = xml[end - 2] === "/" && !isEnd ? end - 2 : end - 1;
    const nameStop = nameEnd(xml, nameStart, close);
    return {
      kind: isEnd ? "end" : close === end - 2 ? "empty" : "start",
      qname: xml.slice(nameStart, nameStop), start: open, end, attrStart: nameStop, attrEnd: close,
    };
  }
  return null;
}

/** Calls `visit` for each start (or empty) tag in document order. Returning `false` stops the scan. */
export function forEachStartTag(xml: string, visit: (tag: XmlStartTag) => boolean | void): void {
  let at = 0;
  for (let guard = 0; guard <= xml.length; guard++) {
    const tag = nextTag(xml, at);
    if (!tag) return;
    at = tag.end;
    if (tag.kind === "end") continue;
    // Keep the self-closing slash in `attributes`, as callers have always seen it.
    if (visit({ qname: tag.qname, attributes: xml.slice(tag.attrStart, tag.end - 1), end: tag.end }) === false) return;
  }
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function skipSpaces(text: string, from: number): number {
  let i = from;
  while (i < text.length && isSpace(text[i])) i++;
  return i;
}

/** Attribute map of one tag, in one linear pass. Entity references in values are left encoded. */
export function readAttributes(attributes: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < attributes.length) {
    i = skipSpaces(attributes, i);
    const start = i;
    while (i < attributes.length && !isSpace(attributes[i]) && attributes[i] !== "=" && attributes[i] !== "/") i++;
    const name = attributes.slice(start, i);
    i = skipSpaces(attributes, i);
    if (attributes[i] !== "=") { i = Math.max(i, start + 1); continue; }
    i = skipSpaces(attributes, i + 1);
    const quote = attributes[i];
    if (quote !== '"' && quote !== "'") continue;
    const close = attributes.indexOf(quote, i + 1);
    if (close < 0) break;
    if (name) out.set(name, attributes.slice(i + 1, close));
    i = close + 1;
  }
  return out;
}

export function localName(qname: string): string {
  const colon = qname.indexOf(":");
  return colon < 0 ? qname : qname.slice(colon + 1);
}

export function prefixOf(qname: string): string {
  const colon = qname.indexOf(":");
  return colon < 0 ? "" : qname.slice(0, colon);
}

/**
 * Collects every namespace declaration in the part, per prefix. A prefix
 * redeclared to several URIs keeps all of them, so matching stays
 * conservative (it may over-report, never under-report).
 */
export function namespaceDeclarations(attributes: string, into: Map<string, Set<string>>): void {
  if (!attributes.includes("xmlns")) return;
  for (const [name, value] of readAttributes(attributes)) {
    if (name !== "xmlns" && !name.startsWith("xmlns:")) continue;
    const prefix = name === "xmlns" ? "" : name.slice(6);
    const uris = into.get(prefix) ?? new Set<string>();
    uris.add(value);
    into.set(prefix, uris);
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Decodes XML character and entity references; an unknown reference stays literal. Linear. */
export function decodeXmlText(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, ref: string) => {
    if (ref[0] !== "#") return NAMED_ENTITIES[ref] ?? whole;
    const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

// eslint-disable-next-line no-control-regex -- XML 1.0 cannot carry these characters.
const XML_ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

/** Drops characters XML 1.0 cannot carry (C0 controls other than tab, LF, CR; U+FFFE, U+FFFF). */
export function stripXmlIllegal(text: string): string {
  return text.replace(XML_ILLEGAL, "");
}

/** Escapes text content for an element body; characters XML 1.0 cannot carry are dropped. */
export function escapeXmlText(text: string): string {
  return stripXmlIllegal(text).replace(/[&<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"));
}

/**
 * Escapes an attribute value for double quotes. Tabs and line breaks become
 * character references, because a conforming reader normalizes raw ones in an
 * attribute to spaces; characters XML 1.0 cannot carry are dropped.
 */
export function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/["\t\n\r]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Range of one attribute's value inside `xml[from, to)` (a tag's attribute
 * text), or `null`. Matches the exact name, not a prefixed or longer one.
 */
export function findAttributeValue(xml: string, from: number, to: number, name: string): { start: number; end: number; nameStart: number } | null {
  let i = from;
  for (let guard = 0; guard <= to - from && i < to; guard++) {
    while (i < to && isSpace(xml[i])) i++;
    const nameStart = i;
    while (i < to && !isSpace(xml[i]) && xml[i] !== "=" && xml[i] !== "/" && xml[i] !== ">") i++;
    const found = xml.slice(nameStart, i);
    while (i < to && isSpace(xml[i])) i++;
    if (xml[i] !== "=") { i = Math.max(i, nameStart + 1); continue; }
    i++;
    while (i < to && isSpace(xml[i])) i++;
    const quote = xml[i];
    if (quote !== '"' && quote !== "'") return null;
    const close = xml.indexOf(quote, i + 1);
    if (close < 0 || close >= to) return null;
    if (found === name) return { start: i + 1, end: close, nameStart };
    i = close + 1;
  }
  return null;
}

/** Range of a whole attribute (leading whitespace through the closing quote), or `null`. */
export function findAttributeSpan(xml: string, from: number, to: number, name: string): { start: number; end: number } | null {
  const value = findAttributeValue(xml, from, to, name);
  if (!value) return null;
  let start = value.nameStart;
  while (start > from && isSpace(xml[start - 1])) start--;
  return { start, end: value.end + 1 };
}

export interface TopLevelElement {
  readonly name: string;
  readonly qname: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Children of the root element, with their ranges, plus the root's own tag
 * positions. `skip` may jump over a large child: given its start tag, it
 * returns the index after the child's end tag (or `null` to walk it).
 * No recursion; nesting is tracked with a counter.
 */
export function listTopLevel(xml: string, skip?: (name: string, tag: XmlTagAt) => number | null): { root: XmlTagAt; rootClose: number; children: TopLevelElement[] } {
  const root = nextTag(xml, 0);
  if (!root || root.kind !== "start") refuseXml("An XML part has no root element.");
  const { close, children } = listChildren(xml, root, skip);
  return { root, rootClose: close, children };
}

/**
 * Children of the element whose start tag is `parent`, and the index of its
 * end tag. Same walk and `skip` contract as `listTopLevel`.
 */
export function listChildren(xml: string, parent: XmlTagAt, skip?: (name: string, tag: XmlTagAt) => number | null): { close: number; children: TopLevelElement[] } {
  const children: TopLevelElement[] = [];
  let at = parent.end;
  let depth = 0;
  let open: XmlTagAt | null = null;
  for (let guard = 0; guard <= xml.length; guard++) {
    const tag = nextTag(xml, at);
    if (!tag) break;
    at = tag.end;
    if (depth === 0) {
      if (tag.kind === "end") return { close: tag.start, children };
      const name = localName(tag.qname);
      const jump = tag.kind === "start" && skip ? skip(name, tag) : null;
      if (tag.kind === "empty" || jump !== null) {
        const end = jump ?? tag.end;
        children.push({ name, qname: tag.qname, start: tag.start, end });
        at = end;
        continue;
      }
      open = tag;
      depth = 1;
    } else if (tag.kind === "start") {
      depth++;
    } else if (tag.kind === "end" && --depth === 0 && open) {
      children.push({ name: localName(open.qname), qname: open.qname, start: open.start, end: tag.end });
      open = null;
    }
  }
  return refuseXml("An XML part is truncated.");
}
