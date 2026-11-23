import {
  decideOoxmlEditPolicy, scanOoxmlCapabilities, type OoxmlCapabilityReport, type OoxmlFeature,
} from "../ooxml/capabilityGate";
import {
  effectiveChanges, openOoxmlPackage, saveOoxmlPackage, type OoxmlPackage, type OoxmlPartChanges,
} from "../ooxml/ooxmlPackage";
import { firstAlteredEntry, OoxmlPackageError } from "../ooxml/zipContainer";
import { loadDeck, relsOf, type Deck, type PartView } from "./pptxDeck";
import { pdfBytesEqual } from "../pdfBytes";

// Open, gate and save a presentation. A save serializes only changed parts,
// then re-opens the candidate bytes through the package layer and checks
// every part before anything is written.

/**
 * Features the patch editor keeps intact. Edits splice text inside one part
 * and never re-serialize a whole part, so alternate content elsewhere in a
 * part stays byte-for-byte; presentation comments are separate parts
 * anchored by position, not by text.
 */
const PRESERVES = new Set<OoxmlFeature>(["alternateContent", "comments"]);

const FEATURE_TEXT: Record<OoxmlFeature | "unknownKind", string> = {
  macros: "It contains macros. Mesa keeps them unchanged but does not edit macro-enabled presentations.",
  trackedChanges: "It contains tracked changes.",
  comments: "It contains comments.",
  customXmlParts: "It contains custom XML data, which Mesa copies unchanged.",
  customXmlMarkup: "It contains custom XML markup.",
  contentControls: "It contains content controls.",
  charts: "It contains charts. Mesa shows them as labelled boxes and copies them unchanged.",
  smartArt: "It contains SmartArt. Mesa shows it as a labelled box and copies it unchanged.",
  embeddedObjects: "It contains embedded objects, which Mesa copies unchanged.",
  alternateContent: "It contains alternate content.",
  digitalSignatures: "It is digitally signed. Any change would break the signature.",
  externalLinks: "It links to files outside the presentation. Mesa never opens them.",
  pivotTables: "It contains pivot tables, which Mesa copies unchanged.",
  dataConnections: "It contains data connections. Mesa never refreshes them.",
  unknownKind: "It is not a PowerPoint presentation.",
};

export interface PresentationPolicy {
  readonly canEdit: boolean;
  /** Shown while editing; editing is still allowed. */
  readonly warnings: readonly string[];
  /** Why editing is off. */
  readonly refusals: readonly string[];
}

/** Gate decision for the presentation editor. Macro-enabled files stay read-only. */
export function presentationEditPolicy(report: OoxmlCapabilityReport, ext: string): PresentationPolicy {
  const policy = decideOoxmlEditPolicy(report, "presentation", PRESERVES);
  const macroFile = ext.toLowerCase() === "pptm" || report.features.some((f) => f.feature === "macros");
  const refusals = policy.reasons.filter((r) => r.decision === "refuseSave").map((r) => FEATURE_TEXT[r.feature]);
  if (macroFile && !refusals.includes(FEATURE_TEXT.macros)) refusals.push(FEATURE_TEXT.macros);
  const warnings = policy.reasons.filter((r) => r.decision === "allowWithWarning" && r.feature !== "macros").map((r) => FEATURE_TEXT[r.feature]);
  return { canEdit: refusals.length === 0, warnings, refusals };
}

export interface OpenedPresentation {
  readonly pkg: OoxmlPackage;
  readonly deck: Deck;
  readonly report: OoxmlCapabilityReport;
  readonly policy: PresentationPolicy;
}

/** Opens and checks a presentation. Throws `OoxmlPackageError` with a user-facing message. */
export function openPresentation(bytes: Uint8Array, ext: string): OpenedPresentation {
  const pkg = openOoxmlPackage(bytes);
  if (pkg.kind !== "presentation" || !pkg.mainPart) throw new OoxmlPackageError("malformed", "This file is not a PowerPoint presentation.");
  const deck = loadDeck(pkg, pkg.mainPart);
  const report = scanOoxmlCapabilities(pkg);
  return { pkg, deck, report, policy: presentationEditPolicy(report, ext) };
}

/** Internal relationships whose target part does not exist, as `relsPart#Id`. */
export function danglingRelationships(view: PartView): Set<string> {
  const out = new Set<string>();
  for (const name of view.parts.keys()) {
    const match = /^(.*?)_rels\/([^/]+)\.rels$/i.exec(name);
    if (!match) continue;
    for (const rel of relsOf(view, `${match[1]}${match[2]}`)) {
      if (!rel.external && rel.targetPart !== null && !view.parts.has(rel.targetPart)) out.add(`${name}#${rel.id}`);
    }
  }
  return out;
}

/** Parts other than relationships and content types that have no content type. */
export function untypedParts(view: PartView): Set<string> {
  const out = new Set<string>();
  for (const name of view.parts.keys()) {
    if (name === "[Content_Types].xml" || /\.rels$/i.test(name)) continue;
    if (!view.contentTypeOf(name)) out.add(name);
  }
  return out;
}

function newEntries(after: ReadonlySet<string>, before: ReadonlySet<string>): string[] {
  return [...after].filter((x) => !before.has(x));
}

function verifyCandidate(pkg: OoxmlPackage, changes: ReadonlyMap<string, Uint8Array | null>, bytes: Uint8Array): void {
  const fail = (why: string): never => { throw new OoxmlPackageError("malformed", `Mesa stopped the save: ${why}`); };
  const saved = openOoxmlPackage(bytes);
  if (saved.kind !== "presentation" || saved.mainPart !== pkg.mainPart) fail("the saved file is not the same kind of presentation.");
  loadDeck(saved, saved.mainPart!);
  const altered = firstAlteredEntry(pkg.container, saved.container, (name) => changes.has(name));
  if (altered !== null) fail(`${altered} would change.`);
  for (const [name, content] of changes) {
    const now = saved.parts.get(name);
    if (content === null ? now !== undefined : !now || !pdfBytesEqual(now, content)) fail(`${name} did not save as edited.`);
  }
  const dangling = newEntries(danglingRelationships(saved), danglingRelationships(pkg));
  if (dangling.length) fail(`a relationship would point at a missing part (${dangling[0]}).`);
  const untyped = newEntries(untypedParts(saved), untypedParts(pkg));
  if (untyped.length) fail(`${untyped[0]} would have no content type.`);
}

/**
 * Bytes to write for `changes`, or `null` when nothing effectively changed
 * (the caller then writes nothing). Throws if the candidate fails checks.
 */
export function buildPresentationSave(pkg: OoxmlPackage, changes: OoxmlPartChanges): Uint8Array | null {
  const effective = effectiveChanges(pkg, changes);
  if (effective.size === 0) return null;
  const bytes = saveOoxmlPackage(pkg, effective);
  if (bytes === pkg.original) return null;
  verifyCandidate(pkg, effective, bytes);
  return bytes;
}
