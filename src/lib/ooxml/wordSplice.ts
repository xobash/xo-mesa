import { CONTENT_TYPES_PART, type OoxmlPackage } from "./ooxmlPackage";
import { spliceStoryPart } from "./wordSplicePart";
import { decodeXmlPart, escapeXmlAttribute, listTopLevel, nextTag, prefixOf, readAttributes } from "./xmlScan";

// Package level of the paragraph splice (docs/office-editing.md, "Paragraph
// splice"): story parts the edit changed are spliced block by block into the
// original part; relationship and content-type parts are merged entry by
// entry (original + what the edit added − what it removed); comment and
// people parts always keep their original bytes. Everything else follows
// the part-level composition rule.

export type WordSplice =
  | { readonly kind: "spliced"; readonly changes: Map<string, Uint8Array | null> }
  | { readonly kind: "refused"; readonly problems: readonly string[] };

const SPLICED_STORY = /wordprocessingml\.(document|template)\.main|ms-word\.(document|template)\.macroEnabled(Template)?\.main|wordprocessingml\.(header|footer|footnotes|endnotes)\+xml$/i;
/** Comment threads, their extensions and the people list: never written by a splice save. */
const KEPT_PARTS = /wordprocessingml\.(comments|people)\+xml$|ms-word\.(comments|people|commentsExtended|commentsIds|commentsExtensible)|word\.(commentsExtended|commentsIds|commentsExtensible|people)/i;

const UTF8 = new TextEncoder();
const UTF8_BOM = [0xef, 0xbb, 0xbf];

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2];
}

