/**
 * Lightweight metadata extraction from note source — frontmatter, [[links]],
 * #tags, aliases, and the first embedded image.
 *
 * Deliberately dependency-free: functions scan delimiters and use regex over the
 * raw text, with no full Markdown parse. This module is imported at vault-scan
 * time (`store.ts`, `lib/graph.ts`, `lib/deepResearch.ts`) for every note in
 * the vault, so it must NOT pull in the rendering stack — markdown-it +
 * dompurify and friends are ~120 kB minified and are only needed when markdown
 * is actually turned into HTML. The renderer lives in `markdown.ts` and imports
 * from here, never the other way around; `markdownLoadContract.test.ts` pins
 * the direction.
 */

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
const TARGET_END_RE = /[)\s]/g;

/** All [[note]] targets referenced by a note (image embeds excluded). */
// Standard Markdown links to local notes: [text](Note.md) / [text](dir/Note.md),
// optionally URL-encoded and with a #heading. Many imported vaults use these
// instead of [[wiki-links]], so we resolve them into the graph too.

/**
 * ONE pass over the `[[wiki]]` refs, yielding both the note links and the first
 * embedded image.
 *
 * `extractLinks` and `extractFirstImage` each ran this identical scan over the
 * same source, so `buildNotes` walked every note twice with the same regex. On
 * the measured 4,165-file vault (721 notes, 13.5 M characters of markdown) the
 * duplicate pass was 30 ms of a ~215 ms vault open, and vault open is a
 * synchronous freeze the user waits through on every launch.
 *
 * Ordering note: the original `extractLinks` skipped an empty target BEFORE the
 * image test, and the original `extractFirstImage` tested `IMAGE_EXT` without
 * that guard. `IMAGE_EXT` can never match the empty string, so testing the image
 * branch first is equivalent for both callers.
 */
function scanWikiRefs(source: string): { links: string[]; firstImage: string | null } {
  const links: string[] = [];
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
    const target = (source.slice(open + 2, close).split("|")[0] || "").trim();
    if (open > 0 && source[open - 1] === "!" && IMAGE_EXT.test(target)) {
      if (firstImage === null) firstImage = target;
      continue;
    }
    if (target) links.push(target);
  }
  return { links, firstImage };
}

/** Scan each label once, including malformed nested opening brackets.
 * Preserve the legacy link prefix consumption and image target grammar. */
function* markdownTargets(source: string, image: boolean): Generator<string> {
  let next = 0;
  let matchEnd = 0;
  let targetEnd = -1;
  while (next < source.length) {
    const start = source.indexOf(image ? "![" : "[", next);
    if (start < 0) return;
    const open = image ? start + 1 : start;
    next = open + 1;
    if (!image && open !== 0 && (open <= matchEnd || source[open - 1] === "!")) continue;
    const close = source.indexOf("]", open + 1);
    if (close < 0) return;
    const targetStart = close + 2;
    if (source[close + 1] !== "(") {
      next = close + 1;
      continue;
    }
    // Target starts only move forward. Reuse the next terminator when many
    // malformed labels point into the same unterminated target run.
    if (targetEnd < targetStart) {
      TARGET_END_RE.lastIndex = targetStart;
      targetEnd = TARGET_END_RE.exec(source)?.index ?? source.length;
    }
    if (targetEnd === targetStart || (!image && source[targetEnd] !== ")")) {
      next = close + 1;
      continue;
    }
    matchEnd = image ? targetEnd : targetEnd + 1;
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

/** The first `![](…)` Markdown image in the source. */
function firstMarkdownImage(source: string): string | null {
  for (const target of markdownTargets(source, true)) return target.trim();
  return null;
}

export function extractLinks(source: string): string[] {
  if (!source.includes("[")) return [];
  const out = scanWikiRefs(source).links;
  appendMarkdownLinks(source, out);
  return out;
}

/** The first image a note references, used for the graph thumbnail. */
export function extractFirstImage(source: string): string | null {
  if (!source.includes("[")) return null;
  return scanWikiRefs(source).firstImage ?? firstMarkdownImage(source);
}

/**
 * Both of the above from a SINGLE wiki scan — what `buildNotes` wants for every
 * note in the vault. Identical results to calling them separately.
 */
export function extractLinksAndFirstImage(source: string): {
  links: string[];
  firstImage: string | null;
} {
  if (!source.includes("[")) return { links: [], firstImage: null };
  const { links, firstImage } = scanWikiRefs(source);
  appendMarkdownLinks(source, links);
  return { links, firstImage: firstImage ?? firstMarkdownImage(source) };
}

// #tags — a hash directly followed by a word (no space), not a Markdown heading
// (headings have a space after the hashes) and not a fenced code block.
const TAG_RE = /(?:^|\s)#([A-Za-z][\w/-]*)/g;
const FENCE_RE = /```[\s\S]*?```/g;

export function extractTags(source: string): string[] {
  if (!source.includes("#")) return [];
  const out = new Set<string>();
  FENCE_RE.lastIndex = 0;
  let fence = FENCE_RE.exec(source);
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(source))) {
    const hashAt = m.index + m[0].lastIndexOf("#");
    while (fence && fence.index + fence[0].length <= hashAt) {
      fence = FENCE_RE.exec(source);
    }
    if (fence && fence.index <= hashAt && hashAt < fence.index + fence[0].length) {
      continue;
    }
    out.add(m[1]);
  }
  return [...out];
}
