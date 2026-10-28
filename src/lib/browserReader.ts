import { replaceCssUrls, unwrapScriptFallbacks } from "./html";
import { rewriteSrcset } from "./remoteImages";
import DOMPurify from "dompurify";

/** The sole executable content in the reader is this Mesa-owned link bridge. */
export const READER_BRIDGE = `<script>
(function () {
  function go(url) { parent.postMessage({ __mesaBrowse: { url: String(url) } }, "*"); }
  function jump(id) {
    var t = document.getElementById(id) || document.getElementsByName(id)[0];
    if (t && t.scrollIntoView) t.scrollIntoView();
  }
  document.addEventListener("click", function (e) {
    var el = e.target;
    var a = el && el.closest ? el.closest("a[href]") : null;
    if (!a) return;
    e.preventDefault();
    var raw = a.getAttribute("href") || "";
    if (raw.charAt(0) === "#") { try { jump(decodeURIComponent(raw.slice(1))); } catch (_) {} return; }
    if (a.href) go(a.href);
  }, true);
  var start = document.documentElement.getAttribute("data-mesa-fragment");
  if (start) addEventListener("load", function () { try { jump(decodeURIComponent(start)); } catch (_) {} });
})();
</${"script"}>`;

export const READER_SCRIPT_HASH = "sha256-gG7q72k24KbGKHD4BRn9xaUok2022yKslwchcGrrnvA=";

export function buildReaderHtml(rawHtml: string, baseUrl: string, fragment = new URL(baseUrl).hash.slice(1)): string {
  if (!DOMPurify.isSupported) throw new Error("Safe page rendering is unavailable.");
  const url = new URL(baseUrl);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Unsupported page URL.");
  const markup = DOMPurify.sanitize(unwrapScriptFallbacks(rawHtml), {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["style"],
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|mesa-web):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    FORBID_TAGS: ["script", "iframe", "frame", "object", "embed", "base", "meta", "form", "link"],
    FORBID_ATTR: ["action", "formaction", "ping", "srcdoc", "target"],
  });
  const policy = `default-src 'none'; script-src '${READER_SCRIPT_HASH}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`;
  const document = new DOMParser().parseFromString(markup, "text/html");
  for (const link of document.querySelectorAll("a[href]")) {
    try {
      const target = new URL(link.getAttribute("href")!, url);
      if (/^https?:$/.test(target.protocol)) {
        const page = new URL(url); page.hash = "";
        const owner = new URL(target); owner.hash = "";
        link.setAttribute("href", target.hash && owner.href === page.href ? target.hash : target.href);
      }
      else link.removeAttribute("href");
    } catch { link.removeAttribute("href"); }
  }
  const meta = document.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", policy);
  const referrer = document.createElement("meta");
  referrer.setAttribute("name", "referrer");
  referrer.setAttribute("content", "no-referrer");
  document.head.prepend(meta, referrer);
  document.documentElement.removeAttribute("data-mesa-fragment");
  if (fragment) document.documentElement.setAttribute("data-mesa-fragment", fragment);
  const bridge = document.createElement("script");
  bridge.textContent = READER_BRIDGE.slice("<script>".length, -"</script>".length);
  document.body.append(bridge);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

export interface ReaderStylesheet { css: string; finalUrl: string }
export interface ReaderResources {
  token: string;
  proxyBase: string;
  fetchStylesheet: (url: string) => Promise<string | ReaderStylesheet>;
  deadline?: number;
  allowLocal?: boolean;
  onStats?: (stats: { requested: number; failed: number; timedOut: number }) => void;
}
const RESOURCE_SOURCES = "mesa-web: http://mesa-web.localhost https://mesa-web.localhost";

