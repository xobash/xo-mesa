import { decideOoxmlEditPolicy, scanOoxmlCapabilities, type OoxmlEditPolicy, type OoxmlFeature } from "./capabilityGate";
import { openOoxmlPackage, saveOoxmlPackage, type OoxmlPackage } from "./ooxmlPackage";
import { INLINE_FEATURE_CENSUS_LABELS, censusLosses, newWordIntegrityProblems, wordCensus, type CensusLoss } from "./wordChecks";
import { spliceWordChanges } from "./wordSplice";
import { firstAlteredEntry } from "./zipContainer";
import { pdfBytesEqual } from "../pdfBytes";

// Editor composition rule for Word (docs/office-editing.md): the editor
// re-serializes whole parts, so Mesa writes only the parts whose editor
// output differs from the editor's own no-edit output for the same file.
// Every other part keeps its original bytes.

/**
 * Features the Word editor is trusted to keep. Empty: every inline feature
 * (tracked changes, comments, content controls, custom XML markup, alternate
 * content) refuses an in-place save until a real-document corpus proves it.
 */
export const WORD_EDITOR_PRESERVES: ReadonlySet<OoxmlFeature> = new Set<OoxmlFeature>();

/**
 * Inline features a save keeps when it goes through the paragraph splice
 * (`wordSplice.ts`): blocks the edit did not change keep their original
 * bytes, and a change to a block that carries one of these is refused.
 */
export const WORD_SPLICE_PRESERVES: ReadonlySet<OoxmlFeature> = new Set<OoxmlFeature>([
  "trackedChanges", "comments", "customXmlMarkup", "contentControls", "alternateContent",
]);

export interface WordEditPolicy extends OoxmlEditPolicy {
  /** Inline features that make every save go through the paragraph splice; empty for a plain document. */
  readonly splice: readonly OoxmlFeature[];
}

/** Gate decision for overwriting a Word file in place. */
export function wordEditPolicy(pkg: OoxmlPackage): WordEditPolicy {
  const report = scanOoxmlCapabilities(pkg);
  const plain = decideOoxmlEditPolicy(report, "wordprocessing", WORD_EDITOR_PRESERVES);
  const splice = report.features.map((f) => f.feature).filter((f) => WORD_SPLICE_PRESERVES.has(f) && !WORD_EDITOR_PRESERVES.has(f));
  if (!splice.length) return { ...plain, splice };
  return { ...decideOoxmlEditPolicy(report, "wordprocessing", new Set([...WORD_EDITOR_PRESERVES, ...WORD_SPLICE_PRESERVES])), splice };
}

/** Parts the edit really changed: editor output that differs from the editor's no-edit output. */
export function editedPartChanges(baseline: OoxmlPackage, edited: OoxmlPackage): Map<string, Uint8Array | null> {
  const changes = new Map<string, Uint8Array | null>();
  for (const [name, bytes] of edited.parts) {
    const before = baseline.parts.get(name);
    if (!before || !pdfBytesEqual(before, bytes)) changes.set(name, bytes);
  }
  for (const name of baseline.parts.keys()) if (!edited.parts.has(name)) changes.set(name, null);
  return changes;
}

export type WordSavePlan =
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly problems: readonly string[] }
  /** The paragraph splice cannot write this edit without losing a feature; the problems say what and where. */
  | { readonly kind: "blocked"; readonly problems: readonly string[] }
  | {
      readonly kind: "ready";
      readonly bytes: Uint8Array;
      readonly package: OoxmlPackage;
      readonly changedParts: readonly string[];
      readonly losses: readonly CensusLoss[];
    };

function checkedParts(changes: ReadonlyMap<string, Uint8Array | null>): Set<string> {
  const names = new Set<string>();
  for (const name of changes.keys()) {
    const source = name.replace(/(^|\/)_rels\/([^/]*)\.rels$/, "$1$2");
    names.add(name.toLowerCase().endsWith(".rels") ? source : name);
  }
  return names;
}

export interface WordSaveOptions {
  /** `copy` falls back to whole-part composition when the splice refuses; the original is never touched. */
  readonly mode?: "inPlace" | "copy";
}

/**
 * Builds the bytes to write: `original` with only the edited parts replaced
 * (spliced paragraph by paragraph when the file has inline review features),
 * then re-opens the result through the package layer as a check. Throws
 * `OoxmlPackageError` when either editor output cannot be opened.
 */
export function planWordSave(original: OoxmlPackage, baselineBytes: Uint8Array, editedBytes: Uint8Array, options: WordSaveOptions = {}): WordSavePlan {
  const baseline = openOoxmlPackage(baselineBytes);
  const changes = editedPartChanges(baseline, openOoxmlPackage(editedBytes));
  if (wordEditPolicy(original).splice.length) {
    const spliced = spliceWordChanges(original, baseline, changes);
    if (spliced.kind === "spliced") return composeWordSave(original, spliced.changes, true);
    if (options.mode !== "copy") return { kind: "blocked", problems: spliced.problems };
  }
  return composeWordSave(original, changes, false);
}

