import { CONTENT_TYPES_PART, relationshipsPartFor } from "../ooxml/ooxmlPackage";
import { escapeXmlAttribute } from "../ooxml/xmlScan";
import { NS, overlayView, relsOf, relType, xmlOf, type Deck, type PartView } from "./pptxDeck";
import { PptxEditRefusal } from "./pptxTextEdit";
import {
  applySplices, attr, child, childrenNamed, descendants, encodeXmlPart, nsAttrName,
  type XmlDoc, type XmlEl, type XmlSplice,
} from "./xmlTree";

// Slide-level edits as part changes. Reorder rewrites only the order of
// `p:sldId` entries in presentation.xml. Delete removes the entry, its
// relationship, and exactly the parts that become unreachable from the
// package root because of it. Duplicate copies a slide whose relationships
// are all safe to share. Decks with sections are refused (sections list
// slides by id and Mesa does not update them).

export type PartChanges = Map<string, Uint8Array | null>;

function refuse(message: string): never {
  throw new PptxEditRefusal(message);
}

function encodeEdited(doc: XmlDoc, splices: readonly XmlSplice[]): Uint8Array {
  return encodeXmlPart(doc, applySplices(doc.text, splices));
}

function presentation(view: PartView, deck: Deck): { doc: XmlDoc; entries: XmlEl[] } {
  if (deck.hasSections) refuse("This presentation uses sections, which Mesa does not update. Slide order, delete and duplicate are off.");
  if (deck.missingSlides) refuse("This presentation lists a slide that is missing, so Mesa does not change its slide list.");
  const doc = xmlOf(view, deck.presentationPart);
  const list = child(doc?.root, "sldIdLst");
  if (!doc || !list) refuse("This presentation has no slide list.");
  const entries = childrenNamed(list, "sldId");
  if (entries.length !== deck.slides.length || entries.length !== list.children.length) refuse("This presentation's slide list holds entries Mesa does not model.");
  return { doc, entries };
}

/** Moves the slide at `from` to position `to`; only presentation.xml changes. */
export function moveSlide(view: PartView, deck: Deck, from: number, to: number): PartChanges {
  const { doc, entries } = presentation(view, deck);
  if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) return new Map();
  const order = entries.map((el) => doc.text.slice(el.start, el.end));
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const splices = entries.map((el, i) => ({ start: el.start, end: el.end, text: order[i] }));
  return new Map([[deck.presentationPart, encodeEdited(doc, splices)]]);
}