function isUtf16(bytes: Uint8Array): boolean {
  return (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
}

function encodeLike(original: Uint8Array, xml: string): Uint8Array {
  const body = UTF8.encode(xml);
  if (!hasUtf8Bom(original)) return body;
  const out = new Uint8Array(body.length + 3);
  out.set(UTF8_BOM);
  out.set(body, 3);
  return out;
}

/** Plain-language name of a story part. */
export function storyPartLabel(pkg: OoxmlPackage, name: string): string {
  const type = pkg.contentTypeOf(name) ?? "";
  if (/\.header\+xml$/i.test(type)) return `the header in ${name}`;
  if (/\.footer\+xml$/i.test(type)) return `the footer in ${name}`;
  if (/\.footnotes\+xml$/i.test(type)) return "the footnotes";
  if (/\.endnotes\+xml$/i.test(type)) return "the endnotes";
  return "the main text";
}

function entryKey(name: string, attrs: ReadonlyMap<string, string>): string | null {
  if (name === "Relationship") return `R:${attrs.get("Id") ?? ""}`;
  if (name === "Default") return `D:${(attrs.get("Extension") ?? "").toLowerCase()}`;
  if (name === "Override") return `O:${(attrs.get("PartName") ?? "").toLowerCase()}`;
  return null;
}

/** Comparable content of an entry, independent of attribute order and quoting. */
function entryValue(attrs: ReadonlyMap<string, string>): string {
  return [...attrs].filter(([k]) => !k.startsWith("xmlns")).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\u0000");
}

interface Entry { readonly start: number; readonly end: number; readonly value: string; readonly attrs: ReadonlyMap<string, string> }

function entries(xml: string): { rootClose: number; byKey: Map<string, Entry>; prefixed: boolean } {
  const top = listTopLevel(xml);
  const byKey = new Map<string, Entry>();
  let prefixed = prefixOf(top.root.qname) !== "";
  for (const child of top.children) {
    if (prefixOf(child.qname) !== "") prefixed = true;
    const tag = nextTag(xml, child.start)!;
    const attrs = readAttributes(xml.slice(tag.attrStart, tag.attrEnd));
    const key = entryKey(child.name, attrs);
    if (key) byKey.set(key, { start: child.start, end: child.end, value: entryValue(attrs), attrs });
  }
  return { rootClose: top.rootClose, byKey, prefixed };
}

function entryXml(name: string, attrs: ReadonlyMap<string, string>): string {
  const text = [...attrs].filter(([k]) => !k.startsWith("xmlns")).map(([k, v]) => ` ${k}="${escapeXmlAttribute(v)}"`).join("");
  return `<${name}${text}/>`;
}

/** Original entries + entries the edit added − entries it removed. Refuses an entry the edit changed in place. */
export function mergeKeyedEntries(o: string, b: string, e: string): { kind: "merged"; xml: string } | { kind: "refused"; problem: string } {
  const [oe, be, ee] = [entries(o), entries(b), entries(e)];
  if (oe.prefixed) return { kind: "refused", problem: "it uses an unusual namespace prefix" };
  const drop: Entry[] = [];
  for (const [key, entry] of be.byKey) {
    const now = ee.byKey.get(key);
    if (now && now.value !== entry.value) return { kind: "refused", problem: `the editor changed the entry ${key.slice(2)}` };
    const mine = oe.byKey.get(key);
    if (!now && mine) drop.push(mine);
  }
  const added: string[] = [];
  for (const [key, entry] of ee.byKey) {
    if (be.byKey.has(key)) continue;
    const mine = oe.byKey.get(key);
    if (mine && mine.value !== entry.value) return { kind: "refused", problem: `the new entry ${key.slice(2)} clashes with one in the file` };
    if (!mine) added.push(entryXml(key[0] === "R" ? "Relationship" : key[0] === "D" ? "Default" : "Override", entry.attrs));
  }
  drop.sort((x, y) => x.start - y.start);
  const out: string[] = [];
  let at = 0;
  for (const entry of drop) { out.push(o.slice(at, entry.start)); at = entry.end; }
  out.push(o.slice(at, oe.rootClose), added.join(""), o.slice(oe.rootClose));
  return { kind: "merged", xml: out.join("") };
}

function isKeyedPart(name: string): boolean {
  return name === CONTENT_TYPES_PART || name.toLowerCase().endsWith(".rels");
}

type PartResult = { bytes: Uint8Array | null } | { problems: readonly string[] };

function splicePart(original: OoxmlPackage, baseline: OoxmlPackage, name: string, edited: Uint8Array): PartResult {
  const o = original.parts.get(name)!;
  const b = baseline.parts.get(name)!;
  if (isUtf16(o)) return { problems: [`${name} is stored as UTF-16, which the paragraph splice does not write`] };
  if (isKeyedPart(name)) {
    const merged = mergeKeyedEntries(decodeXmlPart(o), decodeXmlPart(b), decodeXmlPart(edited));
    return merged.kind === "merged" ? { bytes: encodeLike(o, merged.xml) } : { problems: [`the links in ${name} cannot be merged: ${merged.problem}`] };
  }
  const result = spliceStoryPart(decodeXmlPart(o), decodeXmlPart(b), decodeXmlPart(edited), storyPartLabel(original, name));
  return result.kind === "spliced" ? { bytes: encodeLike(o, result.xml) } : { problems: result.problems };
}

/**
 * Rebuilds `changes` (editor output that differs from its no-edit output)
 * so story parts, relationships and content types are spliced into the
 * original's bytes. Returns the problems when any changed block cannot be
 * written without losing a feature.
 */
export function spliceWordChanges(original: OoxmlPackage, baseline: OoxmlPackage, changes: ReadonlyMap<string, Uint8Array | null>): WordSplice {
  const out = new Map<string, Uint8Array | null>();
  const problems: string[] = [];
  for (const [name, bytes] of changes) {
    const type = original.contentTypeOf(name) ?? "";
    if (original.parts.has(name) && KEPT_PARTS.test(type)) continue;
    const spliceable = bytes !== null && original.parts.has(name) && baseline.parts.has(name) && (isKeyedPart(name) || SPLICED_STORY.test(type));
    if (!spliceable) {
      if (bytes === null && SPLICED_STORY.test(type)) problems.push(`the edit would remove ${storyPartLabel(original, name)}`);
      else out.set(name, bytes);
      continue;
    }
    const result = splicePart(original, baseline, name, bytes);
    if ("problems" in result) problems.push(...result.problems);
    else out.set(name, result.bytes);
  }
  return problems.length ? { kind: "refused", problems } : { kind: "spliced", changes: out };
}