/** Resolve static assets through the native broker; never send page URLs to the webview. */
export async function prepareReaderResources(rawHtml: string, baseUrl: string, options: ReaderResources): Promise<string> {
  const deadline = options.deadline ?? Date.now() + 6000;
  const document = new DOMParser().parseFromString(unwrapScriptFallbacks(rawHtml), "text/html");
  let base = baseUrl;
  try { base = new URL(document.querySelector("base[href]")?.getAttribute("href") ?? baseUrl, baseUrl).href; } catch { /* use response URL */ }
  const absolute = (raw: string, owner: string) => {
    try { const url = new URL(raw, owner); return /^https?:$/.test(url.protocol) ? url.href : null; } catch { return null; }
  };
  const proxy = (raw: string, owner: string) => {
    if (/^data:/i.test(raw.trim())) return raw.replace(/</g, "%3C").replace(/>/g, "%3E");
    if (/^#/i.test(raw.trim()) || (options.allowLocal && /^(?:asset:\/\/localhost\/|https?:\/\/asset\.localhost\/)/i.test(raw))) return raw;
    const url = absolute(raw, owner);
    return url ? `${options.proxyBase}${options.token}?u=${encodeURIComponent(url)}` : "";
  };
  const rewriteCss = (css: string, owner: string) => replaceCssUrls(css, (_m, dq, sq, bare) => `url("${proxy(dq ?? sq ?? bare ?? "", owner).replace(/"/g, "%22")}")`);
  let sheets = 0;
  const stats = { requested: 0, failed: 0, timedOut: 0 };
  const cssCache = new Map<string, Promise<string | ReaderStylesheet>>();
  // `(;|$)` keeps an unterminated statement linear; it is left as ordinary CSS.
  const importRe = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^"')\s;]+))\s*\)?([^;]*)(;|$)/gi;
  async function stylesheet(url: string, depth: number, ancestors: Set<string>): Promise<string> {
    if (depth > 3 || ancestors.has(url) || sheets >= 30) return "";
    if (Date.now() >= deadline) { stats.requested++; stats.timedOut++; return ""; }
    sheets++;
    stats.requested++;
    try {
      let pending = cssCache.get(url);
      if (!pending) { pending = options.fetchStylesheet(url); cssCache.set(url, pending); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); })]).finally(() => clearTimeout(timer));
      if (result === null) { stats.timedOut++; return ""; }
      const css = typeof result === "string" ? result : result.css;
      const owner = typeof result === "string" ? url : result.finalUrl;
      if (css.length > 2 * 1024 * 1024) { stats.failed++; return ""; }
      let out = "", at = 0;
      for (const match of css.matchAll(importRe)) {
        if (!match[5]) break;
        out += rewriteCss(css.slice(at, match.index), owner);
        const target = absolute(match[1] ?? match[2] ?? match[3], owner);
        const imported = target ? await stylesheet(target, depth + 1, new Set([...ancestors, url])) : "";
        // Preserve ordinary media conditions; unsupported import qualifiers fail closed.
        const condition = match[4].trim();
        out += !condition ? imported : /[{};]|^(?:layer|supports)\b/i.test(condition) ? "" : `@media ${condition}{${imported}}`;
        at = match.index! + match[0].length;
      }
      return out + rewriteCss(css.slice(at), owner);
    } catch { stats.failed++; return ""; }
  }
  for (const style of document.querySelectorAll("style")) {
    // Inline imports also use the broker. A synthetic stylesheet starts with the page base.
    const css = style.textContent ?? "";
    let out = "", at = 0;
    for (const match of css.matchAll(importRe)) {
      if (!match[5]) break;
      out += rewriteCss(css.slice(at, match.index), base);
      const target = absolute(match[1] ?? match[2] ?? match[3], base);
      const imported = target ? await stylesheet(target, 1, new Set()) : "";
      const condition = match[4].trim();
      out += !condition ? imported : /[{};]|^(?:layer|supports)\b/i.test(condition) ? "" : `@media ${condition}{${imported}}`;
      at = match.index! + match[0].length;
    }
    style.textContent = out + rewriteCss(css.slice(at), base);
  }
  const linked = new Set<string>();
  await Promise.all(Array.from(document.querySelectorAll('link[rel~="stylesheet"][href],link[rel~="preload"][as="style"][href]')).map(async link => {
    const target = absolute(link.getAttribute("href")!, base);
    if (!target || linked.has(target) || linked.size >= 30) { link.remove(); return; }
    linked.add(target);
    const style = document.createElement("style");
    style.textContent = target ? await stylesheet(target, 0, new Set()) : "";
    if (link.hasAttribute("media") && !/media/i.test(link.getAttribute("onload") ?? "")) style.setAttribute("media", link.getAttribute("media")!);
    link.replaceWith(style);
  }));
  for (const node of document.querySelectorAll("[src],[poster],[srcset],[style]")) {
    for (const attr of ["src", "poster"]) {
      if (!node.hasAttribute(attr)) continue;
      const value = node.getAttribute(attr)!;
      if (attr === "src" && !["IMG", "SOURCE"].includes(node.tagName)) {
        if (options.allowLocal && ["VIDEO", "AUDIO"].includes(node.tagName) && /^(?:asset:\/\/localhost\/|https?:\/\/asset\.localhost\/|data:|blob:)/i.test(value)) continue;
        node.removeAttribute(attr); continue;
      }
      node.setAttribute(attr, proxy(value, base));
    }
    if (node.hasAttribute("srcset")) {
      const value = node.getAttribute("srcset")!;
      node.setAttribute("srcset", rewriteSrcset(value, url => proxy(url, base)));
    }
    if (node.hasAttribute("style")) node.setAttribute("style", rewriteCss(node.getAttribute("style")!, base));
  }
  for (const link of document.querySelectorAll("a[href]")) {
    const target = absolute(link.getAttribute("href")!, base);
    if (target) link.setAttribute("href", target); else link.removeAttribute("href");
  }
  options.onStats?.({ ...stats });
  return document.documentElement.outerHTML;
}
export async function buildReaderDocument(rawHtml: string, baseUrl: string, options?: ReaderResources, fragment = new URL(baseUrl).hash.slice(1)): Promise<string> {
  if (!options) return buildReaderHtml(rawHtml, baseUrl, fragment);
  const prepared = await prepareReaderResources(rawHtml, baseUrl, options);
  return buildReaderHtml(prepared, baseUrl, fragment).replace("img-src data:;", `img-src data: ${RESOURCE_SOURCES}; font-src data: ${RESOURCE_SOURCES}; media-src 'none';`);
}
