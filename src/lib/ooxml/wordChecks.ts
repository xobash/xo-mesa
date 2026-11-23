import { readRelationships, type OoxmlPackage } from "./ooxmlPackage";
import { decodeXmlPart, forEachStartTag, localName, namespaceDeclarations, prefixOf, readAttributes, type XmlStartTag } from "./xmlScan";

// WordprocessingML checks Mesa runs on a composed package before writing it:
// reference integrity (problems that the save would introduce) and a census
// of structures whose disappearance the user must confirm. Both scans are
// linear and non-recursive (`forEachStartTag`).

export const WORD_NS: ReadonlySet<string> = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const REL_NS = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
export const MC_NS: ReadonlySet<string> = new Set(["http://schemas.openxmlformats.org/markup-compatibility/2006"]);
const MATH_NS = new Set(["http://schemas.openxmlformats.org/officeDocument/2006/math", "http://purl.oclc.org/ooxml/officeDocument/math"]);

/** Word elements whose `w:val` attribute is required by ECMA-376 Part 1 (a subset an editor commonly writes). */
const VAL_REQUIRED = new Set(["jc", "pStyle", "rStyle", "tblStyle", "numId", "ilvl", "sz", "szCs", "color", "highlight", "outlineLvl"]);
/** Elements whose text must carry `xml:space="preserve"` when it starts or ends with white space. */
const TEXT_ELEMENTS = new Set(["t", "instrText", "delText", "delInstrText"]);

const STORY_TYPE = /(wordprocessingml\.(document|template)\.main|ms-word\.(document|template)\.macroEnabled(Template)?\.main|wordprocessingml\.(header|footer|footnotes|endnotes|comments))\+xml$/i;

/** Parts that hold document text: main part, headers, footers, notes, comments. */
export function wordStoryParts(pkg: OoxmlPackage): string[] {
  return [...pkg.parts.keys()].filter((name) => STORY_TYPE.test(pkg.contentTypeOf(name) ?? ""));
}

export type Scope = Map<string, Set<string>>;

export function bound(scope: Scope, qname: string, uris: ReadonlySet<string>): boolean {
  const declared = scope.get(prefixOf(qname));
  return declared !== undefined && [...declared].some((uri) => uris.has(uri));
}

/** Walks start tags with the part's namespace declarations in scope (collected conservatively, document-wide). */
function scanPart(xml: string, visit: (tag: XmlStartTag, scope: Scope) => void): void {
  const scope: Scope = new Map();
  forEachStartTag(xml, (tag) => {
    namespaceDeclarations(tag.attributes, scope);
    visit(tag, scope);
  });
}

export function wordAttribute(attrs: Map<string, string>, scope: Scope, local: string): string | undefined {
  for (const [name, value] of attrs) if (localName(name) === local && name.includes(":") && bound(scope, name, WORD_NS)) return value;
  return undefined;
}

interface TargetIds {
  styles: Set<string> | null;
  numbering: Set<string> | null;
  footnotes: Set<string> | null;
  endnotes: Set<string> | null;
}

function collectIds(pkg: OoxmlPackage, part: string | null | undefined, element: string, attribute: string): Set<string> | null {
  const bytes = part ? pkg.parts.get(part) : undefined;
  if (!bytes) return null;
  const ids = new Set<string>();
  scanPart(decodeXmlPart(bytes), (tag, scope) => {
    if (localName(tag.qname) !== element || !bound(scope, tag.qname, WORD_NS)) return;
    const value = wordAttribute(readAttributes(tag.attributes), scope, attribute);
    if (value !== undefined) ids.add(value);
  });
  return ids;
}

function targetIds(pkg: OoxmlPackage): TargetIds {
  const rels = pkg.mainPart ? readRelationships(pkg, pkg.mainPart) : [];
  const partFor = (type: string) => rels.find((rel) => !rel.external && rel.type.endsWith(`/${type}`))?.targetPart;
  return {
    styles: collectIds(pkg, partFor("styles"), "style", "styleId"),
    numbering: collectIds(pkg, partFor("numbering"), "num", "numId"),
    footnotes: collectIds(pkg, partFor("footnotes"), "footnote", "id"),
    endnotes: collectIds(pkg, partFor("endnotes"), "endnote", "id"),
  };
}

function textAfter(xml: string, from: number): string {
  const close = xml.indexOf("<", from);
  return xml.slice(from, close < 0 ? xml.length : close);
}

function referenceProblem(local: string, value: string | undefined, ids: TargetIds): string | null {
  if (value === undefined) return null;
  if ((local === "pStyle" || local === "rStyle" || local === "tblStyle") && ids.styles && !ids.styles.has(value)) return `style "${value}" is not defined`;
  if (local === "numId" && value !== "0" && ids.numbering && !ids.numbering.has(value)) return `list ${value} is not defined`;
  return null;
}

