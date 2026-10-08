import DOMPurify, { type Config } from "dompurify";
import { parseMarkdown } from "./markdownParser";

// Preserve formatting and Mesa data attributes; forbid executable and framing markup.
// The threat boundary and sanitizer limits are documented in docs/security.md.
const SANITIZE_CONFIG: Config = {
  FORBID_TAGS: ["style", "iframe", "frame", "object", "embed", "base", "form"] as string[],
  // `style` could overlay or hide the app UI from an untrusted note.
  FORBID_ATTR: ["srcdoc", "form", "formaction", "style"] as string[],
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
  DOMPurify.addHook("afterSanitizeAttributes", deferRemoteMedia);
  try {
    return DOMPurify.sanitize(html, SANITIZE_CONFIG);
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes", deferRemoteMedia);
  }
}

const REMOTE_MEDIA_TAGS = new Set(["IMG", "SOURCE", "VIDEO", "AUDIO", "TRACK"]);
const REMOTE_URL_RE = /^\s*(?:https?:)?\/\//i;

/**
 * Remote media would load the moment a note is rendered or hovered, telling a
 * third party the reader's address and timing. Park each remote URL in a
 * `data-remote-*` attribute; MarkdownView restores them after consent.
 */
function deferRemoteMedia(node: Element) {
  if (!REMOTE_MEDIA_TAGS.has(node.tagName)) return;
  for (const name of ["src", "poster", "srcset"]) {
    const value = node.getAttribute(name);
    if (value === null) continue;
    const remote =
      name === "srcset"
        ? value.split(",").some((part) => REMOTE_URL_RE.test(part))
        : REMOTE_URL_RE.test(value);
    if (!remote) continue;
    node.setAttribute(`data-remote-${name}`, value);
    node.removeAttribute(name);
  }
}

/** Synchronous compatibility renderer; always sanitize before DOM insertion. */
export function renderMarkdown(source: string): string {
  return sanitizeHtml(parseMarkdown(source));
}
