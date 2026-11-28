import { pdfBytesEqual } from "../pdfBytes";
import { decodeXmlPart, decodeXmlText, forEachStartTag, localName, readAttributes } from "../ooxml/xmlScan";
import { xmlWellFormedProblem } from "../ooxml/xmlWellFormed";
import { OoxmlPackageError, readEntryBytes, readZipContainer, writeZipContainer, type ZipContainer } from "../ooxml/zipContainer";
import { parseXmlTree, type XmlDoc } from "../pptx/xmlTree";

// OpenDocument package layer (ODF 1.3 Part 2, packages). The ZIP container
// is the bounded OOXML reader and lossless writer: unchanged entries keep
// their exact local records and order, so `mimetype` stays first and stored.
// Mesa edits only `content.xml`; styles, meta, settings and the manifest are
// never rewritten. Every save is re-opened and checked before it is written.

export type OdfKind = "text" | "spreadsheet" | "presentation";

const MIMETYPES: Readonly<Record<string, readonly [OdfKind, boolean]>> = {
  "application/vnd.oasis.opendocument.text": ["text", false],
  "application/vnd.oasis.opendocument.text-template": ["text", true],
  "application/vnd.oasis.opendocument.spreadsheet": ["spreadsheet", false],
  "application/vnd.oasis.opendocument.spreadsheet-template": ["spreadsheet", true],
  "application/vnd.oasis.opendocument.presentation": ["presentation", false],
  "application/vnd.oasis.opendocument.presentation-template": ["presentation", true],
};

export const CONTENT_PART = "content.xml";
export const STYLES_PART = "styles.xml";
const MANIFEST_PART = "META-INF/manifest.xml";
const MIMETYPE_PART = "mimetype";

export interface OdfPolicy {
  readonly canEdit: boolean;
  /** Confirmed before a save; editing is still allowed. */
  readonly warnings: readonly string[];
  /** Why editing is off. */
  readonly refusals: readonly string[];
  /** The content has tracked changes; edits that touch a changed region refuse. */
  readonly trackedChanges: boolean;
}

export interface OdfPackage {
  readonly original: Uint8Array;
  readonly container: ZipContainer;
  readonly parts: ReadonlyMap<string, Uint8Array>;
  readonly kind: OdfKind;
  readonly template: boolean;
  readonly content: XmlDoc;
  /** `styles.xml`, when present and readable. */
  readonly styles: XmlDoc | null;
  readonly policy: OdfPolicy;
}

function fail(message: string): never {
  throw new OoxmlPackageError("malformed", message);
}

interface Manifest { readonly listed: ReadonlySet<string>; readonly encrypted: ReadonlySet<string> }

function attrByLocal(attrs: ReadonlyMap<string, string>, local: string): string | undefined {
  for (const [name, value] of attrs) if (localName(name) === local) return value;
  return undefined;
}

function readManifest(bytes: Uint8Array | undefined): Manifest | null {
  if (!bytes) return null;
  const listed = new Set<string>();
  const encrypted = new Set<string>();
  let current: string | null = null;
  forEachStartTag(decodeXmlPart(bytes), (tag) => {
    const local = localName(tag.qname);
    if (local === "file-entry") {
      const path = attrByLocal(readAttributes(tag.attributes), "full-path");
      current = path === undefined ? null : decodeXmlText(path);
      if (current !== null) listed.add(current);
    } else if (local === "encryption-data" && current !== null) encrypted.add(current);
  });
  return { listed, encrypted };
}

/** Problems with the package layout that make any save unsafe. */
function layoutProblems(container: ZipContainer, manifest: Manifest | null): string[] {
  const out: string[] = [];
  const first = [...container.entries].sort((a, b) => a.localStart - b.localStart)[0];
  if (!first || first.name !== MIMETYPE_PART || first.method !== 0) out.push("its mimetype entry is not first and uncompressed, as OpenDocument requires.");
  if (!manifest) { out.push("it has no manifest."); return out; }
  const unlisted = container.entries.find((e) => !e.isDirectory && e.name !== MIMETYPE_PART && !e.name.startsWith("META-INF/") && !manifest.listed.has(e.name));
  if (unlisted) out.push(`its manifest does not list ${unlisted.name}.`);
  return out;
}

function hasEntryUnder(parts: ReadonlyMap<string, Uint8Array>, prefix: string): boolean {
  for (const name of parts.keys()) if (name.startsWith(prefix)) return true;
  return false;
}

function hasTrackedChanges(content: XmlDoc): boolean {
  return /<[\w.-]+:tracked-changes[\s>]/.test(content.text) && /<[\w.-]+:changed-region[\s>]/.test(content.text);
}

function decidePolicy(kind: OdfKind, template: boolean, parts: ReadonlyMap<string, Uint8Array>, manifest: Manifest | null, container: ZipContainer, content: XmlDoc): OdfPolicy {
  const refusals: string[] = [];
  const warnings: string[] = [];
  if (template) refusals.push("It is a template. Mesa opens templates read-only; create a document from it in LibreOffice to edit.");
  if ([...parts.keys()].some((name) => /^META-INF\/[^/]*signatures[^/]*\.xml$/i.test(name))) refusals.push("It is digitally signed. Any change would break the signature.");
  if (manifest && manifest.encrypted.size) refusals.push("Parts of it are encrypted with a password. Mesa does not decrypt OpenDocument files.");
  for (const problem of layoutProblems(container, manifest)) refusals.push(`Mesa cannot save it safely: ${problem}`);
  if (!content.utf8) refusals.push("Its content is UTF-16, which Mesa does not edit.");
  const tracked = hasTrackedChanges(content);
  if (tracked && kind === "spreadsheet") refusals.push("It records tracked changes. Mesa does not edit spreadsheets with tracked changes.");
  if (hasEntryUnder(parts, "Basic/") || hasEntryUnder(parts, "Scripts/")) warnings.push("It contains macros. Mesa keeps them unchanged and never runs them.");
  return { canEdit: refusals.length === 0, warnings, refusals, trackedChanges: tracked };
}

