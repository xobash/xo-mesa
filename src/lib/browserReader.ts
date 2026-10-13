import { CSS_URL_RE } from "./html";
import DOMPurify from "dompurify";

/** The sole executable content in the reader is this Mesa-owned link bridge. */
export const READER_BRIDGE = `<script>
(function () {
  function go(url) { parent.postMessage({ __mesaBrowse: { url: String(url) } }, "*"); }
  document.addEventListener("click", function (e) {
    var el = e.target;
    var a = el && el.closest ? el.closest("a[href]") : null;
    if (!a || !a.href) return;
    e.preventDefault();
    go(a.href);
  }, true);

})();
</${"script"}>`;

export const READER_SCRIPT_HASH = "sha256-8D3rAzMxEvvKvt3xJzilB4qHb/nQ0BCYDIrJyGKgM5g=";

export function buildReaderHtml(rawHtml: string, baseUrl: string): string {
  if (!DOMPurify.isSupported) throw new Error("Safe page rendering is unavailable.");
  const url = new URL(baseUrl);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Unsupported page URL.");
  const markup = DOMPurify.sanitize(rawHtml, {
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
      if (/^https?:$/.test(target.protocol)) link.setAttribute("href", target.href);
      else link.removeAttribute("href");
    } catch { link.removeAttribute("href"); }
  }
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"></head><body>${document.documentElement.innerHTML}${READER_BRIDGE}</body></html>`;
}

export interface ReaderStylesheet { css: string; finalUrl: string }
export interface ReaderResources {
  token: string;
  proxyBase: string;
  fetchStylesheet: (url: string) => Promise<string | ReaderStylesheet>;
  deadline?: number;
  allowLocal?: boolean;
}
export const RESOURCE_SOURCES = "mesa-web: http://mesa-web.localhost https://mesa-web.localhost";

/** Resolve static assets through the native broker; never send page URLs to the webview. */
export async function prepareReaderResources(rawHtml: string, baseUrl: string, options: ReaderResources): Promise<string> {
  const deadline = options.deadline ?? Date.now() + 3000;
  const document = new DOMParser().parseFromString(rawHtml, "text/html");
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
  const rewriteCss = (css: string, owner: string) => css.replace(CSS_URL_RE, (_m, dq, sq, bare) => `url("${proxy(dq ?? sq ?? bare ?? "", owner).replace(/"/g, "%22")}")`);
  let sheets = 0;
  const cssCache = new Map<string, Promise<string | ReaderStylesheet>>();
  const importRe = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^"')\s;]+))\s*\)?([^;]*);/gi;
  async function stylesheet(url: string, depth: number, ancestors: Set<string>): Promise<string> {
    if (depth > 3 || ancestors.has(url) || Date.now() >= deadline || sheets >= 30) return "";
    sheets++;
    try {
      let pending = cssCache.get(url);
      if (!pending) { pending = options.fetchStylesheet(url); cssCache.set(url, pending); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([pending, new Promise<string>(resolve => { timer = setTimeout(() => resolve(""), Math.max(0, deadline - Date.now())); })]).finally(() => clearTimeout(timer));
      const css = typeof result === "string" ? result : result.css;
      const owner = typeof result === "string" ? url : result.finalUrl;
      if (css.length > 2 * 1024 * 1024) return "";
      let out = "", at = 0;
      for (const match of css.matchAll(importRe)) {
        out += rewriteCss(css.slice(at, match.index), owner);
        const target = absolute(match[1] ?? match[2] ?? match[3], owner);
        const imported = target ? await stylesheet(target, depth + 1, new Set([...ancestors, url])) : "";
        // Preserve ordinary media conditions; unsupported import qualifiers fail closed.
        const condition = match[4].trim();
        out += !condition ? imported : /[{};]|^(?:layer|supports)\b/i.test(condition) ? "" : `@media ${condition}{${imported}}`;
        at = match.index! + match[0].length;
      }
      return out + rewriteCss(css.slice(at), owner);
    } catch { return ""; }
  }
  for (const style of document.querySelectorAll("style")) {
    // Inline imports also use the broker. A synthetic stylesheet starts with the page base.
    const css = style.textContent ?? "";
    let out = "", at = 0;
    for (const match of css.matchAll(importRe)) {
      out += rewriteCss(css.slice(at, match.index), base);
      const target = absolute(match[1] ?? match[2] ?? match[3], base);
      const imported = target ? await stylesheet(target, 1, new Set()) : "";
      const condition = match[4].trim();
      out += !condition ? imported : /[{};]|^(?:layer|supports)\b/i.test(condition) ? "" : `@media ${condition}{${imported}}`;
      at = match.index! + match[0].length;
    }
    style.textContent = out + rewriteCss(css.slice(at), base);
  }
  await Promise.all(Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]')).slice(0, 30).map(async link => {
    const target = absolute(link.getAttribute("href")!, base);
    const style = document.createElement("style");
    style.textContent = target ? await stylesheet(target, 0, new Set()) : "";
    if (link.hasAttribute("media")) style.setAttribute("media", link.getAttribute("media")!);
    link.replaceWith(style);
  }));
  for (const node of document.querySelectorAll("img,source")) {
    const lazy = node.getAttribute("data-src") ?? node.getAttribute("data-lazy-src") ?? node.getAttribute("data-original");
    const src = node.getAttribute("src");
    if (lazy && (!src || (/^data:/i.test(src) && src.length < 2048))) node.setAttribute("src", lazy);
    if (node.hasAttribute("data-srcset") && !node.hasAttribute("srcset")) node.setAttribute("srcset", node.getAttribute("data-srcset")!);
  }
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
      // Data URLs contain commas; keeping them in src avoids ambiguous splitting.
      node.setAttribute("srcset", /^data:/i.test(value.trim()) ? "" : value.split(",").map(candidate => {
        const [url, ...descriptor] = candidate.trim().split(/\s+/);
        return [proxy(url, base), ...descriptor].join(" ");
      }).join(", "));
    }
    if (node.hasAttribute("style")) node.setAttribute("style", rewriteCss(node.getAttribute("style")!, base));
  }
  for (const link of document.querySelectorAll("a[href]")) {
    const target = absolute(link.getAttribute("href")!, base);
    if (target) link.setAttribute("href", target); else link.removeAttribute("href");
  }
  return document.documentElement.outerHTML;
}
export async function buildReaderDocument(rawHtml: string, baseUrl: string, options?: ReaderResources): Promise<string> {
  if (!options) return buildReaderHtml(rawHtml, baseUrl);
  const prepared = await prepareReaderResources(rawHtml, baseUrl, options);
  return buildReaderHtml(prepared, baseUrl).replace("img-src data:;", `img-src data: ${RESOURCE_SOURCES}; font-src data: ${RESOURCE_SOURCES}; media-src 'none';`);
}
