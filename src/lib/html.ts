import DOMPurify from "dompurify";
import { mapSrcset } from "./remoteImages";

/** Expand script-free fallbacks before sanitization; promoted URLs still pass the frame policy. */
export function unwrapScriptFallbacks(html: string): string {
  if (!/<noscript\b|data-(?:lazy-)?src|data-original/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const ns of Array.from(doc.querySelectorAll("noscript"))) {
    const img = ns.querySelector("img[src]");
    const prev = ns.previousElementSibling;
    if (img && prev?.tagName === "IMG" &&
        [prev.getAttribute("data-src"), prev.getAttribute("data-lazy-src"), prev.getAttribute("src")].includes(img.getAttribute("src"))) prev.remove();
    ns.replaceWith(...Array.from(ns.childNodes));
  }
  for (const node of doc.querySelectorAll("img,source")) {
    const lazy = node.getAttribute("data-src") ?? node.getAttribute("data-lazy-src") ?? node.getAttribute("data-original");
    const src = node.getAttribute("src");
    if (lazy && (!src || (/^data:/i.test(src) && src.length < 2048))) node.setAttribute("src", lazy);
    if (node.hasAttribute("data-srcset") && !node.hasAttribute("srcset")) node.setAttribute("srcset", node.getAttribute("data-srcset")!);
  }
  // Preserve capture comments used to resolve archived relative URLs.
  const comments = Array.from(doc.childNodes).filter(node => node.nodeType === 8).map(node => `<!--${node.textContent}-->`).join("");
  return `<!doctype html>${comments}${doc.documentElement.outerHTML}`;
}

export type AssetUrlConverter = (path: string) => string;
export type TextAssetReader = (path: string) => Promise<string>;

// Whole-document patterns must stay linear on hostile input. An unterminated
// tag or statement therefore matches to the end (`>?`, `|$`) once instead of
// being rescanned from every later start; replacers leave such matches as-is.
const SAVED_FROM_PREFIX_RE = /<!--\s*saved from url=\(\d+\)/gi;
const ATTR_RE =
  /(\s)(src|href|poster|action)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const SRCSET_RE = /(\s)srcset\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const STYLE_LINK_RE = /<link\b[^>]*>?/gi;
const STYLE_BLOCK_RE = /(<style\b[^>]*>?)([\s\S]*?)(<\/style(?=[\t\n\f\r />])[^>]*>?|$)/gi;
const SCRIPT_TAG_RE = /<script\b([^>]*)(>\s*<\/script>)?/gi;
const FONT_FACE_RULE_RE = /@font-face\s*\{[^{}]*\}/gi;
const CSS_IMPORT_STATEMENT_RE =
  /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^"')\s;]+))\s*\)?([^;]*)(;|$)/gi;
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

const URL_ATTR_ENTITIES: Record<string, string> = { "&amp;": "&", "&#38;": "&", "&quot;": '"', "&#39;": "'" };

