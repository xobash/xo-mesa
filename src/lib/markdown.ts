import MarkdownIt from "markdown-it";

/**
 * Markdown renderer with Obsidian-style extensions:
 *   [[Note]]            -> internal link
 *   [[Note|alias]]      -> internal link with alias
 *   ![[image.png]]      -> embedded image (resolved against the vault later)
 *   ![[Note]]           -> transclusion placeholder
 * Raw HTML is intentionally allowed (`html: true`) so notes can embed markup —
 * this is what powers HTML support in the preview and hover cards.
 */
const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
});

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

// --- inline rule: wiki links & embeds -------------------------------------
function wikilink(state: any, silent: boolean): boolean {
  const src: string = state.src;
  let pos: number = state.pos;
  let embed = false;

  if (src.charCodeAt(pos) === 0x21 /* ! */) {
    if (src.charCodeAt(pos + 1) !== 0x5b || src.charCodeAt(pos + 2) !== 0x5b) return false;
    embed = true;
    pos += 1;
  }
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;

  const close = src.indexOf("]]", pos + 2);
  if (close < 0) return false;

  const inner = src.slice(pos + 2, close);
  if (inner.length === 0 || inner.indexOf("\n") >= 0) return false;

  if (!silent) {
    const bar = inner.indexOf("|");
    const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
    const alias = (bar >= 0 ? inner.slice(bar + 1) : inner).trim();

    if (embed && IMAGE_EXT.test(target)) {
      const token = state.push("wiki_image", "img", 0);
      token.content = target;
      token.meta = { alias };
    } else if (embed) {
      const token = state.push("wiki_embed", "span", 0);
      token.content = target;
      token.meta = { alias };
    } else {
      const token = state.push("wiki_link", "a", 0);
      token.content = target;
      token.meta = { alias };
    }
  }
  state.pos = close + 2;
  return true;
}

md.inline.ruler.before("image", "wikilink", wikilink);

md.renderer.rules.wiki_link = (tokens: any, idx: number): string => {
  const t = tokens[idx];
  const target = md.utils.escapeHtml(t.content);
  const alias = md.utils.escapeHtml(t.meta.alias || t.content);
  return `<a href="#" class="wikilink" data-target="${target}">${alias}</a>`;
};

md.renderer.rules.wiki_image = (tokens: any, idx: number): string => {
  const t = tokens[idx];
  const target = md.utils.escapeHtml(t.content);
  const alias = md.utils.escapeHtml(t.meta.alias || t.content);
  // `src` is filled in by the React layer once the path is resolved.
  return `<img class="md-embed" data-embed="${target}" alt="${alias}" />`;
};

md.renderer.rules.wiki_embed = (tokens: any, idx: number): string => {
  const t = tokens[idx];
  const target = md.utils.escapeHtml(t.content);
  return `<span class="wikilink embed" data-target="${target}">⧉ ${target}</span>`;
};

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

// Obsidian callouts: a blockquote whose first line is `[!type] Optional title`.
function transformCallouts(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^>\s*\[!(\w+)\][+-]?\s*(.*)$/.exec(lines[i]);
    if (m) {
      const type = m[1].toLowerCase();
      const title = (m[2] || type).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      const inner = md.render(body.join("\n"));
      out.push(
        `<div class="callout" data-callout="${md.utils.escapeHtml(type)}">` +
          `<div class="callout-title">${md.utils.escapeHtml(title)}</div>` +
          `${inner}</div>`
      );
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

/** Render markdown (with extensions) to an HTML string. */
export function renderMarkdown(source: string): string {
  const { body, props } = parseFrontmatter(source ?? "");
  const propsHtml = props.length
    ? `<div class="properties">` +
      props
        .map(
          ([k, v]) =>
            `<div class="prop"><span class="prop-key">${md.utils.escapeHtml(
              k
            )}</span><span class="prop-val">${md.utils.escapeHtml(v)}</span></div>`
        )
        .join("") +
      `</div>`
    : "";
  return propsHtml + md.render(transformCallouts(body));
}

// --- lightweight extraction (no full parse) -------------------------------
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
