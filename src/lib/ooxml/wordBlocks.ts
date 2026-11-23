import { COMMENT_ELEMENTS, REVISION_ELEMENTS, type OoxmlFeature } from "./capabilityGate";
import { MC_NS, WORD_NS, bound, wordAttribute, type Scope } from "./wordChecks";
import { decodeXmlText, listChildren, listTopLevel, localName, namespaceDeclarations, nextTag, readAttributes, type TopLevelElement, type XmlTagAt } from "./xmlScan";

// Block-level view of a WordprocessingML story part (document body, header,
// footer, footnotes, endnotes) for the paragraph splice: the container's
// children with their source ranges, and per block the inline features,
// range markers and visible text. Linear scans with an explicit depth
// counter; no recursion.

export interface StoryLayout {
  readonly root: XmlTagAt;
  /** Index just after the start tag of the element whose children are the blocks. */
  readonly contentStart: number;
  /** Blocks in order; a body's final `w:sectPr` is excluded (it stays the file's own). */
  readonly blocks: readonly TopLevelElement[];
  /** Index where the content after the last block starts. */
  readonly tailStart: number;
  /** Namespace declarations on the root and the container start tag. */
  readonly scope: Scope;
}

const ROOT_CONTAINERS = new Set(["hdr", "ftr", "footnotes", "endnotes"]);

function declarations(xml: string, tags: readonly XmlTagAt[]): Scope {
  const scope: Scope = new Map();
  for (const tag of tags) namespaceDeclarations(xml.slice(tag.attrStart, tag.attrEnd), scope);
  return scope;
}

/** Blocks of a story part, or `null` when the part is not a story Mesa can splice. */
export function storyLayout(xml: string): StoryLayout | null {
  const top = listTopLevel(xml);
  const rootName = localName(top.root.qname);
  let container: XmlTagAt = top.root;
  let blocks = top.children;
  if (rootName === "document") {
    const body = top.children.find((child) => child.name === "body");
    const bodyTag = body ? nextTag(xml, body.start) : null;
    if (!bodyTag || bodyTag.kind !== "start") return null;
    container = bodyTag;
    blocks = listChildren(xml, bodyTag).children;
    if (blocks.length && blocks[blocks.length - 1].name === "sectPr") blocks = blocks.slice(0, -1);
  } else if (!ROOT_CONTAINERS.has(rootName)) {
    return null;
  }
  const scope = declarations(xml, container === top.root ? [top.root] : [top.root, container]);
  if (!bound(scope, `${top.root.qname}`, WORD_NS)) return null;
  const tailStart = blocks.length ? blocks[blocks.length - 1].end : container.end;
  return { root: top.root, contentStart: container.end, blocks, tailStart, scope };
}

/** Everything outside the blocks except the root start tag; equal skeletons mean the edit stayed inside blocks. */
export function storySkeleton(xml: string, layout: StoryLayout): string {
  return `${xml.slice(layout.root.end, layout.contentStart)}\u0000${xml.slice(layout.tailStart)}`;
}

/** Range markers whose start and end can sit in different blocks, keyed by family. */
const RANGE_MARKERS: Readonly<Record<string, { family: string; edge: "start" | "end"; words: string }>> = {
  commentRangeStart: { family: "comment", edge: "start", words: "comment" },
  commentRangeEnd: { family: "comment", edge: "end", words: "comment" },
  bookmarkStart: { family: "bookmark", edge: "start", words: "bookmark" },
  bookmarkEnd: { family: "bookmark", edge: "end", words: "bookmark" },
  permStart: { family: "perm", edge: "start", words: "permission range" },
  permEnd: { family: "perm", edge: "end", words: "permission range" },
  moveFromRangeStart: { family: "moveFrom", edge: "start", words: "tracked move" },
  moveFromRangeEnd: { family: "moveFrom", edge: "end", words: "tracked move" },
  moveToRangeStart: { family: "moveTo", edge: "start", words: "tracked move" },
  moveToRangeEnd: { family: "moveTo", edge: "end", words: "tracked move" },
  customXmlInsRangeStart: { family: "cxIns", edge: "start", words: "tracked change" },
  customXmlInsRangeEnd: { family: "cxIns", edge: "end", words: "tracked change" },
  customXmlDelRangeStart: { family: "cxDel", edge: "start", words: "tracked change" },
  customXmlDelRangeEnd: { family: "cxDel", edge: "end", words: "tracked change" },
  customXmlMoveFromRangeStart: { family: "cxMoveFrom", edge: "start", words: "tracked change" },
  customXmlMoveFromRangeEnd: { family: "cxMoveFrom", edge: "end", words: "tracked change" },
  customXmlMoveToRangeStart: { family: "cxMoveTo", edge: "start", words: "tracked change" },
  customXmlMoveToRangeEnd: { family: "cxMoveTo", edge: "end", words: "tracked change" },
};