function partProblems(pkg: OoxmlPackage, name: string, ids: TargetIds): string[] {
  const bytes = pkg.parts.get(name);
  if (!bytes) return [];
  const problems: string[] = [];
  const relIds = new Set(readRelationships(pkg, name).map((rel) => rel.id));
  const xml = decodeXmlPart(bytes);
  scanPart(xml, (tag, scope) => {
    const attrs = readAttributes(tag.attributes);
    for (const [attr, value] of attrs) {
      if (attr.includes(":") && !attr.startsWith("xmlns") && bound(scope, attr, REL_NS) && !relIds.has(value)) problems.push(`${name}: ${attr}="${value}" points to no relationship`);
    }
    if (!bound(scope, tag.qname, WORD_NS)) return;
    const local = localName(tag.qname);
    const val = wordAttribute(attrs, scope, "val");
    if (VAL_REQUIRED.has(local) && val === undefined) problems.push(`${name}: <${tag.qname}> has no required value`);
    const reference = referenceProblem(local, val, ids);
    if (reference) problems.push(`${name}: ${reference}`);
    if (local === "footnoteReference" && ids.footnotes && !ids.footnotes.has(wordAttribute(attrs, scope, "id") ?? "")) problems.push(`${name}: a footnote reference has no footnote`);
    if (local === "endnoteReference" && ids.endnotes && !ids.endnotes.has(wordAttribute(attrs, scope, "id") ?? "")) problems.push(`${name}: an endnote reference has no endnote`);
    if (TEXT_ELEMENTS.has(local) && !tag.attributes.trimEnd().endsWith("/") && attrs.get("xml:space") !== "preserve" && /^\s|\s$/.test(textAfter(xml, tag.end))) {
      problems.push(`${name}: text with leading or trailing spaces would lose them`);
    }
  });
  return problems;
}

function relationshipProblems(pkg: OoxmlPackage, source: string): string[] {
  return readRelationships(pkg, source)
    .filter((rel) => !rel.external && (rel.targetPart === null || !pkg.parts.has(rel.targetPart)))
    .map((rel) => `${source || "package"}: relationship ${rel.id} points to a missing part`);
}

/** Every integrity problem in `parts` (their XML and their relationships). */
export function wordIntegrityProblems(pkg: OoxmlPackage, parts: Iterable<string>): string[] {
  const ids = targetIds(pkg);
  const problems: string[] = [];
  for (const name of parts) {
    if (!pkg.parts.has(name) || name.toLowerCase().endsWith(".rels")) continue;
    if (pkg.contentTypeOf(name) === null) problems.push(`${name}: no content type`);
    if (/\.xml$/i.test(name)) problems.push(...partProblems(pkg, name, ids));
    problems.push(...relationshipProblems(pkg, name));
  }
  return problems;
}

/** Problems present in `after` that `before` did not already have, for the given parts. */
export function newWordIntegrityProblems(before: OoxmlPackage, after: OoxmlPackage, parts: Iterable<string>): string[] {
  const list = [...parts];
  const known = new Map<string, number>();
  for (const problem of wordIntegrityProblems(before, list)) known.set(problem, (known.get(problem) ?? 0) + 1);
  const fresh: string[] = [];
  for (const problem of wordIntegrityProblems(after, list)) {
    const left = known.get(problem) ?? 0;
    if (left > 0) known.set(problem, left - 1);
    else fresh.push(problem);
  }
  return fresh;
}

const CENSUS_LABELS: Readonly<Record<string, string>> = {
  sdt: "content controls",
  customXml: "custom XML tags",
  smartTag: "smart tags",
  ins: "tracked insertions",
  del: "tracked deletions",
  bookmarkStart: "bookmarks",
  commentReference: "comment anchors",
  footnoteReference: "footnote references",
  endnoteReference: "endnote references",
  fldSimple: "fields",
  fldChar: "fields",
  hyperlink: "links",
  drawing: "pictures and drawings",
  pict: "legacy drawings",
  object: "embedded objects",
  tbl: "tables",
  sectPr: "section breaks",
};

/** Census labels of the inline features a paragraph splice keeps; a splice save may never lower them. */
export const INLINE_FEATURE_CENSUS_LABELS: ReadonlySet<string> = new Set([
  "content controls", "custom XML tags", "smart tags", "tracked insertions", "tracked deletions", "comment anchors", "alternate content",
]);

function censusLabel(tag: XmlStartTag, scope: Scope): string | null {
  const local = localName(tag.qname);
  if (local === "AlternateContent" && bound(scope, tag.qname, MC_NS)) return "alternate content";
  if ((local === "oMath" || local === "oMathPara") && bound(scope, tag.qname, MATH_NS)) return local === "oMath" ? "equations" : null;
  if (!bound(scope, tag.qname, WORD_NS)) return null;
  if (local === "fldChar" && wordAttribute(readAttributes(tag.attributes), scope, "fldCharType") !== "begin") return null;
  return CENSUS_LABELS[local] ?? null;
}

/** Counts of structures in the document's story parts, by plain-language label. */
export function wordCensus(pkg: OoxmlPackage): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of wordStoryParts(pkg)) {
    scanPart(decodeXmlPart(pkg.parts.get(name)!), (tag, scope) => {
      const label = censusLabel(tag, scope);
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    });
  }
  return counts;
}

export interface CensusLoss { readonly label: string; readonly before: number; readonly after: number }

/** Structures that are fewer after the edit, largest loss first. */
export function censusLosses(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): CensusLoss[] {
  const out: CensusLoss[] = [];
  for (const [label, count] of before) {
    const now = after.get(label) ?? 0;
    if (now < count) out.push({ label, before: count, after: now });
  }
  return out.sort((a, b) => (b.before - b.after) - (a.before - a.after) || a.label.localeCompare(b.label));
}
