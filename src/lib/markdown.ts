import DOMPurify, { type Config } from "dompurify";
import { parseMarkdown } from "./markdownParser";

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
 * document. DOMPurify requires a DOM; production callers run in the Tauri
 * webview.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

/** Synchronous compatibility renderer; always sanitize before DOM insertion. */
export function renderMarkdown(source: string): string {
  return sanitizeHtml(parseMarkdown(source));
}
