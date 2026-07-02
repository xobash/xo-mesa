export type AssetUrlConverter = (path: string) => string;
export type TextAssetReader = (path: string) => Promise<string>;

const SAVED_FROM_RE = /<!--\s*saved from url=\(\d+\)([^>]+?)\s*-->/i;
const ATTR_RE =
  /(\s)(src|href|poster|action)=("([^"]*)"|'([^']*)')/gi;
const SRCSET_RE = /(\s)srcset=("([^"]*)"|'([^']*)')/gi;
const STYLE_LINK_RE = /<link\b(?=[^>]*\brel=(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*'|[^\s>]*stylesheet[^\s>]*))[^>]*>/gi;
const SCRIPT_TAG_RE = /<script\b[^>]*\bsrc=("([^"]*)"|'([^']*)')[^>]*>\s*<\/script>/gi;
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

export function countStylesheetLinks(html: string): number {
  return [...html.matchAll(new RegExp(STYLE_LINK_RE.source, "gi"))].length;
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

/**
 * Saved webpages are usually an HTML file plus a sibling `*_files` directory.
 * Tauri's asset protocol can serve those files, but root-relative URLs still
 * point at the app origin and many webviews do not resolve the saved-page
 * directory the same way a browser's `file://` loader does. Rewriting makes
 * the local dependency graph explicit before the iframe renders it.
 */
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

/**
 * Fully prepares browser-saved pages for an iframe `srcDoc`. Some webviews do
 * not reliably fetch `asset://` stylesheet links from `about:srcdoc`, so local
 * saved CSS is inlined before render. Script chunks are inlined too when they
 * are local sibling files, which makes saved Next/Vite-style pages behave much
 * closer to opening the HTML directly in a browser.
 */
export async function hydrateSavedHtml(
  html: string,
  filePath: string,
  toAssetUrl: AssetUrlConverter,
  readTextAsset: TextAssetReader
): Promise<string> {
  const originalUrl = savedFromUrl(html);
  let out = html;

  out = await replaceAsync(out, STYLE_LINK_RE, async (tag) => {
    const href = getAttr(tag, "href");
    if (!href) return tag;
    const cssPath = localSavedHtmlAssetPath(href, filePath);
    if (!cssPath) return tag;
    try {
      const css = await readTextAsset(cssPath);
      const rewritten = rewriteCssAssetUrls(css, cssPath, toAssetUrl, originalUrl);
      return `<style data-mesa-href="${escapeAttr(href)}">${escapeStyleText(
        rewritten
      )}</style>`;
    } catch {
      return tag;
    }
  });

  out = await replaceAsync(
    out,
    SCRIPT_TAG_RE,
    async (tag, quoted: string, doubleValue?: string, singleValue?: string) => {
      const src = doubleValue ?? singleValue ?? quoted.slice(1, -1);
      const scriptPath = localSavedHtmlAssetPath(src, filePath);
      if (!scriptPath) return tag;
      try {
        const script = await readTextAsset(scriptPath);
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

  return rewriteSavedHtml(out, filePath, toAssetUrl);
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
