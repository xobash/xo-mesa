import {
  decodeXmlPart, decodeXmlText, localName, nameEnd, prefixOf, readAttributes, refuseXml, skipPast, tagEnd,
} from "../ooxml/xmlScan";

// Offset-aware XML element tree for presentation parts. One linear pass with
// an explicit stack (no recursion), bounded element count and part size.
// Every element keeps its source span so edits splice the original text and
// leave every other byte of the part untouched.

export const XML_TREE_LIMITS = { maxChars: 16 * 1024 * 1024, maxElements: 400_000 } as const;

export interface XmlEl {
  readonly name: string;
  readonly localName: string;
  /** Namespace URI of the element ("" when unbound). */
  readonly ns: string;
  /** Raw attribute values (entities still encoded), keyed by qualified name. */
  readonly attrs: ReadonlyMap<string, string>;
  readonly nsMap: ReadonlyMap<string, string>;
  /** Index of `<`. */
  readonly start: number;
  /** Index after the closing `>` of the end tag (or of an empty tag). */
  end: number;
  /** Index after the start tag's `>`. */
  readonly innerStart: number;
  /** Index of the end tag's `<` (equals `innerStart` for an empty tag). */
  innerEnd: number;
  readonly children: XmlEl[];
  readonly parent: XmlEl | null;
  /** True when the element's direct content holds CDATA, a comment or a PI. */
  hasMarkupText: boolean;
}

export interface XmlDoc {
  readonly text: string;
  readonly root: XmlEl;
  /** The part started with a UTF-8 byte-order mark. */
  readonly utf8Bom: boolean;
  /** The part was UTF-8 (UTF-16 parts are view-only). */
  readonly utf8: boolean;
}

function scopeFor(parent: XmlEl | null, attrs: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const inherited = parent?.nsMap ?? new Map<string, string>();
  let scope: Map<string, string> | null = null;
  for (const [name, value] of attrs) {
    if (name !== "xmlns" && !name.startsWith("xmlns:")) continue;
    scope ??= new Map(inherited);
    scope.set(name === "xmlns" ? "" : name.slice(6), value);
  }
  return scope ?? inherited;
}

function openElement(xml: string, open: number, end: number, parent: XmlEl | null): XmlEl {
  const close = xml[end - 2] === "/" ? end - 2 : end - 1;
  const stop = nameEnd(xml, open + 1, close);
  const name = xml.slice(open + 1, stop);
  if (!name) refuseXml("An XML part has an element without a name.");
  const attrs = readAttributes(xml.slice(stop, close));
  const nsMap = scopeFor(parent, attrs);
  return {
    name, localName: localName(name), ns: nsMap.get(prefixOf(name)) ?? "", attrs, nsMap,
    start: open, end, innerStart: end, innerEnd: end, children: [], parent, hasMarkupText: false,
  };
}

function markText(stack: readonly XmlEl[]): void {
  const top = stack[stack.length - 1];
  if (top) top.hasMarkupText = true;
}

/** Parses an XML part into an element tree. Throws `OoxmlPackageError` on malformed or refused input. */
export function parseXmlTree(bytes: Uint8Array): XmlDoc {
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  const utf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const xml = decodeXmlPart(bytes);
  if (xml.length > XML_TREE_LIMITS.maxChars) refuseXml("An XML part is too large to open.");
  const stack: XmlEl[] = [];
  let root: XmlEl | null = null;
  let count = 0;
  let at = 0;
  for (let guard = 0; guard <= xml.length; guard++) {
    const open = xml.indexOf("<", at);
    if (open < 0) break;
    if (xml.startsWith("<!--", open)) { markText(stack); at = skipPast(xml, open + 4, "-->"); continue; }
    if (xml.startsWith("<![CDATA[", open)) { markText(stack); at = skipPast(xml, open + 9, "]]>"); continue; }
    if (xml.startsWith("<?", open)) { if (stack.length) markText(stack); at = skipPast(xml, open + 2, "?>"); continue; }
    if (xml.startsWith("<!", open)) refuseXml("An XML part declares a DTD, which Office Open XML does not allow.");
    const end = tagEnd(xml, open + 1);
    at = end;
    if (xml[open + 1] === "/") {
      const top = stack.pop();
      const closing = xml.slice(open + 2, nameEnd(xml, open + 2, end - 1));
      if (!top || top.name !== closing) refuseXml("An XML part has mismatched tags.");
      top.innerEnd = open;
      top.end = end;
      continue;
    }
    if (++count > XML_TREE_LIMITS.maxElements) refuseXml("An XML part has too many elements to open.");
    const parent = stack[stack.length - 1] ?? null;
    if (!parent && root) refuseXml("An XML part has more than one root element.");
    const el = openElement(xml, open, end, parent);
    if (parent) parent.children.push(el);
    else root = el;
    if (xml[end - 2] !== "/") stack.push(el);
  }
  if (stack.length || !root) refuseXml("An XML part is truncated.");
  return { text: xml, root, utf8Bom, utf8: !utf16 };
}

