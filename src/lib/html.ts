import DOMPurify from "dompurify";

export type AssetUrlConverter = (path: string) => string;
export type TextAssetReader = (path: string) => Promise<string>;

const SAVED_FROM_RE = /<!--\s*saved from url=\(\d+\)([^>]+?)\s*-->/i;
const ATTR_RE =
  /(\s)(src|href|poster|action)=("([^"]*)"|'([^']*)')/gi;
const SRCSET_RE = /(\s)srcset=("([^"]*)"|'([^']*)')/gi;
const STYLE_LINK_RE = /<link\b(?=[^>]*\brel=(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*'|[^\s>]*stylesheet[^\s>]*))[^>]*>/gi;
const SCRIPT_TAG_RE = /<script\b[^>]*\bsrc=("([^"]*)"|'([^']*)')[^>]*>\s*<\/script>/gi;
const ALL_SCRIPT_TAG_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const EVENT_HANDLER_ATTR_RE =
  /\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const FONT_FACE_RULE_RE = /@font-face\s*\{[^{}]*\}/gi;
const CSS_URL_RE =
  /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')\s][^)]*?))\s*\)/gi;
const CSS_IMPORT_RE =
  /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^"')\s;]+))\s*\)?/gi;
const SKIP_SCHEME_RE =
  /^(?:#|data:|blob:|mailto:|tel:|javascript:|about:)/i;

function dirname(path: string): string {
  const clean = path.replace(/\\/g, "/");
  const i = clean.lastIndexOf("/");
  return i >= 0 ? clean.slice(0, i) : "";
}

function joinRelative(dir: string, rel: string): string {
  const normalized = rel.replace(/\\/g, "/");
  const base = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const absolute = base.startsWith("/");
  const parts = `${base}/${normalized}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return (absolute ? "/" : "") + out.join("/");
}

function decodeUrlAttr(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeStyleText(value: string): string {
  return value.replace(/<\/style/gi, "<\\/style");
}

function escapeScriptText(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

function getAttr(tag: string, attr: string): string | null {
  const re = new RegExp(`\\b${attr}=("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tag.match(re);
  if (!match) return null;
  return decodeUrlAttr(match[2] ?? match[3] ?? match[4] ?? "");
}

export function savedFromUrl(html: string): string | null {
  const match = html.match(SAVED_FROM_RE);
  if (!match) return null;
  const raw = decodeUrlAttr(match[1].trim());
  try {
    return new URL(raw).href;
  } catch {
    return null;
  }
}

/** Remove code a fully sandboxed markup-only preview can never execute. */
export function stripSavedHtmlPreviewCode(html: string): string {
  return html
    .replace(ALL_SCRIPT_TAG_RE, "")
    .replace(EVENT_HANDLER_ATTR_RE, "")
    // A saved page's root-relative web fonts cannot resolve inside a local
    // srcDoc preview. Removing the declaration produces the same browser font
    // fallback without issuing a burst of guaranteed-failing requests.
    .replace(FONT_FACE_RULE_RE, "");
}

/** Remove only declarations that stylesheet inlining can newly introduce. */
function stripSavedHtmlPreviewInlinedFonts(html: string): string {
  return html.replace(FONT_FACE_RULE_RE, "");
}

export function rewriteSavedHtmlUrl(
  rawValue: string,
  filePath: string,
  toAssetUrl: AssetUrlConverter,
  originalUrl: string | null = null
): string {
  const raw = decodeUrlAttr(rawValue.trim());
  if (!raw || SKIP_SCHEME_RE.test(raw)) return rawValue;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;

  if (raw.startsWith("/")) {
    if (!originalUrl) return raw;
    try {
      return new URL(raw, originalUrl).href;
    } catch {
      return raw;
    }
  }

  return toAssetUrl(joinRelative(dirname(filePath), raw));
}

export function localSavedHtmlAssetPath(
  rawValue: string,
  ownerPath: string
): string | null {
  const raw = decodeUrlAttr(rawValue.trim());
  if (!raw || SKIP_SCHEME_RE.test(raw)) return null;
  if (raw.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  if (raw.startsWith("/")) return null;
  return joinRelative(dirname(ownerPath), raw);
}

/** Largest local stylesheet or script a saved page may pull in. */
export const MAX_SAVED_HTML_ASSET_CHARS = 4 * 1024 * 1024;

/**
 * Resolve a stylesheet or script link for inlining. The path must stay inside
 * the saved document's own folder, so a hostile page cannot make Mesa read
 * other vault notes into itself, and the file must have the expected type.
 */
export function savedHtmlInlineAssetPath(
  rawValue: string,
  documentPath: string,
  kind: "style" | "script"
): string | null {
  const resolved = localSavedHtmlAssetPath(rawValue, documentPath);
  if (!resolved) return null;
  const raw = decodeUrlAttr(rawValue.trim())
    .replace(/\\/g, "/")
    .replace(/[?#].*$/, "");
  let depth = 0;
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      depth -= 1;
      if (depth < 0) return null;
    } else depth += 1;
  }
  const allowed = kind === "style" ? /\.css$/i : /\.m?js$/i;
  if (!allowed.test(raw)) return null;
  return resolved.replace(/[?#].*$/, "");
}

function rewriteSrcset(
  rawValue: string,
  filePath: string,
  toAssetUrl: AssetUrlConverter,
  originalUrl: string | null
): string {
  return rawValue
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return trimmed;
      const parts = trimmed.split(/\s+/);
      const url = parts.shift();
      if (!url) return trimmed;
      return [
        rewriteSavedHtmlUrl(url, filePath, toAssetUrl, originalUrl),
        ...parts,
      ].join(" ");
    })
    .join(", ");
}

function injectBase(html: string, baseHref: string): string {
  if (/<base\b/i.test(html)) return html;
  const tag = `<base href="${escapeAttr(baseHref)}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (head) => `${head}${tag}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (htmlTag) => `${htmlTag}<head>${tag}</head>`);
  }
  return `${tag}${html}`;
}

/** Rewrite saved-page asset references relative to the saved document before framing. */
export function rewriteSavedHtml(
  html: string,
  filePath: string,
  toAssetUrl: AssetUrlConverter
): string {
  const originalUrl = savedFromUrl(html);
  const localBase = toAssetUrl(dirname(filePath) + "/");
  const withBase = injectBase(html, localBase.endsWith("/") ? localBase : `${localBase}/`);

  return withBase
    .replace(
      SRCSET_RE,
      (
        _full,
        prefix: string,
        quoted: string,
        doubleValue?: string,
        singleValue?: string
      ) => {
      const value = doubleValue ?? singleValue ?? "";
      const quote = quoted[0];
      return `${prefix}srcset=${quote}${escapeAttr(
        rewriteSrcset(value, filePath, toAssetUrl, originalUrl)
      )}${quote}`;
      }
    )
    .replace(
      ATTR_RE,
      (
        _full,
        prefix: string,
        attr: string,
        quoted: string,
        doubleValue?: string,
        singleValue?: string
      ) => {
        const quote = quoted[0];
        const value = doubleValue ?? singleValue ?? "";
        return `${prefix}${attr}=${quote}${escapeAttr(
          rewriteSavedHtmlUrl(value, filePath, toAssetUrl, originalUrl)
        )}${quote}`;
      }
    );
}

export function rewriteCssAssetUrls(
  css: string,
  cssPath: string,
  toAssetUrl: AssetUrlConverter,
  originalUrl: string | null = null
): string {
  return css
    .replace(
      CSS_URL_RE,
      (_full, doubleValue?: string, singleValue?: string, bareValue?: string) => {
        const value = doubleValue ?? singleValue ?? bareValue ?? "";
        const quote = doubleValue !== undefined ? `"` : singleValue !== undefined ? `'` : "";
        const rewritten = rewriteSavedHtmlUrl(value, cssPath, toAssetUrl, originalUrl);
        return `url(${quote}${rewritten}${quote})`;
      }
    )
    .replace(
      CSS_IMPORT_RE,
      (_full, doubleValue?: string, singleValue?: string, bareValue?: string) => {
        const value = doubleValue ?? singleValue ?? bareValue ?? "";
        const quote = doubleValue !== undefined ? `"` : singleValue !== undefined ? `'` : "";
        const rewritten = rewriteSavedHtmlUrl(value, cssPath, toAssetUrl, originalUrl);
        return `@import ${quote}${rewritten}${quote}`;
      }
    );
}

/** Prepare srcDoc by inlining local stylesheet assets and, when enabled, local scripts. */
export async function hydrateSavedHtml(
  html: string,
  filePath: string,
  toAssetUrl: AssetUrlConverter,
  readTextAsset: TextAssetReader,
  options: { scripts?: boolean; previewCodeStripped?: boolean } = {}
): Promise<string> {
  const originalUrl = savedFromUrl(html);
  const scripts = options.scripts !== false;
  // Markup-only previews skip script reads. Reuse stripped fallback input and strip again after CSS inlining.
  let out = scripts || options.previewCodeStripped
    ? html
    : stripSavedHtmlPreviewCode(html);

  out = await replaceAsync(out, STYLE_LINK_RE, async (tag) => {
    const href = getAttr(tag, "href");
    if (!href) return tag;
    const cssPath = savedHtmlInlineAssetPath(href, filePath, "style");
    if (!cssPath) return tag;
    try {
      const css = await readTextAsset(cssPath);
      if (css.length > MAX_SAVED_HTML_ASSET_CHARS) return tag;
      const rewritten = rewriteCssAssetUrls(css, cssPath, toAssetUrl, originalUrl);
      return `<style data-mesa-href="${escapeAttr(href)}">${escapeStyleText(
        rewritten
      )}</style>`;
    } catch {
      return tag;
    }
  });

  if (scripts) {
    out = await replaceAsync(
      out,
      SCRIPT_TAG_RE,
      async (tag, quoted: string, doubleValue?: string, singleValue?: string) => {
        const src = doubleValue ?? singleValue ?? quoted.slice(1, -1);
        const scriptPath = savedHtmlInlineAssetPath(src, filePath, "script");
        if (!scriptPath) return tag;
        try {
          const script = await readTextAsset(scriptPath);
          if (script.length > MAX_SAVED_HTML_ASSET_CHARS) return tag;
          const attrs = tag
            .replace(/\s+src=("([^"]*)"|'([^']*)')/i, "")
            .replace(/>\s*<\/script>\s*$/i, "");
          return `${attrs} data-mesa-src="${escapeAttr(src)}">${escapeScriptText(
            script
          )}</script>`;
        } catch {
          return tag;
        }
      }
    );
  }

  // With scripts disabled, `out` was code-stripped before stylesheet reads.
  // Inlined CSS is wrapped with escapeStyleText, so it cannot close <style>
  // and reintroduce executable markup or event attributes. The only preview
  // construct it can restore is @font-face; scan for just that here instead of
  // walking the multi-megabyte page for scripts and handlers a second time.
  return rewriteSavedHtml(
    scripts ? out : stripSavedHtmlPreviewInlinedFonts(out),
    filePath,
    toAssetUrl
  );
}

async function replaceAsync(
  input: string,
  regex: RegExp,
  replacer: (...args: string[]) => Promise<string>
): Promise<string> {
  const matches = [...input.matchAll(regex)];
  if (matches.length === 0) return input;
  const replacements = await Promise.all(
    matches.map((match) => replacer(...(match as unknown as string[])))
  );
  let out = "";
  let last = 0;
  matches.forEach((match, i) => {
    out += input.slice(last, match.index);
    out += replacements[i];
    last = (match.index ?? 0) + match[0].length;
  });
  return out + input.slice(last);
}

/** A dedicated frame policy is applied before any saved markup is parsed. */
export function savedHtmlFrameDocument(html: string, active = false): string {
  const policy = active
    ? "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' https: asset: http://asset.localhost https://asset.localhost; img-src data: blob: https: asset: http://asset.localhost https://asset.localhost; font-src data: https: asset: http://asset.localhost https://asset.localhost; connect-src 'none'; media-src data: blob: https: asset: http://asset.localhost https://asset.localhost; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"
    : "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' asset: http://asset.localhost https://asset.localhost; img-src data: blob: asset: http://asset.localhost https://asset.localhost; font-src data: asset: http://asset.localhost https://asset.localhost; media-src data: blob: asset: http://asset.localhost https://asset.localhost; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  let markup = html;
  {
    if (!DOMPurify.isSupported) throw new Error("Safe HTML rendering is unavailable.");
    markup = DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: true,
      FORBID_TAGS: ["script", "iframe", "frame", "object", "embed", "base", "meta", "form"],
      // Offline links must not navigate the frame out of its document policy.
      FORBID_ATTR: ["href", "action", "formaction", "ping", "srcdoc", "target"],
      ADD_TAGS: ["style"],
    });
  }
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"></head><body>${markup}</body></html>`;
}