/** Decode attribute entities in one pass, so `&amp;quot;` stays the text `&quot;`. */
function decodeUrlAttr(value: string): string {
  return value.replace(/&(?:amp|#38|quot|#39);/g, (entity) => URL_ATTR_ENTITIES[entity]);
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
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
  const re = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tag.match(re);
  if (!match) return null;
  return decodeUrlAttr(match[2] ?? match[3] ?? match[4] ?? "");
}

/** The URL in the first `<!-- saved from url=(N)… -->` comment. */
export function savedFromUrl(html: string): string | null {
  // The value ends at the first ">" after the prefix, which must close "-->".
  // Reuse that position across prefixes so repeated unclosed prefixes stay linear.
  let gt = 0;
  for (const match of html.matchAll(SAVED_FROM_PREFIX_RE)) {
    const start = match.index + match[0].length;
    if (gt >= 0 && gt < start) gt = html.indexOf(">", start);
    if (gt < 0) return null;
    if (gt - 2 - start < 1 || !html.startsWith("-->", gt - 2)) continue;
    const raw = decodeUrlAttr(html.slice(start, gt - 2).trim());
    try {
      return new URL(raw).href;
    } catch {
      return null;
    }
  }
  return null;
}

export interface CssUrlMatch {
  index: number;
  end: number;
  double?: string;
  single?: string;
  bare?: string;
}

const isCssSpace = (c: string) => /\s/.test(c);

/**
 * CSS `url(…)` tokens in one linear pass: `url("…")`, `url('…')` or a bare
 * value up to the first `)`, with surrounding whitespace outside the value.
 */
export function cssUrlMatches(css: string): CssUrlMatch[] {
  const out: CssUrlMatch[] = [];
  const next = new Map<string, number>();
  // indexOf(ch, from) memoized: a miss or a hit beyond `from` stays valid for later `from`.
  const find = (ch: string, from: number) => {
    const known = next.get(ch);
    if (known !== undefined && (known < 0 || known >= from)) return known;
    const at = css.indexOf(ch, from);
    next.set(ch, at);
    return at;
  };
  const opener = /url\(/gi;
  for (let m = opener.exec(css); m; m = opener.exec(css)) {
    let i = m.index + 4;
    while (i < css.length && isCssSpace(css[i])) i++;
    const c = css[i];
    if (c === undefined || c === ")") continue;
    let match: CssUrlMatch | null = null;
    if (c === '"' || c === "'") {
      const close = find(c, i + 1);
      if (close < 0) continue;
      let k = close + 1;
      while (k < css.length && isCssSpace(css[k])) k++;
      if (css[k] !== ")") continue;
      const value = css.slice(i + 1, close);
      match = c === '"' ? { index: m.index, end: k + 1, double: value } : { index: m.index, end: k + 1, single: value };
    } else {
      const close = find(")", i);
      if (close < 0) continue;
      match = { index: m.index, end: close + 1, bare: css.slice(i, close).trimEnd() };
    }
    out.push(match);
    opener.lastIndex = match.end;
  }
  return out;
}

/** Replace every CSS `url(…)` token; the replacer receives the quoted or bare value. */
export function replaceCssUrls(
  css: string,
  replacer: (full: string, doubleValue?: string, singleValue?: string, bareValue?: string) => string
): string {
  const matches = cssUrlMatches(css);
  if (!matches.length) return css;
  let out = "";
  let at = 0;
  for (const m of matches) {
    out += css.slice(at, m.index) + replacer(css.slice(m.index, m.end), m.double, m.single, m.bare);
    at = m.end;
  }
  return out + css.slice(at);
}

const isHtmlSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isAsciiAlpha = (c: number) => (c | 32) >= 97 && (c | 32) <= 122;
const isTagNameEnd = (c: number) => isHtmlSpace(c) || c === 47 || c === 62;

interface ScannedAttr { from: number; name: string; valueFrom: number; valueTo: number; to: number }

/** Read attributes from just after a tag name, following the HTML tokenizer's attribute states. */
function scanTagAttributes(html: string, at: number): { end: number; attrs: ScannedAttr[]; selfClosing: boolean } {
  const attrs: ScannedAttr[] = [];
  const n = html.length;
  let i = at;
  for (;;) {
    const from = i;
    while (i < n && (isHtmlSpace(html.charCodeAt(i)) || (html[i] === "/" && html[i + 1] !== ">"))) i++;
    if (i >= n) return { end: n, attrs, selfClosing: false };
    if (html[i] === "/") return { end: i + 2, attrs, selfClosing: true };
    if (html[i] === ">") return { end: i + 1, attrs, selfClosing: false };
    const nameFrom = i++;
    while (i < n) {
      const c = html.charCodeAt(i);
      if (isTagNameEnd(c) || c === 61) break;
      i++;
    }
    const name = html.slice(nameFrom, i).toLowerCase();
    let j = i;
    while (j < n && isHtmlSpace(html.charCodeAt(j))) j++;
    let valueFrom = -1;
    let valueTo = -1;
    if (html[j] === "=") {
      j++;
      while (j < n && isHtmlSpace(html.charCodeAt(j))) j++;
      const quote = html[j];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, j + 1);
        if (close < 0) return { end: n, attrs, selfClosing: false };
        valueFrom = j + 1;
        valueTo = close;
        i = close + 1;
      } else {
        valueFrom = j;
        while (j < n && !isHtmlSpace(html.charCodeAt(j)) && html[j] !== ">") j++;
        valueTo = i = j;
      }
    }
    attrs.push({ from, name, valueFrom, valueTo, to: i });
  }
}

/** Elements whose content the HTML parser reads as text until the matching end tag. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);
const closeTagPatterns = new Map<string, RegExp>();

function findCloseTag(html: string, name: string, from: number): number {
  let re = closeTagPatterns.get(name);
  if (!re) closeTagPatterns.set(name, re = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi"));
  re.lastIndex = from;
  return re.exec(html)?.index ?? -1;
}

/**
 * Remove preview code with one tokenizer-shaped scan. Tags, comments and
 * raw-text bodies are recognized as the HTML parser reads them, so prose and
 * code samples that only look like attributes or CSS stay intact, and a
 * removal cannot join surrounding text into new markup. Not a sanitizer.
 */
function stripSavedMarkup(html: string, strip: { scripts: boolean; handlers: boolean; fonts: boolean }): string {
  const n = html.length;
  let out = "";
  let copied = 0;
  const replace = (from: number, to: number, text: string) => {
    out += html.slice(copied, from) + text;
    copied = to;
  };
  let foreign = 0;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const next = html.charCodeAt(lt + 1);
    if (next === 33 || next === 63) { // <! and <?
      if (html.startsWith("<!--", lt)) {
        if (html.startsWith("<!-->", lt)) { i = lt + 5; continue; }
        if (html.startsWith("<!--->", lt)) { i = lt + 6; continue; }
        const end = html.indexOf("-->", lt + 4);
        i = end < 0 ? n : end + 3;
        continue;
      }
      const end = html.indexOf(">", lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (next === 47) { // </
      const first = html.charCodeAt(lt + 2);
      if (isAsciiAlpha(first)) {
        let j = lt + 2;
        while (j < n && !isTagNameEnd(html.charCodeAt(j))) j++;
        const name = html.slice(lt + 2, j).toLowerCase();
        if ((name === "svg" || name === "math") && foreign > 0) foreign--;
        i = scanTagAttributes(html, j).end;
        continue;
      }
      if (first === 62) { i = lt + 3; continue; }
      const end = html.indexOf(">", lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (!isAsciiAlpha(next)) { i = lt + 1; continue; }
    let j = lt + 1;
    while (j < n && !isTagNameEnd(html.charCodeAt(j))) j++;
    const name = html.slice(lt + 1, j).toLowerCase();
    const tag = scanTagAttributes(html, j);
    if (strip.scripts && name === "script") {
      const close = findCloseTag(html, "script", tag.end);
      const end = close < 0 ? n : scanTagAttributes(html, close + 8).end;
      // A literal "<" before the removed element must not open a tag with the text after it.
      if (lt > copied ? html[lt - 1] === "<" : out.endsWith("<")) {
        if (lt > copied) replace(lt - 1, lt, "&lt;");
        else out = `${out.slice(0, -1)}&lt;`;
      }
      replace(lt, end, "");
      i = end;
      continue;
    }
    for (const attr of tag.attrs) {
      if (strip.handlers && /^on[a-z0-9_-]+$/.test(attr.name)) {
        // Keep a separator so the neighbouring attribute names cannot merge.
        const after = attr.to < n ? html.charCodeAt(attr.to) : 62;
        replace(attr.from, attr.to, isTagNameEnd(after) ? "" : " ");
      } else if (strip.fonts && attr.name === "style" && attr.valueFrom >= 0) {
        const value = html.slice(attr.valueFrom, attr.valueTo);
        const stripped = value.replace(FONT_FACE_RULE_RE, "");
        if (stripped !== value) replace(attr.valueFrom, attr.valueTo, stripped);
      }
    }
    i = tag.end;
    if (name === "svg" || name === "math") {
      if (!tag.selfClosing) foreign++;
    } else if (name === "plaintext" && foreign === 0) {
      i = n;
    } else if (foreign === 0 && RAW_TEXT_ELEMENTS.has(name)) {
      const close = findCloseTag(html, name, tag.end);
      const contentEnd = close < 0 ? n : close;
      if (strip.fonts && name === "style") {
        const css = html.slice(tag.end, contentEnd);
        const stripped = css.replace(FONT_FACE_RULE_RE, "");
        // Removal can join text into "</style"; escape it so CSS stays inside the element.
        if (stripped !== css) replace(tag.end, contentEnd, escapeStyleText(stripped));
      }
      i = contentEnd;
    }
  }
  return out + html.slice(copied);
}

/** Preview optimization, not a sanitizer. Render only in sandbox="" iframes with the saved-HTML frame policy. */
export function stripSavedHtmlPreviewCode(html: string): string {
  // A saved page's root-relative web fonts cannot resolve inside a local
  // srcDoc preview. Removing the declaration produces the same browser font
  // fallback without issuing a burst of guaranteed-failing requests.
  return stripSavedMarkup(html, { scripts: true, handlers: true, fonts: true });
}

/** Remove only declarations that stylesheet inlining can newly introduce. */
function stripSavedHtmlPreviewInlinedFonts(html: string): string {
  return stripSavedMarkup(html, { scripts: false, handlers: false, fonts: true });
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

/** Total local stylesheet budget per saved document, also enforced before native reads. */
export const MAX_SAVED_HTML_ASSET_CHARS = 4 * 1024 * 1024;

/**
 * Resolve typed local assets. CSS/fonts may traverse inside the approved vault;
 * the native bounded reader enforces that scope. Legacy script inlining stays folder-local.
 */
export function savedHtmlInlineAssetPath(
  rawValue: string,
  documentPath: string,
  kind: "style" | "script" | "font",
  vaultRoot?: string
): string | null {
  const resolved = localSavedHtmlAssetPath(rawValue, documentPath);
  if (!resolved) return null;
  const scope = (kind === "script" ? dirname(documentPath) : vaultRoot ?? dirname(documentPath)).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!resolved.startsWith(scope + "/")) return null;
  const raw = decodeUrlAttr(rawValue.trim())
    .replace(/\\/g, "/")
    .replace(/[?#].*$/, "");
  let depth = 0;
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      depth -= 1;
      if (depth < 0 && kind === "script") return null;
    } else depth += 1;
  }
  const allowed = kind === "style" ? /\.css$/i : kind === "font" ? /\.(woff2?|ttf|otf)$/i : /\.m?js$/i;
  if (!allowed.test(raw)) return null;
  return resolved.replace(/[?#].*$/, "");
}

function rewriteSrcset(
  rawValue: string,
  filePath: string,
  toAssetUrl: AssetUrlConverter,
  originalUrl: string | null,
  archive = false
): string {
  return mapSrcset(rawValue, (url) =>
    archive && originalUrl ? resolveArchiveUrl(url, originalUrl) : rewriteSavedHtmlUrl(url, filePath, toAssetUrl, originalUrl));
}

/** Rewrite saved-page asset references relative to the saved document before framing. */
export function rewriteSavedHtml(
  html: string,
  filePath: string,
  toAssetUrl: AssetUrlConverter
): string {
  const originalUrl = archiveBaseUrl(html);
  const archive = /<!--\s*mesa-archive\s*-->/i.test(html);
  const rewrite = (value: string) => archive && originalUrl
    ? resolveArchiveUrl(value, originalUrl) : rewriteSavedHtmlUrl(value, filePath, toAssetUrl, originalUrl);
  return html
    .replace(
      SRCSET_RE,
      (
        _full,
        prefix: string,
        quoted: string,
        doubleValue?: string,
        singleValue?: string,
        bareValue?: string
      ) => {
      const value = doubleValue ?? singleValue ?? bareValue ?? "";
      const quote = quoted.startsWith("'") ? "'" : '"';
      return `${prefix}srcset=${quote}${escapeAttr(
        rewriteSrcset(value, filePath, toAssetUrl, originalUrl, archive)
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
        singleValue?: string,
        bareValue?: string
      ) => {
        const quote = quoted.startsWith("'") ? "'" : '"';
        const value = doubleValue ?? singleValue ?? bareValue ?? "";
        return `${prefix}${attr}=${quote}${escapeAttr(
          rewrite(value)
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
  return replaceCssUrls(
      css,
      (_full, doubleValue?: string, singleValue?: string, bareValue?: string) => {
        const value = doubleValue ?? singleValue ?? bareValue ?? "";
        const quote = doubleValue !== undefined ? `"` : singleValue !== undefined ? `'` : "";
        const rewritten = rewriteSavedHtmlUrl(value, cssPath, toAssetUrl, originalUrl);
        const safe = /^data:/i.test(rewritten) ? rewritten.replace(/</g, "%3C").replace(/>/g, "%3E") : rewritten;
        return `url(${quote}${safe}${quote})`;
      }
    )
    .replace(
      CSS_IMPORT_RE,
      (_full, doubleValue?: string, singleValue?: string, bareValue?: string) => {
        const value = doubleValue ?? singleValue ?? bareValue ?? "";
        const quote = doubleValue !== undefined ? `"` : singleValue !== undefined ? `'` : "";
        const rewritten = rewriteSavedHtmlUrl(value, cssPath, toAssetUrl, originalUrl);
        const safe = /^data:/i.test(rewritten) ? rewritten.replace(/</g, "%3C").replace(/>/g, "%3E") : rewritten;
        return `@import ${quote}${safe}${quote}`;
      }
    );
}

/** Prepare srcDoc by inlining local stylesheet assets and, when enabled, local scripts. */
export async function hydrateSavedHtml(
  html: string,
  filePath: string,
  toAssetUrl: AssetUrlConverter,
  readTextAsset: TextAssetReader,
  options: { vaultRoot?: string; scripts?: boolean; previewCodeStripped?: boolean; fonts?: { readBytes: (path: string) => Promise<Uint8Array> } } = {}
): Promise<string> {
  html = unwrapScriptFallbacks(html);
  const originalUrl = archiveBaseUrl(html);
  const scripts = options.scripts !== false;
  // Markup-only previews skip script reads. Reuse stripped fallback input and strip again after CSS inlining.
  let out = scripts || options.previewCodeStripped ? html
    : options.fonts ? stripSavedMarkup(html, { scripts: true, handlers: true, fonts: false }) : stripSavedHtmlPreviewCode(html);
  const archive = /<!--\s*mesa-archive\s*-->/i.test(html);
  let fontBytes = 0;
  let fontQueue = Promise.resolve();
  const readFont = (path: string): Promise<string | null> => {
    let result: string | null = null;
    const pending = fontQueue.then(async () => {
      if (fontBytes >= 8 * 1024 * 1024) return;
      try {
        const bytes = await options.fonts!.readBytes(path);
        if (bytes.length > 2 * 1024 * 1024 || fontBytes + bytes.length > 8 * 1024 * 1024) return;
        fontBytes += bytes.length;
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        result = `data:font/${path.split('.').pop()!.toLowerCase()};base64,${btoa(binary)}`;
      } catch { /* omit unreadable fonts */ }
    });
    fontQueue = pending;
    return pending.then(() => result);
  };
  const fonts = async (css: string, owner: string) => replaceAsync(css, FONT_FACE_RULE_RE, async rule => {
    if (!options.fonts || archive) return "";
    let kept = false;
    let failedRead = false;
    const hydrated = await replaceAsync(rule, /(\bsrc\s*:\s*)((?:\([^)]*\)|[^;{}])+)(;?)/gi, async (_m, prefix, sources, semicolon) => {
      const retained: string[] = [];
      for (const source of cssList(sources)) {
        const match = cssUrlMatches(source)[0];
        if (!match) { if (/^\s*local\(/i.test(source)) { retained.push(source); kept = true; } continue; }
        const raw = match.double ?? match.single ?? match.bare ?? "";
        if (/^data:font\//i.test(raw)) { retained.push(source); kept = true; continue; }
        const path = savedHtmlInlineAssetPath(raw, owner, "font", options.vaultRoot ?? dirname(filePath));
        if (!path) continue;
        const data = await readFont(path);
        if (!data) { failedRead = true; continue; }
        retained.push(`${source.slice(0, match.index)}url("${data}")${source.slice(match.end)}`); kept = true;
      }
      return retained.length ? `${prefix}${retained.join(",")}${semicolon}` : "";
    });
    return kept && !failedRead ? hydrated : "";
  });

  let cssChars = 0;
  let cssQueue = Promise.resolve();
  const readCss = (path: string): Promise<string | null> => {
    let result: string | null = null;
    const pending = cssQueue.then(async () => {
      if (cssChars >= MAX_SAVED_HTML_ASSET_CHARS) return;
      try {
        const css = await readTextAsset(path);
        if (cssChars + css.length > MAX_SAVED_HTML_ASSET_CHARS) return;
        cssChars += css.length; result = css;
      } catch { /* omit unavailable stylesheets */ }
    });
    cssQueue = pending;
    return pending.then(() => result);
  };
  const prepareCss = async (css: string, owner: string, depth: number, ancestors: Set<string>): Promise<string> => {
    const expanded = await replaceAsync(css, CSS_IMPORT_STATEMENT_RE, async (statement, dq, sq, bare, qualifiers, end) => {
      if (!end) return statement;
      const raw = dq ?? sq ?? bare ?? "";
      // Web imports remain for the consent-controlled native reader broker.
      if (/^(?:https?:|\/\/)/i.test(raw)) return statement;
      const path = savedHtmlInlineAssetPath(raw, owner, "style", options.vaultRoot ?? dirname(filePath));
      if (!path || depth >= 3 || ancestors.has(path)) return "";
      const imported = await readCss(path);
      if (imported === null) return "";
      const prepared = await prepareCss(imported, path, depth + 1, new Set([...ancestors, path]));
      const condition = qualifiers.trim();
      return !condition ? prepared : /[{};]|^(?:layer|supports)\b/i.test(condition) ? "" : `@media ${condition}{${prepared}}`;
    });
    return rewriteCssAssetUrls(options.fonts ? await fonts(expanded, owner) : expanded, owner, toAssetUrl, originalUrl);
  };
  // Prepare authored styles before replacing links, so inlined sheets keep their own URL base.
  out = await replaceAsync(out, STYLE_BLOCK_RE, async (block, open, css, close) => {
    if (!open.endsWith(">") || !close.endsWith(">")) return block;
    const prepared = archive && originalUrl ? rewriteArchiveCss(css, originalUrl) : await prepareCss(css, filePath, 0, new Set());
    return `${open}${escapeStyleText(prepared)}${close}`;
  });

  out = await replaceAsync(out, STYLE_LINK_RE, async (tag) => {
    if (!tag.endsWith(">")) return tag;
    const rel = (getAttr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("stylesheet") && !(rel.includes("preload") && getAttr(tag, "as")?.toLowerCase() === "style")) return tag;
    const href = getAttr(tag, "href");
    if (!href) return tag;
    const cssPath = savedHtmlInlineAssetPath(href, filePath, "style", options.vaultRoot);
    if (!cssPath) return tag;
    try {
      const css = await readCss(cssPath);
      if (css === null) return tag;
      const rewritten = await prepareCss(css, cssPath, 0, new Set([cssPath]));
      const media = getAttr(tag, "media");
      const mediaAttr = media && !/media/i.test(getAttr(tag, "onload") ?? "") ? ` media="${escapeAttr(media)}"` : "";
      return `<style data-mesa-href="${escapeAttr(href)}"${mediaAttr}>${escapeStyleText(
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
      async (tag, attributes: string, emptyBody?: string) => {
        const source = emptyBody ? /\bsrc=("([^"]*)"|'([^']*)')/i.exec(attributes) : null;
        if (!source) return tag;
        const src = source[2] ?? source[3] ?? "";
        const scriptPath = savedHtmlInlineAssetPath(src, filePath, "script");
        if (!scriptPath) return tag;
        try {
          const script = await readTextAsset(scriptPath);
          if (script.length > MAX_SAVED_HTML_ASSET_CHARS) return tag;
          const attrs = tag
            .replace(/(?<!\s)\s+src=("([^"]*)"|'([^']*)')/i, "")
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

  out = out.replace(/(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi, (_m, prefix, quoted, dq, sq) => {
    const css = decodeUrlAttr(dq ?? sq ?? "");
    const rewritten = archive && originalUrl ? rewriteArchiveCss(css, originalUrl) : rewriteCssAssetUrls(css, filePath, toAssetUrl, originalUrl);
    return `${prefix}${quoted[0]}${escapeAttr(rewritten)}${quoted[0]}`;
  });

  // With scripts disabled, `out` was code-stripped before stylesheet reads.
  // Inlined CSS is wrapped with escapeStyleText, so it cannot close <style>
  // and reintroduce executable markup or event attributes. The only preview
  // construct it can restore is @font-face; scan for just that here instead of
  // walking the multi-megabyte page for scripts and handlers a second time.
  return rewriteSavedHtml(
    scripts || options.fonts ? out : stripSavedHtmlPreviewInlinedFonts(out),
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
    ? "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob: mesa-web: http://mesa-web.localhost https://mesa-web.localhost asset: http://asset.localhost https://asset.localhost; font-src data: mesa-web: http://mesa-web.localhost https://mesa-web.localhost asset: http://asset.localhost https://asset.localhost; connect-src 'none'; media-src data: blob: asset: http://asset.localhost https://asset.localhost; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"
    : "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob: asset: http://asset.localhost https://asset.localhost; font-src data: asset: http://asset.localhost https://asset.localhost; media-src data: blob: asset: http://asset.localhost https://asset.localhost; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  let markup = html;
  {
    const purifier = savedPurifier();
    if (!purifier.isSupported) throw new Error("Safe HTML rendering is unavailable.");
    markup = purifier.sanitize(html, {
      WHOLE_DOCUMENT: true,
      FORBID_TAGS: ["script", "iframe", "frame", "object", "embed", "base", "meta", "form"],
      // Offline links must not navigate the frame out of its document policy.
      FORBID_ATTR: ["href", "xlink:href", "action", "formaction", "ping", "srcdoc", "target"],
      ADD_TAGS: ["style", "use"],
      ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|asset|mesa-web):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    });
  }
  const doc = new DOMParser().parseFromString(markup, "text/html");
  const meta = doc.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy"); meta.setAttribute("content", policy);
  const referrer = doc.createElement("meta");
  referrer.setAttribute("name", "referrer"); referrer.setAttribute("content", "no-referrer");
  doc.head.prepend(meta, referrer);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

function resolveArchiveUrl(raw: string, base: string): string {
  const value = decodeUrlAttr(raw.trim());
  if (SKIP_SCHEME_RE.test(value)) return value;
  try { return new URL(value, base).href; } catch { return value; }
}
function rewriteArchiveCss(css: string, base: string): string {
  return replaceCssUrls(css, (_m, dq, sq, bare) => `url("${resolveArchiveUrl(dq ?? sq ?? bare ?? "", base).replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E")}")`);
}
let purifier: ReturnType<typeof DOMPurify> | undefined;
function savedPurifier() {
  if (!purifier) {
    if (typeof window === "undefined") throw new Error("Safe HTML rendering is unavailable.");
    purifier = DOMPurify(window);
    purifier.addHook("uponSanitizeAttribute", (node, data) => {
      if ((data.attrName === "href" || data.attrName === "xlink:href") &&
          node.namespaceURI === "http://www.w3.org/2000/svg" && /^#[\w.:-]+$/.test(data.attrValue.trim())) data.forceKeepAttr = true;
    });
    purifier.addHook("afterSanitizeAttributes", node => {
      if (node.nodeName.toLowerCase() === "use" && !node.hasAttribute("href") && !node.hasAttribute("xlink:href")) node.remove();
    });
  }
  return purifier;
}

function archiveBaseUrl(html: string): string | null {
  const original = savedFromUrl(html);
  if (!original || !/<!--\s*mesa-archive\s*-->/i.test(html)) return original;
  const tag = html.match(/<base\b[^>]*>?/i)?.[0];
  const href = tag?.endsWith(">") ? getAttr(tag, "href") : null;
  try { return href ? new URL(href, original).href : original; } catch { return original; }
}

/** Split CSS source alternatives without splitting commas inside functions or strings. */
function cssList(value: string): string[] {
  const items: string[] = [];
  let start = 0, depth = 0, quote = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\") { i++; continue; }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) { items.push(value.slice(start, i)); start = i + 1; }
  }
  items.push(value.slice(start));
  return items;
}