/** Elements in document order (iterative pre-order walk). `skip` prunes a subtree. */
export function descendants(el: XmlEl, skip?: (el: XmlEl) => boolean): XmlEl[] {
  const out: XmlEl[] = [];
  const todo: XmlEl[] = [...el.children].reverse();
  for (let guard = 0; todo.length && guard < XML_TREE_LIMITS.maxElements; guard++) {
    const next = todo.pop()!;
    if (skip?.(next)) continue;
    out.push(next);
    for (let i = next.children.length - 1; i >= 0; i--) todo.push(next.children[i]);
  }
  return out;
}

export function child(el: XmlEl | null | undefined, local: string): XmlEl | null {
  if (!el) return null;
  for (const c of el.children) if (c.localName === local) return c;
  return null;
}

export function childrenNamed(el: XmlEl | null | undefined, local: string): XmlEl[] {
  return el ? el.children.filter((c) => c.localName === local) : [];
}

/** First element found by following direct children with these local names. */
export function path(el: XmlEl | null | undefined, ...locals: string[]): XmlEl | null {
  let at: XmlEl | null = el ?? null;
  for (const local of locals) at = child(at, local);
  return at;
}

export function attr(el: XmlEl | null | undefined, name: string): string | null {
  const raw = el?.attrs.get(name);
  return raw === undefined ? null : decodeXmlText(raw);
}

/** An attribute in a namespace, whatever prefix the part binds to it. */
export function nsAttr(el: XmlEl | null | undefined, namespaces: ReadonlySet<string>, local: string): string | null {
  if (!el) return null;
  for (const [name, value] of el.attrs) {
    const colon = name.indexOf(":");
    if (colon < 0 || name.slice(colon + 1) !== local) continue;
    const uri = el.nsMap.get(name.slice(0, colon));
    if (uri && namespaces.has(uri)) return decodeXmlText(value);
  }
  return null;
}

/** The qualified attribute name bound to a namespace on this element, if any. */
export function nsAttrName(el: XmlEl, namespaces: ReadonlySet<string>, local: string): string | null {
  for (const name of el.attrs.keys()) {
    const colon = name.indexOf(":");
    if (colon < 0 || name.slice(colon + 1) !== local) continue;
    const uri = el.nsMap.get(name.slice(0, colon));
    if (uri && namespaces.has(uri)) return name;
  }
  return null;
}

export function intAttr(el: XmlEl | null | undefined, name: string, fallback: number): number {
  const raw = attr(el, name);
  if (raw === null || !/^-?\d+$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : fallback;
}

/** Text content of an element with no children, or `null` when it holds markup. */
export function plainText(doc: XmlDoc, el: XmlEl): string | null {
  if (el.children.length || el.hasMarkupText) return null;
  return decodeXmlText(doc.text.slice(el.innerStart, el.innerEnd));
}

export interface XmlSplice { start: number; end: number; text: string }

/** Applies non-overlapping splices to the source text. */
export function applySplices(text: string, splices: readonly XmlSplice[]): string {
  const sorted = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: string[] = [];
  let at = 0;
  for (const s of sorted) {
    if (s.start < at || s.end < s.start) throw new Error("Overlapping XML edits.");
    out.push(text.slice(at, s.start), s.text);
    at = s.end;
  }
  out.push(text.slice(at));
  return out.join("");
}

const UTF8 = new TextEncoder();

/** Re-encodes an edited UTF-8 part, keeping its byte-order mark. */
export function encodeXmlPart(doc: XmlDoc, text: string): Uint8Array {
  if (!doc.utf8) refuseXml("This part is UTF-16, which Mesa does not edit.");
  const body = UTF8.encode(text);
  if (!doc.utf8Bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}
