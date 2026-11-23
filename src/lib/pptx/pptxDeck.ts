import {
  CONTENT_TYPES_PART, contentTypeResolver, readRelationships, relationshipsPartFor, type OoxmlPartChanges, type OoxmlRelationship,
} from "../ooxml/ooxmlPackage";
import { OverlayPartMap } from "../ooxml/partMaps";
import { OoxmlPackageError } from "../ooxml/zipContainer";
import { child, childrenNamed, descendants, intAttr, nsAttr, parseXmlTree, type XmlDoc } from "./xmlTree";

// Presentation structure over an OOXML package, optionally overlaid with
// unsaved part changes. Nothing here writes; edits live in `pptxEdit.ts`.

export const NS = {
  p: new Set(["http://schemas.openxmlformats.org/presentationml/2006/main", "http://purl.oclc.org/ooxml/presentationml/main"]),
  a: new Set(["http://schemas.openxmlformats.org/drawingml/2006/main", "http://purl.oclc.org/ooxml/drawingml/main"]),
  r: new Set(["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"]),
} as const;

/** Parts plus content types: the original package or a draft overlay. */
export interface PartView {
  readonly parts: ReadonlyMap<string, Uint8Array>;
  contentTypeOf(partName: string): string | null;
}

/** The package with `changes` applied (`null` removes a part). Unchanged parts are read from `base` on demand. */
export function overlayView(base: PartView, changes: OoxmlPartChanges): PartView {
  if (changes.size === 0) return base;
  const parts = new OverlayPartMap(base.parts, changes);
  const types = parts.get(CONTENT_TYPES_PART);
  return { parts, contentTypeOf: types ? contentTypeResolver(types) : () => null };
}

const treeCache = new WeakMap<Uint8Array, XmlDoc>();

/** Parsed XML for a part, cached per byte buffer (parts are never mutated in place). */
export function xmlOf(view: PartView, part: string): XmlDoc | null {
  const bytes = view.parts.get(part);
  if (!bytes) return null;
  let doc = treeCache.get(bytes);
  if (!doc) {
    doc = parseXmlTree(bytes);
    treeCache.set(bytes, doc);
  }
  return doc;
}

const relsCache = new WeakMap<Uint8Array, Map<string, readonly OoxmlRelationship[]>>();

/**
 * Relationships of a part, cached per relationships-part buffer (parts are
 * never mutated in place), so a deck lookup per slide stays linear.
 */
export function relsOf(view: PartView, part: string): readonly OoxmlRelationship[] {
  const bytes = view.parts.get(relationshipsPartFor(part));
  if (!bytes) return [];
  let bySource = relsCache.get(bytes);
  if (!bySource) {
    bySource = new Map();
    relsCache.set(bytes, bySource);
  }
  let rels = bySource.get(part);
  if (!rels) {
    rels = readRelationships(view, part);
    bySource.set(part, rels);
  }
  return rels;
}

export function relType(rel: OoxmlRelationship): string {
  return rel.type.slice(rel.type.lastIndexOf("/") + 1);
}

/** Internal relationship target of one type that exists in the package. */
export function relTarget(view: PartView, part: string, type: string): string | null {
  const rel = relsOf(view, part).find((r) => !r.external && relType(r) === type && r.targetPart && view.parts.has(r.targetPart));
  return rel?.targetPart ?? null;
}

export function relById(view: PartView, part: string, id: string): OoxmlRelationship | null {
  return relsOf(view, part).find((r) => r.id === id) ?? null;
}

export interface DeckSlide {
  readonly sldId: number;
  readonly rId: string;
  readonly part: string;
  readonly hidden: boolean;
  readonly layoutPart: string | null;
  readonly masterPart: string | null;
  readonly themePart: string | null;
  readonly notesPart: string | null;
}

export interface Deck {
  readonly presentationPart: string;
  /** Slide size in EMU. */
  readonly width: number;
  readonly height: number;
  readonly slides: readonly DeckSlide[];
  /** The deck has PowerPoint sections (listed by slide id in an extension). */
  readonly hasSections: boolean;
  /** Slide entries Mesa skipped because their part is missing. */
  readonly missingSlides: number;
}

const DEFAULT_WIDTH = 9_144_000;
const DEFAULT_HEIGHT = 6_858_000;
const MAX_EMU = 51_206_400; // ECMA-376 ST_SlideSizeCoordinate maximum

function deckFailure(message: string): never {
  throw new OoxmlPackageError("malformed", message);
}

function slideEntry(view: PartView, presentationPart: string, sldId: number, rId: string): DeckSlide | null {
  const rel = relById(view, presentationPart, rId);
  const part = rel && !rel.external ? rel.targetPart : null;
  if (!part || !view.parts.has(part)) return null;
  const doc = xmlOf(view, part);
  const layoutPart = relTarget(view, part, "slideLayout");
  const masterPart = layoutPart ? relTarget(view, layoutPart, "slideMaster") : null;
  return {
    sldId, rId, part,
    hidden: doc?.root.attrs.get("show") === "0" || doc?.root.attrs.get("show") === "false",
    layoutPart, masterPart,
    themePart: masterPart ? relTarget(view, masterPart, "theme") : null,
    notesPart: relTarget(view, part, "notesSlide"),
  };
}

/** Reads slide order, size and per-slide parts. Throws when the main part is not a presentation. */
export function loadDeck(view: PartView, presentationPart: string): Deck {
  const doc = xmlOf(view, presentationPart);
  if (!doc || doc.root.localName !== "presentation" || !NS.p.has(doc.root.ns)) deckFailure("This package has no PresentationML main part.");
  const size = child(doc.root, "sldSz");
  const width = Math.min(MAX_EMU, Math.max(1, intAttr(size, "cx", DEFAULT_WIDTH)));
  const height = Math.min(MAX_EMU, Math.max(1, intAttr(size, "cy", DEFAULT_HEIGHT)));
  const slides: DeckSlide[] = [];
  let missingSlides = 0;
  for (const el of childrenNamed(child(doc.root, "sldIdLst"), "sldId")) {
    const rId = nsAttr(el, NS.r, "id");
    const entry = rId ? slideEntry(view, presentationPart, intAttr(el, "id", 0), rId) : null;
    if (entry) slides.push(entry);
    else missingSlides++;
  }
  const hasSections = descendants(doc.root).some((el) => el.localName === "sectionLst");
  return { presentationPart, width, height, slides, hasSections, missingSlides };
}
