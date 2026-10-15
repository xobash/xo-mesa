/**
 * Dependency-free note metadata extraction. Rendering imports extraction, never
 * the reverse. Links, images and tags come from prose only, never from code
 * (`markdownCode.ts`). Every extractor takes `markdown`: false for other text
 * files, whose only code is fenced blocks.
 */
import { codeRanges, proseText } from "./markdownCode";

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

/** Split off a leading YAML frontmatter block into key/value pairs. */
export function parseFrontmatter(source: string): {
  body: string;
  props: [string, string][];
} {
  if (!source.startsWith("---")) return { body: source, props: [] };
  const m = FRONTMATTER_RE.exec(source);
  if (!m) return { body: source, props: [] };
  const props: [string, string][] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (mm) props.push([mm[1], mm[2].trim()]);
  }
  return { body: source.slice(m[0].length), props };
}

/** Frontmatter `aliases:`/`alias:` values, used so [[alias]] resolves. */
export function extractAliases(source: string): string[] {
  const { props } = parseFrontmatter(source);
  const out: string[] = [];
  for (const [k, v] of props) {
    if (k.toLowerCase() !== "alias" && k.toLowerCase() !== "aliases") continue;
    const cleaned = v.replace(/^\[|\]$/g, "");
    for (const part of cleaned.split(",")) {
      const a = part.trim().replace(/^["']|["']$/g, "");
      if (a) out.push(a);
    }
  }
  return out;
}

const WIKI_END_RE = /[\]\n]/g;
/** Characters whose presence in code could change what the link scans find. */
const LINK_SYNTAX = /[[\]()<>]/;
const TARGET_END_RE = /[)\s]/g;

/** All [[note]] targets referenced by a note (image embeds excluded). */
// Standard Markdown links to local notes: [text](Note.md) / [text](dir/Note.md),
// optionally URL-encoded and with a #heading. Many imported vaults use these
// instead of [[wiki-links]], so we resolve them into the graph too.

/** Extract note links and the first embedded image in one wiki-reference pass.
 * Image targets are handled before the empty-link guard; empty targets cannot
 * match IMAGE_EXT. */
function scanWikiRefs(source: string): { links: string[]; references: string[]; firstImage: string | null } {
  const links: string[] = [];
  const references: string[] = [];
  let firstImage: string | null = null;
  let next = 0;
  while (next < source.length) {
    const open = source.indexOf("[[", next);
    if (open < 0) break;
    WIKI_END_RE.lastIndex = open + 2;
    const end = WIKI_END_RE.exec(source);
    if (!end) break;
    const close = end.index;
    // Every opener before this delimiter has the same failed terminator.
    // Skip that region once instead of rescanning it for every '['.
    next = close + 1;
    if (close === open + 2 || source[close] !== "]" || source[close + 1] !== "]") continue;
    next = close + 2;
    // Tables escape the alias separator as `\|`; the backslash is not part of the target.
    const target = (source.slice(open + 2, close).split("|")[0] || "").replace(/\\$/, "").trim();
    if (target) references.push(target);
    if (open > 0 && source[open - 1] === "!" && IMAGE_EXT.test(target)) {
      if (firstImage === null) firstImage = target;
      continue;
    }
    if (target) links.push(target);
  }
  return { links, references, firstImage };
}

/** Index of the `)` closing a link destination at `at`, after an optional
 * CommonMark title ("t", 't' or (t)); -1 when the link is not closed there. */
function linkCloseAfter(source: string, at: number): number {
  let i = at;
  while (source[i] === " " || source[i] === "\t") i++;
  const opener = source[i];
  if (opener === '"' || opener === "'" || opener === "(") {
    const closer = opener === "(" ? ")" : opener;
    const end = source.indexOf(closer, i + 1);
    const line = source.indexOf("\n", i + 1);
    if (end < 0 || (line >= 0 && line < end) || i === at) return -1;
    i = end + 1;
    while (source[i] === " " || source[i] === "\t") i++;
  }
  return source[i] === ")" ? i : -1;
}

/** When the `]` at `imageClose` ends an inline image `![alt](dest)`, the
 * index of the following `]` that closes an enclosing label and is directly
 * followed by `(`; otherwise -1. */
function imageLabelClose(source: string, imageClose: number): number {
  TARGET_END_RE.lastIndex = imageClose + 2;
  const end = TARGET_END_RE.exec(source)?.index ?? -1;
  if (end <= imageClose + 2 || source[end] !== ")") return -1;
  const close = source.indexOf("]", end + 1);
  return close >= 0 && source[close + 1] === "(" ? close : -1;
}

/** Scan each label once, including malformed nested opening brackets.
 * Preserve the legacy link prefix consumption and image target grammar. */
