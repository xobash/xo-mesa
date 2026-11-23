import { readRelationships, type OoxmlKind, type OoxmlPackage } from "./ooxmlPackage";
import { decodeXmlPart, forEachStartTag, localName, namespaceDeclarations, prefixOf } from "./xmlScan";

// Capability gate: reports which features a package carries so an editor can
// decide to edit, edit with a warning, or refuse to save. Detection is
// conservative: a feature may be over-reported, never silently missed for the
// markers listed here.

export const OOXML_FEATURES = [
  "macros", "trackedChanges", "comments", "customXmlParts", "customXmlMarkup", "contentControls",
  "charts", "smartArt", "embeddedObjects", "alternateContent", "digitalSignatures", "externalLinks",
  "pivotTables", "dataConnections",
] as const;
export type OoxmlFeature = (typeof OOXML_FEATURES)[number];

/**
 * - `inline`: lives inside content an editor rewrites; an editor that does not
 *   model it would drop or corrupt it, so saving is refused.
 * - `part`: lives in separate parts the package layer copies byte-for-byte;
 *   saving is allowed with a warning (references can still be orphaned).
 * - `blocking`: any content change invalidates it; saving is always refused.
 */
export type OoxmlFeatureClass = "inline" | "part" | "blocking";

export const OOXML_FEATURE_CLASS: Readonly<Record<OoxmlFeature, OoxmlFeatureClass>> = {
  macros: "part",
  trackedChanges: "inline",
  comments: "inline",
  customXmlParts: "part",
  customXmlMarkup: "inline",
  contentControls: "inline",
  charts: "part",
  smartArt: "part",
  embeddedObjects: "part",
  alternateContent: "inline",
  digitalSignatures: "blocking",
  externalLinks: "part",
  pivotTables: "part",
  dataConnections: "part",
};

export interface OoxmlFeatureFinding {
  readonly feature: OoxmlFeature;
  /** Up to `MAX_EVIDENCE` part names (or part#element) that carry it. */
  readonly evidence: readonly string[];
  readonly count: number;
}

export interface OoxmlCapabilityReport {
  readonly kind: OoxmlKind;
  readonly mainPart: string | null;
  readonly partCount: number;
  readonly features: readonly OoxmlFeatureFinding[];
}

const MAX_EVIDENCE = 8;

const NS = {
  wordStrict: "http://purl.oclc.org/ooxml/wordprocessingml/main",
  word: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  markupCompatibility: "http://schemas.openxmlformats.org/markup-compatibility/2006",
} as const;

const WORD_NAMESPACES = new Set<string>([NS.word, NS.wordStrict]);

/** WordprocessingML revision elements (ECMA-376 Part 1 section 17.13.5). */
export const REVISION_ELEMENTS: ReadonlySet<string> = new Set([
  "ins", "del", "moveFrom", "moveTo", "moveFromRangeStart", "moveToRangeStart", "rPrChange", "pPrChange",
  "sectPrChange", "tblPrChange", "tblPrExChange", "trPrChange", "tcPrChange", "tblGridChange", "numberingChange",
  "cellIns", "cellDel", "cellMerge",
]);

export const COMMENT_ELEMENTS: ReadonlySet<string> = new Set(["commentRangeStart", "commentRangeEnd", "commentReference"]);

type Recorder = (feature: OoxmlFeature, evidence: string) => void;

function contentTypeFeature(contentType: string): OoxmlFeature | null {
  const type = contentType.toLowerCase();
  if (type.includes("vbaproject") || type.includes("macroenabled")) return "macros";
  if (type.includes("comments") || type.includes("commentauthors")) return "comments";
  if (type.includes("revisionheaders") || type.includes("revisionlog")) return "trackedChanges";
  if (type.includes("customxmlproperties")) return "customXmlParts";
  if (type.includes("drawingml.chart") || type.includes("chartex") || type.includes("chartstyle")) return "charts";
  if (type.includes("drawingml.diagram")) return "smartArt";
  if (type.includes("oleobject") || type.includes("activex")) return "embeddedObjects";
  if (type.includes("digital-signature")) return "digitalSignatures";
  if (type.includes("externallink")) return "externalLinks";
  if (type.includes("pivottable") || type.includes("pivotcache")) return "pivotTables";
  if (type.includes("spreadsheetml.connections") || type.includes("querytable")) return "dataConnections";
  return null;
}

function partNameFeatures(name: string, record: Recorder): void {
  const lower = name.toLowerCase();
  if (lower.endsWith("vbaproject.bin")) record("macros", name);
  if (lower.startsWith("customxml/")) record("customXmlParts", name);
  if (lower.includes("/embeddings/")) record("embeddedObjects", name);
  if (lower.startsWith("_xmlsignatures/")) record("digitalSignatures", name);
}

function relationshipFeatures(pkg: OoxmlPackage, relsPart: string, record: Recorder): void {
  const source = relsPart.replace(/(^|\/)_rels\/([^/]*)\.rels$/, "$1$2");
  for (const rel of readRelationships(pkg, source)) {
    const type = rel.type.toLowerCase();
    if (type.endsWith("/oleobject") || type.endsWith("/package")) record("embeddedObjects", relsPart);
    if (type.includes("digital-signature")) record("digitalSignatures", relsPart);
    if (type.endsWith("/vbaproject")) record("macros", relsPart);
    if (rel.external && !type.endsWith("/hyperlink")) record("externalLinks", `${relsPart}#${rel.id}`);
  }
}

