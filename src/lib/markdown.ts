import DOMPurify, { type Config } from "dompurify";
import { parseMarkdown } from "./markdownParser";

// Preserve formatting and Mesa data attributes; forbid executable and framing markup.
// The threat boundary and sanitizer limits are documented in docs/security.md.
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
 * same policy. Refuse to render if DOMPurify cannot sanitize in this realm.
 */
export function sanitizeHtml(html: string): string {
  if (!DOMPurify.isSupported) throw new Error("HTML sanitizer is unavailable");
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

/** Synchronous compatibility renderer; always sanitize before DOM insertion. */
export function renderMarkdown(source: string): string {
  return sanitizeHtml(parseMarkdown(source));
}