/** Parts reachable from the package root through internal relationships (breadth-first, bounded). */
export function reachableParts(view: PartView): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [""];
  for (let i = 0; i < queue.length && i <= view.parts.size; i++) {
    for (const rel of relsOf(view, queue[i])) {
      const target = rel.targetPart;
      if (rel.external || !target || seen.has(target) || !view.parts.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

function relationshipSplice(view: PartView, sourcePart: string, id: string): { part: string; doc: XmlDoc; splice: XmlSplice } {
  const part = relationshipsPartFor(sourcePart);
  const doc = xmlOf(view, part);
  const el = doc ? childrenNamed(doc.root, "Relationship").find((r) => attr(r, "Id") === id) : undefined;
  if (!doc || !el) refuse("The slide's relationship is missing.");
  return { part, doc, splice: { start: el.start, end: el.end, text: "" } };
}

function overrideFor(doc: XmlDoc, part: string): XmlEl | undefined {
  const wanted = `/${part}`.toLowerCase();
  return childrenNamed(doc.root, "Override").find((el) => {
    const name = attr(el, "PartName") ?? "";
    let decoded = name;
    try { decoded = decodeURIComponent(name); } catch { /* keep the raw name */ }
    return decoded.toLowerCase() === wanted;
  });
}

function contentTypesWithout(view: PartView, removed: Iterable<string>): Uint8Array {
  const doc = xmlOf(view, CONTENT_TYPES_PART);
  if (!doc) refuse("The package has no content types.");
  const splices: XmlSplice[] = [];
  for (const part of removed) {
    const el = overrideFor(doc, part);
    if (el) splices.push({ start: el.start, end: el.end, text: "" });
  }
  return encodeEdited(doc, splices);
}

function otherRelationshipUses(doc: XmlDoc, entry: XmlEl, rId: string): boolean {
  return descendants(doc.root).some((el) => el !== entry && [...el.attrs.keys()].some((name) => {
    const colon = name.indexOf(":");
    return colon > 0 && NS.r.has(el.nsMap.get(name.slice(0, colon)) ?? "") && attr(el, name) === rId;
  }));
}

/**
 * Deletes the slide at `index`. Removes its `p:sldId`, its presentation
 * relationship, and every part (with its relationships part and content-type
 * override) that was reachable before and is not after. Parts still used
 * elsewhere (layouts, shared media) stay. Refused when another part links to
 * the slide, so no relationship is left dangling.
 */
export function deleteSlide(view: PartView, deck: Deck, index: number): PartChanges {
  const { doc, entries } = presentation(view, deck);
  const slide = deck.slides[index];
  if (!slide) refuse("That slide no longer exists.");
  if (deck.slides.length <= 1) refuse("A presentation needs at least one slide.");
  if (otherRelationshipUses(doc, entries[index], slide.rId)) refuse("A custom show or another part of the presentation uses this slide.");
  const rel = relationshipSplice(view, deck.presentationPart, slide.rId);
  const changes: PartChanges = new Map([
    [deck.presentationPart, encodeEdited(doc, [{ start: entries[index].start, end: entries[index].end, text: "" }])],
    [rel.part, encodeEdited(rel.doc, [rel.splice])],
  ]);
  const before = reachableParts(view);
  const after = reachableParts(overlayView(view, changes));
  if (after.has(slide.part)) refuse("Another slide links to this slide. Remove that link first.");
  const removed = [...before].filter((part) => !after.has(part) && part !== CONTENT_TYPES_PART);
  for (const part of removed) {
    changes.set(part, null);
    const rels = relationshipsPartFor(part);
    if (view.parts.has(rels)) changes.set(rels, null);
  }
  changes.set(CONTENT_TYPES_PART, contentTypesWithout(view, removed));
  return changes;
}

/** Relationship types a duplicate may share with its original. */
const SHAREABLE = new Set(["slideLayout", "image", "hyperlink", "notesMaster"]);

function relativeTarget(fromPart: string, toPart: string): string {
  const from = fromPart.split("/").slice(0, -1);
  const to = toPart.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...new Array(from.length - common).fill(".."), ...to.slice(common)].join("/");
}

function freePartName(view: PartView, dir: string, stem: string): string {
  const taken = new Set([...view.parts.keys()].map((name) => name.toLowerCase()));
  for (let n = 1; n <= view.parts.size + 1; n++) {
    const name = `${dir}/${stem}${n}.xml`;
    if (!taken.has(name.toLowerCase()) && !taken.has(relationshipsPartFor(name).toLowerCase())) return name;
  }
  return refuse("No free part name is available.");
}

function checkShareable(view: PartView, part: string, ownTypes: ReadonlySet<string>): void {
  for (const rel of relsOf(view, part)) {
    const type = relType(rel);
    if (rel.external && type === "hyperlink") continue;
    if (!rel.external && (SHAREABLE.has(type) || ownTypes.has(type))) continue;
    refuse(`This slide has a ${rel.external ? "linked " : ""}${type} part that Mesa cannot share between two slides.`);
  }
}

/** Copies a relationships part, pointing relationships of `retype` at a new target. */
function copiedRels(view: PartView, part: string, retype: string, target: string | null): Uint8Array | null {
  const relsPart = relationshipsPartFor(part);
  const doc = xmlOf(view, relsPart);
  if (!doc) return null;
  const splices: XmlSplice[] = [];
  for (const el of childrenNamed(doc.root, "Relationship")) {
    const type = attr(el, "Type") ?? "";
    if (target === null || type.slice(type.lastIndexOf("/") + 1) !== retype) continue;
    const raw = doc.text.slice(el.start, el.end);
    const rewritten = raw.replace(/(\sTarget\s*=\s*)(["'])[^"']*\2/, (_m, lead: string, q: string) => `${lead}${q}${escapeXmlAttribute(target)}${q}`);
    splices.push({ start: el.start, end: el.end, text: rewritten });
  }
  return encodeEdited(doc, splices);
}

function insertBeforeClose(doc: XmlDoc, text: string): Uint8Array {
  const at = doc.root.innerEnd;
  if (doc.root.innerEnd === doc.root.end || doc.root.name.includes(":")) refuse("A package part has a form Mesa does not edit.");
  return encodeEdited(doc, [{ start: at, end: at, text }]);
}

function newIds(entries: readonly XmlEl[], relsDoc: XmlDoc): { sldId: number; rId: string } {
  const max = entries.reduce((m, el) => Math.max(m, Number(attr(el, "id")) || 0), 255);
  if (max + 1 >= 2_147_483_648) refuse("This presentation has no free slide id.");
  const used = new Set(childrenNamed(relsDoc.root, "Relationship").map((r) => attr(r, "Id")));
  let n = used.size + 1;
  for (let guard = 0; used.has(`rId${n}`) && guard <= used.size; guard++) n++;
  return { sldId: max + 1, rId: `rId${n}` };
}

/** Duplicates the slide at `index` right after it, copying its notes page. */
export function duplicateSlide(view: PartView, deck: Deck, index: number): PartChanges {
  const { doc, entries } = presentation(view, deck);
  const slide = deck.slides[index];
  if (!slide) refuse("That slide no longer exists.");
  checkShareable(view, slide.part, new Set(["notesSlide"]));
  if (slide.notesPart) checkShareable(view, slide.notesPart, new Set(["slide"]));
  const relsPart = relationshipsPartFor(deck.presentationPart);
  const relsDoc = xmlOf(view, relsPart);
  const typesDoc = xmlOf(view, CONTENT_TYPES_PART);
  const slideType = view.contentTypeOf(slide.part);
  if (!relsDoc || !typesDoc || !slideType) refuse("The presentation's relationships or content types are missing.");
  const newSlide = freePartName(view, slide.part.slice(0, slide.part.lastIndexOf("/")), "slide");
  const newNotes = slide.notesPart ? freePartName(view, slide.notesPart.slice(0, slide.notesPart.lastIndexOf("/")), "notesSlide") : null;
  const { sldId, rId } = newIds(entries, relsDoc);
  const entry = entries[index];
  const rAttr = nsAttrName(entry, NS.r, "id") ?? "r:id";
  const relEl = childrenNamed(relsDoc.root, "Relationship").find((r) => attr(r, "Id") === slide.rId);
  const relType = attr(relEl, "Type");
  if (!relEl || !relType) refuse("The slide's relationship is missing.");
  const changes: PartChanges = new Map();
  changes.set(newSlide, view.parts.get(slide.part)!.slice()); // own buffer: caches key on part bytes
  const slideRels = copiedRels(view, slide.part, "notesSlide", newNotes ? relativeTarget(newSlide, newNotes) : null);
  if (slideRels) changes.set(relationshipsPartFor(newSlide), slideRels);
  let overrides = `<Override PartName="/${escapeXmlAttribute(newSlide)}" ContentType="${escapeXmlAttribute(slideType)}"/>`;
  if (slide.notesPart && newNotes) {
    changes.set(newNotes, view.parts.get(slide.notesPart)!.slice());
    const notesRels = copiedRels(view, slide.notesPart, "slide", relativeTarget(newNotes, newSlide));
    if (notesRels) changes.set(relationshipsPartFor(newNotes), notesRels);
    overrides += `<Override PartName="/${escapeXmlAttribute(newNotes)}" ContentType="${escapeXmlAttribute(view.contentTypeOf(slide.notesPart) ?? "")}"/>`;
  }
  const at = entry.end;
  changes.set(deck.presentationPart, encodeEdited(doc, [{ start: at, end: at, text: `<${entry.name} id="${sldId}" ${rAttr}="${rId}"/>` }]));
  changes.set(relsPart, insertBeforeClose(relsDoc, `<${relEl.name} Id="${rId}" Type="${escapeXmlAttribute(relType)}" Target="${escapeXmlAttribute(relativeTarget(deck.presentationPart, newSlide))}"/>`));
  changes.set(CONTENT_TYPES_PART, insertBeforeClose(typesDoc, overrides));
  return changes;
}