function isXmlPart(name: string, contentType: string | null): boolean {
  return /\.(xml|rels)$/i.test(name) || (contentType !== null && /[+/]xml$/i.test(contentType));
}

/**
 * A namespace must be declared in the part that uses it, so a part that never
 * spells a Word or markup-compatibility URI and holds no `<!` declaration
 * cannot carry a markup feature or a DTD. Skipping the tag walk for such a
 * part keeps the scan of a large worksheet to a few substring searches.
 */
function mayCarryMarkupFeatures(xml: string): boolean {
  return xml.includes(NS.markupCompatibility) || xml.includes(NS.word) || xml.includes(NS.wordStrict) || /<!(?!--|\[CDATA\[)/.test(xml);
}

function markupFeatures(name: string, xml: string, record: Recorder): void {
  if (!mayCarryMarkupFeatures(xml)) return;
  const namespaces = new Map<string, Set<string>>();
  const inNamespace = (qname: string, uris: ReadonlySet<string>): boolean => {
    const declared = namespaces.get(prefixOf(qname));
    return declared !== undefined && [...declared].some((uri) => uris.has(uri));
  };
  const markupCompatibility = new Set<string>([NS.markupCompatibility]);
  forEachStartTag(xml, (tag) => {
    namespaceDeclarations(tag.attributes, namespaces);
    const local = localName(tag.qname);
    if (local === "AlternateContent" && inNamespace(tag.qname, markupCompatibility)) record("alternateContent", name);
    if (!inNamespace(tag.qname, WORD_NAMESPACES)) return;
    if (REVISION_ELEMENTS.has(local)) record("trackedChanges", `${name}#${local}`);
    else if (COMMENT_ELEMENTS.has(local)) record("comments", `${name}#${local}`);
    else if (local === "customXml" || local === "smartTag") record("customXmlMarkup", `${name}#${local}`);
    else if (local === "sdt") record("contentControls", `${name}#${local}`);
  });
}

/** Scans every part of an opened package. Throws `OoxmlPackageError` on a refused XML part (e.g. a DTD). */
export function scanOoxmlCapabilities(pkg: OoxmlPackage): OoxmlCapabilityReport {
  const found = new Map<OoxmlFeature, { evidence: string[]; count: number }>();
  const record: Recorder = (feature, evidence) => {
    const entry = found.get(feature) ?? { evidence: [], count: 0 };
    entry.count++;
    if (entry.evidence.length < MAX_EVIDENCE && !entry.evidence.includes(evidence)) entry.evidence.push(evidence);
    found.set(feature, entry);
  };
  // Only XML parts are read; pictures and other binary parts stay undecoded.
  for (const name of pkg.parts.keys()) {
    const contentType = pkg.contentTypeOf(name);
    const byType = contentType ? contentTypeFeature(contentType) : null;
    if (byType) record(byType, name);
    partNameFeatures(name, record);
    if (name.toLowerCase().endsWith(".rels")) relationshipFeatures(pkg, name, record);
    else if (isXmlPart(name, contentType)) markupFeatures(name, decodeXmlPart(pkg.parts.get(name)!), record);
  }
  const features = OOXML_FEATURES.filter((f) => found.has(f)).map((feature) => ({ feature, ...found.get(feature)! }));
  return { kind: pkg.kind, mainPart: pkg.mainPart, partCount: pkg.parts.size, features };
}

export type OoxmlEditDecision = "allow" | "allowWithWarning" | "refuseSave";

export interface OoxmlEditPolicy {
  readonly decision: OoxmlEditDecision;
  readonly reasons: ReadonlyArray<{ feature: OoxmlFeature | "unknownKind"; decision: OoxmlEditDecision }>;
}

const RANK: Record<OoxmlEditDecision, number> = { allow: 0, allowWithWarning: 1, refuseSave: 2 };

/**
 * Combines a report with what an editor can round-trip. `preserves` lists the
 * features the editor models faithfully; a blocking feature refuses saving
 * regardless.
 */
export function decideOoxmlEditPolicy(
  report: OoxmlCapabilityReport,
  editorKind: OoxmlKind,
  preserves: ReadonlySet<OoxmlFeature>,
): OoxmlEditPolicy {
  const reasons: Array<{ feature: OoxmlFeature | "unknownKind"; decision: OoxmlEditDecision }> = [];
  if (report.kind === "unknown" || report.kind !== editorKind) reasons.push({ feature: "unknownKind", decision: "refuseSave" });
  for (const { feature } of report.features) {
    const featureClass = OOXML_FEATURE_CLASS[feature];
    if (featureClass === "blocking") reasons.push({ feature, decision: "refuseSave" });
    else if (!preserves.has(feature)) reasons.push({ feature, decision: featureClass === "inline" ? "refuseSave" : "allowWithWarning" });
  }
  const decision = reasons.reduce<OoxmlEditDecision>((worst, r) => (RANK[r.decision] > RANK[worst] ? r.decision : worst), "allow");
  return { decision, reasons };
}