function* markdownTargets(source: string, image: boolean): Generator<string> {
  let next = 0;
  let matchEnd = 0;
  let targetEnd = -1;
  // Labels that share a first `]` share its image-label answer; resolve it once.
  let badgeFor = -1;
  let badgeImage = -1;
  let badgeClose = -1;
  while (next < source.length) {
    const start = source.indexOf(image ? "![" : "[", next);
    if (start < 0) return;
    const open = image ? start + 1 : start;
    next = open + 1;
    if (!image && open !== 0 && (open <= matchEnd || source[open - 1] === "!")) continue;
    const firstClose = source.indexOf("]", open + 1);
    if (firstClose < 0) return;
    let close = firstClose;
    if (!image && source[close + 1] === "(") {
      if (badgeFor !== close) {
        badgeFor = close;
        const inner = source.lastIndexOf("[", close);
        badgeImage = source[inner - 1] === "!" ? inner : -1;
        badgeClose = badgeImage >= 0 ? imageLabelClose(source, close) : -1;
      }
      // `[![alt](img.png)](Note.md)`: the first `]` closes the image, not the link.
      if (badgeClose >= 0 && badgeImage > open) close = badgeClose;
    }
    const targetStart = close + 2;
    if (source[close + 1] !== "(") {
      next = close + 1;
      continue;
    }
    // CommonMark `<destination>` may contain spaces; links also accept a title.
    if (!image && source[targetStart] === "<") {
      const gt = source.indexOf(">", targetStart + 1);
      const line = source.indexOf("\n", targetStart);
      const end = gt > targetStart + 1 && (line < 0 || gt < line) ? linkCloseAfter(source, gt + 1) : -1;
      if (end >= 0) {
        matchEnd = end + 1;
        next = matchEnd + 1;
        yield source.slice(targetStart + 1, gt);
        continue;
      }
      // Not a valid `<destination>`: read it as a bare destination, as before.
    }
    // Target starts only move forward. Reuse the next terminator when many
    // malformed labels point into the same unterminated target run.
    if (targetEnd < targetStart) {
      TARGET_END_RE.lastIndex = targetStart;
      targetEnd = TARGET_END_RE.exec(source)?.index ?? source.length;
    }
    const linkEnd = image || source[targetEnd] === ")" ? targetEnd : linkCloseAfter(source, targetEnd);
    if (targetEnd === targetStart || linkEnd < 0) {
      next = firstClose + 1;
      // A failed image label moved the target start back; drop the cached terminator.
      if (close !== firstClose) targetEnd = -1;
      continue;
    }
    matchEnd = image ? targetEnd : linkEnd + 1;
    next = image ? matchEnd : matchEnd + 1;
    yield source.slice(targetStart, targetEnd);
  }
}

/** Standard-Markdown note links, appended to `out` in source order. */
function appendMarkdownLinks(source: string, out: string[]): void {
  for (const raw of markdownTargets(source, false)) {
    let target = raw.trim();
    if (/^(https?:|mailto:|tel:|data:|#)/i.test(target)) continue; // external/anchor
    target = target.split("#")[0];
    try {
      target = decodeURIComponent(target);
    } catch {
      /* keep raw */
    }
    if (/\.(md|markdown)$/i.test(target)) out.push(target);
  }
}

/** Every local Markdown destination, including image/embed destinations. */
function appendMarkdownReferences(source: string, out: string[]): void {
  for (const image of [false, true]) {
    for (const raw of markdownTargets(source, image)) {
      const target = raw.trim();
      if (target && !/^(https?:|mailto:|tel:|data:|#)/i.test(target)) out.push(target);
    }
  }
}

/** Local destinations held by reference-style Markdown definitions. */
function appendReferenceDefinitions(source: string, out: string[]): void {
  const definitions = /^\s{0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|[^\s]+)/gm;
  for (const match of source.matchAll(definitions)) {
    const raw = match[1];
    const target = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
    if (target && !/^(https?:|mailto:|tel:|data:|#)/i.test(target)) out.push(target);
  }
}

/** The first `![](…)` Markdown image in the source. */
function firstMarkdownImage(source: string): string | null {
  for (const target of markdownTargets(source, true)) return target.trim();
  return null;
}

export function extractLinks(source: string, markdown = true): string[] {
  if (!source.includes("[")) return [];
  source = proseText(source, markdown, LINK_SYNTAX);
  const out = scanWikiRefs(source).links;
  appendMarkdownLinks(source, out);
  return out;
}

/** The first image a note references, used for the graph thumbnail. */
export function extractFirstImage(source: string, markdown = true): string | null {
  if (!source.includes("[")) return null;
  source = proseText(source, markdown, LINK_SYNTAX);
  return scanWikiRefs(source).firstImage ?? firstMarkdownImage(source);
}

/**
 * Both of the above from a SINGLE wiki scan — what `buildNotes` wants for every
 * note in the vault. Identical results to calling them separately.
 */
export function extractLinksAndFirstImage(source: string, markdown = true): {
  links: string[];
  references: string[];
  firstImage: string | null;
} {
  if (!source.includes("[")) return { links: [], references: [], firstImage: null };
  source = proseText(source, markdown, LINK_SYNTAX);
  const { links, references, firstImage } = scanWikiRefs(source);
  appendMarkdownLinks(source, links);
  appendMarkdownReferences(source, references);
  appendReferenceDefinitions(source, references);
  return { links, references, firstImage: firstImage ?? firstMarkdownImage(source) };
}

// #tags — a hash directly followed by a word (no space), not a Markdown heading
// (headings have a space after the hashes) and not code.
const TAG_RE = /(?:^|\s)#([A-Za-z][\w/-]*)/g;

export function extractTags(source: string, markdown = true): string[] {
  if (!source.includes("#")) return [];
  const code = codeRanges(source, markdown);
  const out = new Set<string>();
  let k = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(source))) {
    const hashAt = m.index + m[0].lastIndexOf("#");
    while (k < code.length && code[k + 1] <= hashAt) k += 2;
    if (k < code.length && code[k] <= hashAt) continue;
    out.add(m[1]);
  }
  return [...out];
}
