/**
 * Lightweight metadata extraction from note source — frontmatter, [[links]],
 * #tags, aliases, and the first embedded image.
 *
 * Deliberately dependency-free: every function here is plain regex over the
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

const WIKI_RE = /!?\[\[([^\]\n]+?)\]\]/g;
const MD_IMG_RE = /!\[[^\]]*\]\(([^)\s]+)/g;

/** All [[note]] targets referenced by a note (image embeds excluded). */
// Standard Markdown links to local notes: [text](Note.md) / [text](dir/Note.md),
// optionally URL-encoded and with a #heading. Many imported vaults use these
// instead of [[wiki-links]], so we resolve them into the graph too.
const MD_LINK_RE = /(^|[^!])\[[^\]]*\]\(([^)\s]+)\)/g;

export function extractLinks(source: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;

  WIKI_RE.lastIndex = 0;
  while ((m = WIKI_RE.exec(source))) {
    const target = (m[1].split("|")[0] || "").trim();
    if (!target) continue;
    if (m[0].startsWith("!") && IMAGE_EXT.test(target)) continue; // image, not a link
    out.push(target);
  }

  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(source))) {
    let target = m[2].trim();
    if (/^(https?:|mailto:|tel:|data:|#)/i.test(target)) continue; // external/anchor
    target = target.split("#")[0];
    try {
      target = decodeURIComponent(target);
    } catch {
      /* keep raw */
    }
    if (/\.(md|markdown)$/i.test(target)) out.push(target);
  }

  return out;
}

/** The first image a note references, used for the graph thumbnail. */
export function extractFirstImage(source: string): string | null {
  WIKI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_RE.exec(source))) {
    if (m[0].startsWith("!")) {
      const target = (m[1].split("|")[0] || "").trim();
      if (IMAGE_EXT.test(target)) return target;
    }
  }
  MD_IMG_RE.lastIndex = 0;
  const mm = MD_IMG_RE.exec(source);
  if (mm && mm[1]) return mm[1].trim();
  return null;
}

// #tags — a hash directly followed by a word (no space), not a Markdown heading
// (headings have a space after the hashes) and not a fenced code block.
const TAG_RE = /(?:^|\s)#([A-Za-z][\w/-]*)/g;

export function extractTags(source: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  // strip fenced code blocks so #comments inside code aren't treated as tags
  const cleaned = source.replace(/```[\s\S]*?```/g, "");
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(cleaned))) out.add(m[1]);
  return [...out];
}