/** Parts of `original` that lost their content type in `saved`. */
function untypedParts(original: OoxmlPackage, saved: OoxmlPackage): string[] {
  const out: string[] = [];
  for (const name of original.parts.keys()) {
    if (saved.parts.has(name) && original.contentTypeOf(name) !== null && saved.contentTypeOf(name) === null) out.push(`${name}: no content type`);
  }
  return out;
}

function composeWordSave(original: OoxmlPackage, changes: ReadonlyMap<string, Uint8Array | null>, spliced: boolean): WordSavePlan {
  const bytes = saveOoxmlPackage(original, changes);
  if (bytes === original.original) return { kind: "unchanged" };
  const reopened = openOoxmlPackage(bytes);
  const problems: string[] = [];
  if (reopened.kind !== "wordprocessing" || reopened.mainPart !== original.mainPart) problems.push("the saved file would no longer be a Word document");
  const altered = firstAlteredEntry(original.container, reopened.container, (name) => changes.has(name));
  if (altered !== null) problems.push(`${altered} would change although the edit did not touch it`);
  const touched = checkedParts(changes);
  if (original.mainPart) touched.add(original.mainPart);
  problems.push(...newWordIntegrityProblems(original, reopened, touched));
  if (spliced) problems.push(...untypedParts(original, reopened));
  if (problems.length) return { kind: "refused", problems };
  const losses = censusLosses(wordCensus(original), wordCensus(reopened));
  const protectedLosses = spliced ? losses.filter((loss) => INLINE_FEATURE_CENSUS_LABELS.has(loss.label)) : [];
  if (protectedLosses.length) return { kind: "blocked", problems: [`the save would remove ${describeCensusLosses(protectedLosses)}`] };
  return { kind: "ready", bytes, package: reopened, changedParts: [...changes.keys()], losses };
}

/** Plain list of what a save removes, e.g. "bookmarks: 2 → 1; fields: 3 → 2". */
export function describeCensusLosses(losses: readonly CensusLoss[]): string {
  return losses.map((loss) => `${loss.label}: ${loss.before} → ${loss.after}`).join("; ");
}

const FEATURE_WORDS: Readonly<Record<OoxmlFeature | "unknownKind", string>> = {
  trackedChanges: "tracked changes",
  comments: "comments",
  customXmlMarkup: "custom XML tags",
  contentControls: "content controls",
  alternateContent: "alternate content (newer Word features with fallbacks)",
  macros: "macros",
  customXmlParts: "custom XML data",
  charts: "charts",
  smartArt: "SmartArt",
  embeddedObjects: "embedded objects",
  digitalSignatures: "a digital signature",
  externalLinks: "links to other files",
  pivotTables: "pivot tables",
  dataConnections: "data connections",
  unknownKind: "content that is not a Word document body",
};

function listWords(items: readonly string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface WordPolicyNotice {
  /** In-place Save is permitted. */
  readonly canSave: boolean;
  /** Plain-language reason shown beside the editor, or `null` when nothing needs saying. */
  readonly message: string | null;
}

/** What the gate decision means for the user, in one or two sentences. */
export function describeWordPolicy(policy: WordEditPolicy): WordPolicyNotice {
  const words = (decision: OoxmlEditPolicy["decision"]) =>
    [...new Set(policy.reasons.filter((r) => r.decision === decision).map((r) => FEATURE_WORDS[r.feature]))];
  const refused = words("refuseSave");
  if (refused.length) {
    const signed = policy.reasons.some((r) => r.feature === "digitalSignatures");
    return {
      canSave: false,
      message: `Save is off for this file because it has ${listWords(refused)}, which Mesa cannot keep exactly${signed ? " (any change invalidates a signature)" : ""}. You can still edit and use Save as copy; the original stays unchanged${signed ? " and the copy's signature will show as invalid" : ""}.`,
    };
  }
  const notes: string[] = [];
  if (policy.splice.length) {
    notes.push(`This file has ${listWords([...new Set(policy.splice.map((f) => FEATURE_WORDS[f]))])}. Mesa saves edits only in paragraphs without them; paragraphs you do not change keep them exactly. If an edit touches one, Save names the paragraph and Save as copy still works.`);
  }
  const warned = words("allowWithWarning");
  if (warned.length) notes.push(`This file has ${listWords(warned)}. Mesa copies them unchanged and never runs anything, but deleting the text that uses them can leave unused parts behind.`);
  return { canSave: true, message: notes.length ? notes.join(" ") : null };
}