/** Revision elements that, inside a paragraph's own `w:pPr`, mark its paragraph mark (joining it to the next block). */
const MARK_REVISIONS = new Set(["ins", "del", "moveFrom", "moveTo"]);

export interface RangeMarker { readonly key: string; readonly edge: "start" | "end"; readonly words: string }

export interface BlockInfo {
  /** Inline features the engine cannot keep in a block it re-serializes. */
  readonly features: ReadonlySet<OoxmlFeature>;
  readonly ranges: readonly RangeMarker[];
  /** The paragraph mark itself is a tracked change, so the paragraph joins the next one. */
  readonly markRevision: boolean;
  /** Visible text (`w:t` content), decoded. */
  readonly text: string;
}

function featureOf(local: string): OoxmlFeature | null {
  if (REVISION_ELEMENTS.has(local) || (local.startsWith("customXml") && local.includes("Range"))) return "trackedChanges";
  if (COMMENT_ELEMENTS.has(local)) return "comments";
  if (local === "customXml" || local === "smartTag") return "customXmlMarkup";
  if (local === "sdt") return "contentControls";
  return null;
}

interface BlockWalk {
  depth: number;
  /** Depth of the block's own `w:pPr` while inside it, else -1. */
  pPrDepth: number;
}

function visitTag(xml: string, tag: XmlTagAt, scope: Scope, walk: BlockWalk, out: { features: Set<OoxmlFeature>; ranges: RangeMarker[]; text: string[]; markRevision: boolean }, isParagraph: boolean): void {
  if (tag.kind === "end") {
    if (walk.depth === walk.pPrDepth) walk.pPrDepth = -1;
    walk.depth--;
    return;
  }
  const attrText = xml.slice(tag.attrStart, tag.attrEnd);
  namespaceDeclarations(attrText, scope);
  const local = localName(tag.qname);
  if (local === "AlternateContent" && bound(scope, tag.qname, MC_NS)) out.features.add("alternateContent");
  if (bound(scope, tag.qname, WORD_NS)) {
    const feature = featureOf(local);
    if (feature) out.features.add(feature);
    const marker = RANGE_MARKERS[local];
    if (marker) out.ranges.push({ key: `${marker.family}:${wordAttribute(readAttributes(attrText), scope, "id") ?? ""}`, edge: marker.edge, words: marker.words });
    if (walk.pPrDepth >= 0 && MARK_REVISIONS.has(local)) out.markRevision = true;
    if (isParagraph && walk.depth === 1 && local === "pPr" && tag.kind === "start") walk.pPrDepth = 2;
    if (local === "t" && tag.kind === "start") {
      const close = xml.indexOf("<", tag.end);
      out.text.push(decodeXmlText(xml.slice(tag.end, close < 0 ? xml.length : close)));
    }
  }
  if (tag.kind === "start") walk.depth++;
}

/** Scans one block in a single linear pass. `rootScope` is copied, not changed. */
export function scanBlock(xml: string, block: TopLevelElement, rootScope: Scope): BlockInfo {
  const scope: Scope = new Map([...rootScope].map(([prefix, uris]) => [prefix, new Set(uris)]));
  const out = { features: new Set<OoxmlFeature>(), ranges: [] as RangeMarker[], text: [] as string[], markRevision: false };
  const walk: BlockWalk = { depth: 0, pPrDepth: -1 };
  const isParagraph = block.name === "p";
  let at = block.start;
  for (let guard = 0; guard <= block.end - block.start; guard++) {
    const tag = nextTag(xml, at, block.end);
    if (!tag) break;
    at = tag.end;
    visitTag(xml, tag, scope, walk, out, isParagraph);
  }
  return { features: out.features, ranges: out.ranges, markRevision: out.markRevision, text: out.text.join("") };
}

const BLOCK_WORDS: Readonly<Record<string, string>> = {
  p: "paragraph", tbl: "table", sdt: "content control", customXml: "custom XML block", footnote: "footnote", endnote: "endnote",
};
const SNIPPET_CHARS = 40;

/** Plain-language location of each block, e.g. `paragraph 3 of the main text ("Quarterly…")`. */
export function describeBlocks(blocks: readonly TopLevelElement[], infos: readonly BlockInfo[], partLabel: string): string[] {
  const seen = new Map<string, number>();
  return blocks.map((block, i) => {
    const word = BLOCK_WORDS[block.name] ?? "block";
    const ordinal = (seen.get(word) ?? 0) + 1;
    seen.set(word, ordinal);
    const text = infos[i].text.trim();
    const snippet = text ? ` (“${text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}…` : text}”)` : "";
    return `${word} ${ordinal} of ${partLabel}${snippet}`;
  });
}
