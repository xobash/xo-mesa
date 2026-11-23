import type { OoxmlFeature } from "./capabilityGate";
import { diffBlocks, type BlockMatch } from "./blockDiff";
import { MC_NS, type Scope } from "./wordChecks";
import { describeBlocks, scanBlock, storyLayout, storySkeleton, type BlockInfo, type StoryLayout } from "./wordBlocks";
import { escapeXmlAttribute, findAttributeValue, namespaceDeclarations, nextTag, prefixOf, readAttributes } from "./xmlScan";

// Paragraph splice of one story part: the saved part is the ORIGINAL part's
// text with only the blocks the edit changed replaced by the editor's
// version. A block is "changed" when its editor output differs from the
// editor's no-edit output (matched in order by `diffBlocks`). Untouched
// blocks keep their original bytes, so tracked changes, comments and
// content controls in them survive. A change that touches a block carrying
// such a feature, or lands inside a range that spans blocks, is refused.

export type PartSplice = { readonly kind: "spliced"; readonly xml: string } | { readonly kind: "refused"; readonly problems: readonly string[] };

const MAX_PROBLEMS = 6;

const FEATURE_WORDS: Readonly<Partial<Record<OoxmlFeature, string>>> = {
  trackedChanges: "tracked changes",
  comments: "a comment",
  customXmlMarkup: "custom XML tags",
  contentControls: "a content control",
  alternateContent: "alternate content",
};

