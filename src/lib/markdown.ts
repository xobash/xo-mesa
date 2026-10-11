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

const REMOTE_URL_RE = /^(?:https?:)?\/\//i;
const MEDIA_URL_ATTRIBUTES = ["src", "poster", "background", "data", "href", "xlink:href", "srcset"];
// URL parsing ignores ASCII tabs/newlines; classify before the browser can load.
// eslint-disable-next-line no-control-regex -- Browser URL normalization ignores these characters.
const normalizedMediaUrl = (value: string) => value.replace(/\s/g, "").replace(/[\x00-\x20]/g, "");

/**
 * Remote media would load the moment a note is rendered or hovered, telling a
 * third party the reader's address and timing. Park each remote URL in a
 * `data-remote-*` attribute; MarkdownView restores them after consent.
 */
function deferRemoteMedia(node: Element) {
  // Authored data attributes must never mint consent-restorable URLs.
  for (const name of MEDIA_URL_ATTRIBUTES) node.removeAttribute(`data-remote-${name.replace(":", "-")}`);
  for (const name of MEDIA_URL_ATTRIBUTES) {
    if (name === "href" && node.localName === "a") continue;
    const value = node.getAttribute(name);
    if (value === null) continue;
    const remote =
      name === "srcset"
        ? value.split(",").some((part) => REMOTE_URL_RE.test(normalizedMediaUrl(part)))
        : REMOTE_URL_RE.test(normalizedMediaUrl(value));
    if (!remote) continue;
    node.setAttribute(`data-remote-${name.replace(":", "-")}`, value);
    node.removeAttribute(name);
  }
}

/** Synchronous compatibility renderer; always sanitize before DOM insertion. */
export function renderMarkdown(source: string): string {
  return sanitizeHtml(parseMarkdown(source));
}
