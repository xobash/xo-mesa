import MarkdownIt from "markdown-it";
import DOMPurify, { type Config } from "dompurify";
import { IMAGE_EXT, parseFrontmatter } from "./markdownExtract";

/**
 * Markdown renderer with Obsidian-style extensions:
 *   [[Note]]            -> internal link
 *   [[Note|alias]]      -> internal link with alias
 *   ![[image.png]]      -> embedded image (resolved against the vault later)
 *   ![[Note]]           -> transclusion placeholder
 * Raw HTML is intentionally allowed (`html: true`) so notes can embed markup —
 * this is what powers HTML support in the preview and hover cards. Because
 * `renderMarkdown`'s output is injected with `dangerouslySetInnerHTML`
 * (MarkdownView) and the app runs in a Tauri webview where an inline event
 * handler could reach `window.__TAURI_INTERNALS__.invoke` (arbitrary fs access
 * under the `**` fs scope), the rendered HTML is sanitized before it leaves
 * this module — see `sanitizeHtml`. Note bytes are not always trusted: they can
 * arrive from an imported vault, a synced peer device, or an AI agent that
 * fetched web content.
 *
 * This module owns rendering ONLY. It carries the heavy dependencies
 * (markdown-it + dompurify and their transitive entities/linkify-it/uc.micro/
 * mdurl/punycode, ~120 kB minified), so it is loaded on demand by
 * `components/MarkdownView.tsx` and must stay out of the startup bundle.
 * Scan-time metadata extraction is dependency-free and lives in
 * `markdownExtract.ts`; `markdownLoadContract.test.ts` pins both halves.
 */
const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
});

// DOMPurify config: keep the benign formatting HTML notes legitimately use
// (including the wikilink spans/anchors Mesa emits with `data-target`, image
// `data-embed`, and callout `data-callout` — all `data-*` are kept by
// ALLOW_DATA_ATTR), but strip script execution vectors. `<script>`, every
// `on*` handler, and `javascript:`/`vbscript:` URLs are removed by DOMPurify's
// defaults; we additionally forbid framing/plugin tags that could load an
// active document inside the trusted app origin. Real `.html` vault files are
// rendered separately in a sandboxed cross-origin iframe (HtmlView), not here.
const SANITIZE_CONFIG: Config = {
  FORBID_TAGS: ["style", "iframe", "frame", "object", "embed", "base", "form"] as string[],
  FORBID_ATTR: ["srcdoc", "form", "formaction"] as string[],
  // Vault-relative URLs (e.g. src="images/x.png") must survive so MarkdownView
  // can rewrite them to asset URLs; DOMPurify keeps them and drops dangerous
  // schemes via its default URI policy.
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

/**
 * Sanitize rendered-markdown HTML for safe injection into the trusted app
 * document. Exported so both the renderer and its tests exercise the exact
 * same policy. In a DOM-less environment (e.g. a node-only test) DOMPurify is
 * unsupported and returns the input unchanged; every real caller (the Tauri
 * webview, and the jsdom-backed sanitizer tests) has a DOM.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

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
  return sanitizeHtml(propsHtml + md.render(transformCallouts(body)));
}
