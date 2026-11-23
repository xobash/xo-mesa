import { PackagePartMap } from "./partMaps";
import { pdfBytesEqual } from "../pdfBytes";
import { decodeXmlPart, decodeXmlText, forEachStartTag, localName, readAttributes } from "./xmlScan";
import {
  OoxmlPackageError,
  readEntryBytes,
  readZipContainer,
  writeZipContainer,
  type ZipContainer,
  type ZipEntryRecord,
} from "./zipContainer";

// Office Open XML package layer (ECMA-376 Part 2, Open Packaging
// Conventions). Opening validates the whole ZIP structure and keeps the
// original bytes; each part is inflated and CRC-checked when first read
// (`PackagePartMap`). Saving re-encodes only parts whose bytes actually
// changed and copies every other entry's raw record. A save with no
// effective change returns the original byte array.

export type OoxmlKind = "wordprocessing" | "spreadsheet" | "presentation" | "unknown";

export interface OoxmlRelationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
  /** Resolved part name for internal targets, else `null`. */
  readonly targetPart: string | null;
}

export interface OoxmlPackage {
  readonly original: Uint8Array;
  readonly container: ZipContainer;
  /**
   * Bytes of every file entry, keyed by entry name, decoded and CRC-checked on
   * first read (a read can throw `OoxmlPackageError`). Treat as read-only.
   */
  readonly parts: ReadonlyMap<string, Uint8Array>;
  readonly kind: OoxmlKind;
  /** Part named by the package's officeDocument relationship, if any. */
  readonly mainPart: string | null;
  contentTypeOf(partName: string): string | null;
}

/** Replacement bytes, or `null` to remove; unknown names are added. */
export type OoxmlPartChanges = ReadonlyMap<string, Uint8Array | null>;

export const CONTENT_TYPES_PART = "[Content_Types].xml";
const OFFICE_DOCUMENT_REL = /\/officeDocument$/;

interface ContentTypeTable { defaults: Map<string, string>; overrides: Map<string, string> }

function decodePartUri(uri: string): string {
  const bare = uri.startsWith("/") ? uri.slice(1) : uri;
  try { return decodeURIComponent(bare); } catch { return bare; }
}

function parseContentTypes(xml: string): ContentTypeTable {
  const table: ContentTypeTable = { defaults: new Map(), overrides: new Map() };
  forEachStartTag(xml, (tag) => {
    const name = localName(tag.qname);
    if (name !== "Default" && name !== "Override") return;
    const attrs = readAttributes(tag.attributes);
    const type = attrs.get("ContentType");
    if (!type) return;
    if (name === "Default" && attrs.has("Extension")) table.defaults.set(attrs.get("Extension")!.toLowerCase(), type);
    if (name === "Override" && attrs.has("PartName")) table.overrides.set(decodePartUri(decodeXmlText(attrs.get("PartName")!)).toLowerCase(), type);
  });
  return table;
}

/** Content-type lookup for a `[Content_Types].xml` part (overrides, then extension defaults). */
export function contentTypeResolver(contentTypesPart: Uint8Array): (partName: string) => string | null {
  return contentTypeLookup(parseContentTypes(decodeXmlPart(contentTypesPart)));
}

function contentTypeLookup(table: ContentTypeTable): (partName: string) => string | null {
  return (partName) => {
    const key = partName.toLowerCase();
    const override = table.overrides.get(key);
    if (override) return override;
    const dot = key.lastIndexOf(".");
    const slash = key.lastIndexOf("/");
    return dot > slash ? table.defaults.get(key.slice(dot + 1)) ?? null : null;
  };
}

/** `word/document.xml` -> `word/_rels/document.xml.rels`; the package itself is `""`. */
export function relationshipsPartFor(sourcePart: string): string {
  const slash = sourcePart.lastIndexOf("/");
  return `${sourcePart.slice(0, slash + 1)}_rels/${sourcePart.slice(slash + 1)}.rels`;
}

/** Resolves a relative relationship target against its source part; `null` if it climbs out of the package. */
export function resolveRelationshipTarget(sourcePart: string, target: string): string | null {
  const path = decodePartUri(target.split("#")[0]);
  const base = target.startsWith("/") ? [] : sourcePart.split("/").slice(0, -1);
  const out = [...base];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") { if (out.length === 0) return null; out.pop(); continue; }
    out.push(segment);
  }
  return out.length ? out.join("/") : null;
}