function decodeEntries(container: ZipContainer): Map<string, Uint8Array> {
  const parts = new Map<string, Uint8Array>();
  for (const entry of container.entries) if (!entry.isDirectory) parts.set(entry.name, readEntryBytes(container, entry));
  return parts;
}

/**
 * Opens an .odt/.ods/.odp (or template). Throws `OoxmlPackageError` with a
 * user-facing message when the file is not an OpenDocument package or its
 * content cannot be read.
 */
export function openOdfPackage(bytes: Uint8Array): OdfPackage {
  const container = readZipContainer(bytes);
  const parts = decodeEntries(container);
  const mime = parts.get(MIMETYPE_PART);
  const known = mime ? MIMETYPES[new TextDecoder().decode(mime).trim()] : undefined;
  if (!known) fail("This file is not an OpenDocument text, spreadsheet or presentation.");
  const manifest = readManifest(parts.get(MANIFEST_PART));
  if (manifest?.encrypted.has(CONTENT_PART)) throw new OoxmlPackageError("encrypted", "This document is password-protected. Mesa does not decrypt OpenDocument files.");
  const contentBytes = parts.get(CONTENT_PART);
  if (!contentBytes) fail("This OpenDocument file has no content.xml.");
  const content = parseXmlTree(contentBytes);
  const stylesBytes = parts.get(STYLES_PART);
  const styles = stylesBytes && !manifest?.encrypted.has(STYLES_PART) ? parseXmlTree(stylesBytes) : null;
  const [kind, template] = known;
  return { original: bytes, container, parts, kind, template, content, styles, policy: decidePolicy(kind, template, parts, manifest, container, content) };
}

const UTF8 = new TextEncoder();

/** Re-encodes edited content text, keeping a UTF-8 byte-order mark. */
export function encodeContent(pkg: OdfPackage, text: string): Uint8Array {
  if (!pkg.content.utf8) fail("This content is UTF-16, which Mesa does not edit.");
  const body = UTF8.encode(text);
  if (!pkg.content.utf8Bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

/** Checks a candidate package; throws with the first problem. */
export function verifyOdfSave(pkg: OdfPackage, bytes: Uint8Array, changed: ReadonlyMap<string, Uint8Array>): OdfPackage {
  const stop = (why: string): never => fail(`Mesa stopped the save: ${why}`);
  let saved: OdfPackage;
  try { saved = openOdfPackage(bytes); } catch (error) { return stop(`the saved file does not re-open (${error instanceof Error ? error.message : String(error)}).`); }
  if (saved.kind !== pkg.kind || saved.template !== pkg.template) stop("the saved file is not the same kind of document.");
  const problem = layoutProblems(saved.container, readManifest(saved.parts.get(MANIFEST_PART)))[0];
  if (problem) stop(`the saved file would be invalid: ${problem}`);
  if (saved.parts.size !== pkg.parts.size) stop("the saved file would gain or lose entries.");
  for (const [name, original] of pkg.parts) {
    const now = saved.parts.get(name);
    const want = changed.get(name) ?? original;
    if (!now || !pdfBytesEqual(now, want)) stop(`${name} would ${changed.has(name) ? "not save as edited" : "change"}.`);
  }
  for (const name of changed.keys()) {
    const issue = xmlWellFormedProblem(decodeXmlPart(saved.parts.get(name)!));
    if (issue) stop(`${name} would not be well-formed XML (${issue}).`);
  }
  return saved;
}

/** The package each save candidate re-opened as, by the candidate's byte array. */
const checkedSaves = new WeakMap<Uint8Array, OdfPackage>();

/**
 * Opens bytes that `buildOdfSave` returned. The save check already opened and
 * read back exactly this byte array, so that package is handed over instead
 * of inflating and parsing the file a second time. Any other array is opened
 * as usual.
 */
export function openSavedOdfPackage(bytes: Uint8Array): OdfPackage {
  const checked = checkedSaves.get(bytes);
  return checked && checked.original === bytes ? checked : openOdfPackage(bytes);
}

/**
 * Bytes to write for new `content.xml` text, or `null` when nothing changed.
 * `check` runs on the re-opened candidate (kind-specific read-back).
 */
export function buildOdfSave(pkg: OdfPackage, contentText: string, check?: (saved: OdfPackage) => void): Uint8Array | null {
  if (!pkg.policy.canEdit) fail(`Mesa does not save this file. ${pkg.policy.refusals.join(" ")}`);
  const content = encodeContent(pkg, contentText);
  if (pdfBytesEqual(content, pkg.parts.get(CONTENT_PART)!)) return null;
  const changed = new Map([[CONTENT_PART, content]]);
  const bytes = writeZipContainer(pkg.container, changed);
  const saved = verifyOdfSave(pkg, bytes, changed);
  check?.(saved);
  checkedSaves.set(bytes, saved);
  return bytes;
}