function listWords(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

interface Sides {
  readonly o: string;
  readonly b: string;
  readonly e: string;
  readonly lo: StoryLayout;
  readonly lb: StoryLayout;
  readonly le: StoryLayout;
}

/** Where each original block ends up: removed blocks, and insertion gaps (`g` = after original block `g`, -1 = at the start). */
interface ChangeSet {
  readonly removed: readonly number[];
  readonly gaps: readonly number[];
  readonly inserted: readonly number[];
}

function changeSet(match: BlockMatch): ChangeSet {
  const removed: number[] = [];
  for (let i = 0; i < match.beforeToAfter.length; i++) if (match.beforeToAfter[i] < 0) removed.push(i);
  const gaps: number[] = [];
  const inserted: number[] = [];
  let lastKept = -1;
  for (let j = 0; j < match.afterToBefore.length; j++) {
    if (match.afterToBefore[j] >= 0) { lastKept = match.afterToBefore[j]; continue; }
    inserted.push(j);
    if (gaps[gaps.length - 1] !== lastKept) gaps.push(lastKept);
  }
  return { removed, gaps, inserted };
}

/** Text without white space: the engine trims `w:t` edges that lack `xml:space="preserve"`, as Word does. */
function letters(text: string): string {
  return text.replace(/\s+/g, "");
}

/** Changed blocks may not carry an inline feature, and must be the same paragraph in both engine and file. */
function featureProblems(sides: Sides, infos: readonly BlockInfo[], where: readonly string[], removed: readonly number[]): string[] {
  const problems: string[] = [];
  for (const i of removed) {
    const words = [...infos[i].features].map((f) => FEATURE_WORDS[f] ?? f);
    if (words.length) problems.push(`${where[i]} has ${listWords(words)}, which Mesa keeps only in paragraphs you do not change`);
    else if (letters(scanBlock(sides.b, sides.lb.blocks[i], sides.lb.scope).text) !== letters(infos[i].text)) problems.push(`Mesa could not match ${where[i]} with the editor's copy`);
    if (problems.length >= MAX_PROBLEMS) break;
  }
  return problems;
}

interface Span { first: number; last: number; words: string }

/** Ranges that cover more than one block: markers paired by id, plus tracked paragraph marks joining a block to the next. */
function multiBlockSpans(infos: readonly BlockInfo[]): Span[] {
  const open = new Map<string, { first: number; last: number; words: string; ended: boolean; started: boolean }>();
  const spans: Span[] = [];
  infos.forEach((info, i) => {
    if (info.markRevision) spans.push({ first: i, last: Math.min(i + 1, infos.length - 1), words: "tracked change on a paragraph mark" });
    for (const marker of info.ranges) {
      const range = open.get(marker.key) ?? { first: i, last: i, words: marker.words, ended: false, started: false };
      if (marker.edge === "start") { range.first = Math.min(range.first, i); range.started = true; }
      else { range.last = Math.max(range.last, i); range.ended = true; }
      open.set(marker.key, range);
    }
  });
  for (const range of open.values()) {
    const first = range.started ? range.first : 0; // an unpaired end may start before this part's first block
    const last = range.ended ? range.last : infos.length - 1;
    if (first < last) spans.push({ first, last, words: range.words });
  }
  return spans;
}

/** Index of the first marked position at or after each index (`marks.length` when none). */
function nextMarked(marks: Uint8Array): Int32Array {
  const next = new Int32Array(marks.length + 1).fill(marks.length);
  for (let i = marks.length - 1; i >= 0; i--) next[i] = marks[i] ? i : next[i + 1];
  return next;
}

function rangeProblems(infos: readonly BlockInfo[], where: readonly string[], changes: ChangeSet): string[] {
  const n = infos.length;
  const removedMarks = new Uint8Array(n);
  for (const i of changes.removed) removedMarks[i] = 1;
  const gapMarks = new Uint8Array(n + 1); // index g + 1
  for (const g of changes.gaps) gapMarks[g + 1] = 1;
  const nextRemoved = nextMarked(removedMarks);
  const nextGap = nextMarked(gapMarks);
  const problems: string[] = [];
  for (const span of multiBlockSpans(infos)) {
    const range = `a ${span.words} that runs from ${where[span.first]} to ${where[span.last]}`;
    const hit = nextRemoved[span.first];
    const gap = nextGap[span.first + 1] - 1; // a gap after block g, first <= g < last, lands inside
    if (hit <= span.last) problems.push(`${where[hit]} is inside ${range}`);
    else if (gap < span.last) problems.push(`new text after ${where[gap]} would land inside ${range}`);
    if (problems.length >= MAX_PROBLEMS) break;
  }
  return problems;
}

/** Root and container declarations; a prefix bound to several URIs counts as unknown. */
function rootDeclarations(layout: StoryLayout): Map<string, string> {
  const map = new Map<string, string>();
  for (const [prefix, uris] of layout.scope) if (uris.size === 1) map.set(prefix, [...uris][0]);
  return map;
}

/** Prefixes the inserted blocks use and do not declare themselves. */
function usedPrefixes(xml: string, layout: StoryLayout, inserted: readonly number[]): Set<string> {
  const used = new Set<string>();
  const local: Scope = new Map();
  for (const j of inserted) {
    const block = layout.blocks[j];
    let at = block.start;
    for (let guard = 0; guard <= block.end - block.start; guard++) {
      const tag = nextTag(xml, at, block.end);
      if (!tag) break;
      at = tag.end;
      if (tag.kind === "end") continue;
      const attrText = xml.slice(tag.attrStart, tag.attrEnd);
      namespaceDeclarations(attrText, local);
      used.add(prefixOf(tag.qname));
      for (const name of readAttributes(attrText).keys()) {
        if (name.includes(":") && !name.startsWith("xmlns") && !name.startsWith("xml:")) used.add(prefixOf(name));
      }
    }
  }
  for (const prefix of local.keys()) used.delete(prefix);
  return used;
}

function ignorableAttribute(decls: ReadonlyMap<string, string>): string | null {
  for (const [prefix, uri] of decls) if (prefix && MC_NS.has(uri)) return `${prefix}:Ignorable`;
  return null;
}

/** The original root start tag with the declarations the inserted blocks need, or the problems. */
function mergedRootTag(sides: Sides, inserted: readonly number[]): { tag: string } | { problems: string[] } {
  const { o, e, lo, le } = sides;
  const oDecls = rootDeclarations(lo);
  const eDecls = rootDeclarations(le);
  const add = new Map<string, string>();
  for (const prefix of usedPrefixes(e, le, inserted)) {
    const uri = eDecls.get(prefix);
    if (uri === undefined) return { problems: [`the editor wrote markup with an undeclared prefix "${prefix}"`] };
    const have = oDecls.get(prefix);
    if (have === undefined) add.set(prefix, uri);
    else if (have !== uri) return { problems: [`the prefix "${prefix}" means different things in the file and in the editor's copy`] };
  }
  const eIgnorableName = ignorableAttribute(eDecls);
  const eIgnorable = eIgnorableName ? (readAttributes(e.slice(le.root.attrStart, le.root.attrEnd)).get(eIgnorableName) ?? "").split(/\s+/) : [];
  const ignore = [...add.keys()].filter((prefix) => eIgnorable.includes(prefix));
  let attrs = o.slice(lo.root.attrStart, lo.root.attrEnd);
  if (ignore.length) {
    let name = ignorableAttribute(oDecls);
    if (!name) {
      const mcPrefix = eIgnorableName!.split(":")[0];
      if (oDecls.has(mcPrefix) || add.has(mcPrefix)) return { problems: [`the prefix "${mcPrefix}" is already used in the file`] };
      add.set(mcPrefix, eDecls.get(mcPrefix)!);
      name = `${mcPrefix}:Ignorable`;
    }
    const value = findAttributeValue(attrs, 0, attrs.length, name);
    attrs = value
      ? `${attrs.slice(0, value.end)}${value.end > value.start ? " " : ""}${ignore.join(" ")}${attrs.slice(value.end)}`
      : `${attrs} ${name}="${ignore.join(" ")}"`;
  }
  const declared = [...add].map(([prefix, uri]) => ` ${prefix ? `xmlns:${prefix}` : "xmlns"}="${escapeXmlAttribute(uri)}"`).join("");
  return { tag: `${o.slice(lo.root.start, lo.root.attrStart)}${attrs}${declared}>` };
}

/** Original text with removed blocks dropped and inserted editor blocks placed in order. */
function assemble(sides: Sides, match: BlockMatch, rootTag: string): string {
  const { o, e, lo, le } = sides;
  const out: string[] = [o.slice(0, lo.root.start), rootTag, o.slice(lo.root.end, lo.contentStart)];
  const nB = match.beforeToAfter.length;
  const nE = match.afterToBefore.length;
  let i = 0;
  let j = 0;
  for (let guard = 0; guard <= nB + nE; guard++) {
    if (i < nB && match.beforeToAfter[i] < 0) { i++; continue; }
    if (j < nE && match.afterToBefore[j] < 0) { out.push(e.slice(le.blocks[j].start, le.blocks[j].end)); j++; continue; }
    if (i >= nB || j >= nE) break;
    if (match.beforeToAfter[i] !== j) throw new Error("Block match is not monotone.");
    out.push(o.slice(i === 0 ? lo.contentStart : lo.blocks[i - 1].end, lo.blocks[i].end));
    i++;
    j++;
  }
  out.push(o.slice(lo.tailStart));
  return out.join("");
}

function layouts(o: string, b: string, e: string, label: string): Sides | { problems: string[] } {
  const lo = storyLayout(o);
  const lb = storyLayout(b);
  const le = storyLayout(e);
  if (!lo || !lb || !le) return { problems: [`Mesa could not find the paragraphs of ${label}`] };
  if (lo.blocks.length !== lb.blocks.length) {
    return { problems: [`Mesa could not match the paragraphs of ${label} with the editor's copy (${lo.blocks.length} in the file, ${lb.blocks.length} in the editor)`] };
  }
  if (storySkeleton(b, lb) !== storySkeleton(e, le)) {
    return { problems: [`the edit changed ${label} outside its paragraphs (for example page or section settings), which Mesa cannot save into this file`] };
  }
  return { o, b, e, lo, lb, le };
}

/** Splices the edit (baseline `b` → edited `e`) into the original part `o`. */
export function spliceStoryPart(o: string, b: string, e: string, label: string): PartSplice {
  const sides = layouts(o, b, e, label);
  if ("problems" in sides) return { kind: "refused", problems: sides.problems };
  const match = diffBlocks(sides.lb.blocks.map((x) => b.slice(x.start, x.end)), sides.le.blocks.map((x) => e.slice(x.start, x.end)));
  const changes = changeSet(match);
  if (!changes.removed.length && !changes.inserted.length) return { kind: "spliced", xml: o };
  const infos = sides.lo.blocks.map((block) => scanBlock(o, block, sides.lo.scope));
  const where = describeBlocks(sides.lo.blocks, infos, label);
  const problems = [...featureProblems(sides, infos, where, changes.removed), ...rangeProblems(infos, where, changes)].slice(0, MAX_PROBLEMS);
  if (problems.length) return { kind: "refused", problems };
  const root = mergedRootTag(sides, changes.inserted);
  if ("problems" in root) return { kind: "refused", problems: root.problems.map((p) => `${label}: ${p}`) };
  return { kind: "spliced", xml: assemble(sides, match, root.tag) };
}