export function readRelationships(pkg: Pick<OoxmlPackage, "parts">, sourcePart: string): OoxmlRelationship[] {
  const bytes = pkg.parts.get(relationshipsPartFor(sourcePart));
  if (!bytes) return [];
  const out: OoxmlRelationship[] = [];
  forEachStartTag(decodeXmlPart(bytes), (tag) => {
    if (localName(tag.qname) !== "Relationship") return;
    const attrs = readAttributes(tag.attributes);
    const target = decodeXmlText(attrs.get("Target") ?? "");
    const external = attrs.get("TargetMode") === "External";
    out.push({
      id: attrs.get("Id") ?? "", type: attrs.get("Type") ?? "", target, external,
      targetPart: external ? null : resolveRelationshipTarget(sourcePart, target),
    });
  });
  return out;
}

const KIND_BY_MAIN_TYPE: ReadonlyArray<[RegExp, OoxmlKind]> = [
  [/(wordprocessingml\.(document|template)\.main|ms-word\.(document|template)\.macroEnabled(Template)?\.main)\+xml$/i, "wordprocessing"],
  [/(spreadsheetml\.(sheet|template)\.main|ms-excel\.(sheet|template|addin)\.macroEnabled\.main)\+xml$/i, "spreadsheet"],
  [/(presentationml\.(presentation|slideshow|template)\.main|ms-powerpoint\.(presentation|slideshow|template)\.macroEnabled\.main)\+xml$/i, "presentation"],
];

function kindOf(contentType: string | null): OoxmlKind {
  if (!contentType) return "unknown";
  return KIND_BY_MAIN_TYPE.find(([pattern]) => pattern.test(contentType))?.[1] ?? "unknown";
}

/** Opens a .docx/.xlsx/.pptx (or macro/template variant). Throws `OoxmlPackageError` on refusal. */
export function openOoxmlPackage(bytes: Uint8Array): OoxmlPackage {
  const container = readZipContainer(bytes);
  return assembleOoxmlPackage(container, new PackagePartMap(container));
}

/**
 * Package model from a validated container and its parts (decoded on demand,
 * or decoded by a worker). Throws `OoxmlPackageError` when the package has no
 * content-type table.
 */
export function assembleOoxmlPackage(container: ZipContainer, parts: ReadonlyMap<string, Uint8Array>): OoxmlPackage {
  const bytes = container.bytes;
  const contentTypes = parts.get(CONTENT_TYPES_PART);
  if (!contentTypes) throw new OoxmlPackageError("malformed", "This ZIP file is not an Office document: it has no [Content_Types].xml.");
  const contentTypeOf = contentTypeResolver(contentTypes);
  const main = readRelationships({ parts }, "").find((rel) => !rel.external && OFFICE_DOCUMENT_REL.test(rel.type));
  const mainPart = main?.targetPart && parts.has(main.targetPart) ? main.targetPart : null;
  return { original: bytes, container, parts, kind: kindOf(mainPart ? contentTypeOf(mainPart) : null), mainPart, contentTypeOf };
}

/** Drops replacements whose bytes equal the original entry (re-decoded, so caller mutation cannot hide a change). */
export function effectiveChanges(pkg: Pick<OoxmlPackage, "container">, changes: OoxmlPartChanges): Map<string, Uint8Array | null> {
  const byName = new Map<string, ZipEntryRecord>(pkg.container.entries.map((entry) => [entry.name, entry]));
  const out = new Map<string, Uint8Array | null>();
  for (const [name, content] of changes) {
    const entry = byName.get(name);
    if (entry && content && pdfBytesEqual(readEntryBytes(pkg.container, entry), content)) continue;
    out.set(name, content);
  }
  return out;
}

/** Serializes the package with `changes` applied; unchanged entries are copied byte-for-byte. */
export function saveOoxmlPackage(pkg: Pick<OoxmlPackage, "container">, changes: OoxmlPartChanges): Uint8Array {
  return writeZipContainer(pkg.container, effectiveChanges(pkg, changes));
}
