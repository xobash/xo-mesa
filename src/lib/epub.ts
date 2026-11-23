import { bytesToBase64 } from "./base64";
import type { ByteSource } from "./byteSource";
import { replaceCssUrls } from "./htmlCssUrls";
import { escapeStyleText } from "./htmlMarkupStrip";
import { listZipArchive, readZipEntry, type ZipViewEntry } from "./zipView";

/**
 * Read-only EPUB reading. Only the entries a step needs are read (through
 * bounded range reads) and parsed in memory; chapter markup has
 * package images and fonts inlined as data URLs and must still pass through
 * the shared saved-HTML frame purifier (EpubView does this) before display.
 * Nothing outside the package is loaded: other URLs are removed, links do not
 * navigate and scripts never run.
 */
export const EPUB_LIMITS = {
  /** container.xml, the OPF package, nav and NCX documents. */
  maxXmlBytes: 4 * 1024 * 1024,
  maxChapterBytes: 8 * 1024 * 1024,
  /** One image or font. */
  maxResourceBytes: 8 * 1024 * 1024,
  /** All images and fonts inlined into one chapter. */
  maxChapterResourceBytes: 32 * 1024 * 1024,
  /** Package stylesheets inlined into one chapter. */
  maxCssChars: 1024 * 1024,
  maxSpineItems: 5_000,
  maxTocEntries: 5_000,
  maxImagesPerChapter: 2_000,
  /** Declared entry bytes read for one open or one chapter. */
  maxLoadBytes: 48 * 1024 * 1024,
  /** Read-then-parse rounds for one open or chapter (text, styles, images). */
  maxLoadRounds: 6,
} as const;

export interface EpubTocEntry {
  label: string;
  depth: number;
  /** Index into `spine`, or -1 when the target is not a spine document. */
  spineIndex: number;
}

export interface EpubBook {
  title: string;
  creator: string;
  spine: string[];
  toc: EpubTocEntry[];
  source: ByteSource;
  entries: Map<string, ZipViewEntry>;
  /** Package path → declared media type. */
  mediaTypes: Map<string, string>;
}

const OPS_NS = "http://www.idpf.org/2007/ops";
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};

/** Resolves `href` against the package document at `base`. Fragments and
 *  queries are dropped. Absolute, scheme and above-root paths give `null`. */
export function resolveEpubPath(base: string, href: string): string | null {
  let target = href.trim().split("#")[0].split("?")[0];
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/") || target.startsWith("\\")) return null;
  try { target = decodeURIComponent(target); } catch { /* keep a literal % */ }
  const parts = base.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/");
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("This book has a damaged package file.");
  return doc;
}

/**
 * Entry bytes for one open or chapter. The parsing code below is synchronous:
 * a read of an entry not loaded yet records it in `missing` and throws, and
 * `withEntries` loads what was missing and parses again.
 */
interface EntryCache {
  source: ByteSource;
  entries: Map<string, ZipViewEntry>;
  loaded: Map<string, Uint8Array | Error>;
  missing: Map<string, number>;
  loadedBytes: number;
}

function entryCache(source: ByteSource, entries: Map<string, ZipViewEntry>): EntryCache {
  return { source, entries, loaded: new Map(), missing: new Map(), loadedBytes: 0 };
}

function entryBytes(cache: EntryCache, path: string, maxBytes: number): Uint8Array {
  const entry = cache.entries.get(path);
  if (!entry) throw new Error(`This book is missing ${path}.`);
  const got = cache.loaded.get(path);
  if (got instanceof Error) throw got;
  if (got) {
    if (got.length > maxBytes) throw new Error(`${path} is over the ${maxBytes.toLocaleString()}-byte limit.`);
    return got;
  }
  cache.missing.set(path, Math.max(maxBytes, cache.missing.get(path) ?? 0));
  throw new Error(`${path} is not loaded yet.`);
}

/** Reads the entries the last parse asked for, within `maxLoadBytes`. */
async function loadMissing(cache: EntryCache): Promise<void> {
  const wanted = [...cache.missing];
  cache.missing.clear();
  for (const [path, maxBytes] of wanted) {
    const entry = cache.entries.get(path);
    if (!entry) continue;
    if (cache.loadedBytes + entry.size > EPUB_LIMITS.maxLoadBytes) {
      cache.loaded.set(path, new Error("This chapter refers to more data than Mesa reads at once."));
      continue;
    }
    try {
      const bytes = await readZipEntry(cache.source, entry, maxBytes);
      cache.loadedBytes += bytes.length;
      cache.loaded.set(path, bytes);
    } catch (reason) {
      if (reason instanceof Error && reason.name === "FileChangedError") throw reason;
      cache.loaded.set(path, reason instanceof Error ? reason : new Error(String(reason)));
    }
  }
}

/** Runs `parse` until it no longer asks for unloaded entries; bounded rounds. */
async function withEntries<T>(cache: EntryCache, parse: () => T): Promise<T> {
  for (let round = 0; round < EPUB_LIMITS.maxLoadRounds; round++) {
    let result: { value: T } | { error: unknown };
    try {
      result = { value: parse() };
    } catch (error) {
      result = { error };
    }
    if (cache.missing.size === 0) {
      if ("error" in result) throw result.error;
      return result.value;
    }
    await loadMissing(cache);
  }
  throw new Error("This book nests its resources too deeply to show.");
}

function readText(cache: EntryCache, path: string, maxBytes: number): string {
  return new TextDecoder("utf-8").decode(entryBytes(cache, path, maxBytes));
}

function byLocalName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", name));
}

/** Depth from the number of `tag` ancestors below `stop`; bounded climb. */
function ancestorDepth(node: Element, tag: string, stop: Element | null): number {
  let depth = 0;
  let at = node.parentElement;
  for (let guard = 0; at && at !== stop && guard < 256; guard++, at = at.parentElement) {
    if (at.localName === tag) depth++;
  }
  return depth;
}

function navToc(book: EntryCache, navPath: string): Array<{ label: string; depth: number; path: string | null }> {
  const text = readText(book, navPath, EPUB_LIMITS.maxXmlBytes);
  let doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
  if (doc.getElementsByTagName("parsererror").length > 0) doc = new DOMParser().parseFromString(text, "text/html");
  const navs = byLocalName(doc, "nav");
  const nav = navs.find((n) => n.getAttributeNS(OPS_NS, "type") === "toc" || n.getAttribute("epub:type") === "toc") ?? navs[0];
  if (!nav) return [];
  return byLocalName(nav, "a").slice(0, EPUB_LIMITS.maxTocEntries).map((a) => ({
    label: (a.textContent ?? "").replace(/\s+/g, " ").trim(),
    depth: Math.max(0, ancestorDepth(a, "ol", nav) - 1),
    path: resolveEpubPath(navPath, a.getAttribute("href") ?? ""),
  }));
}

function ncxToc(book: EntryCache, ncxPath: string): Array<{ label: string; depth: number; path: string | null }> {
  const doc = parseXml(readText(book, ncxPath, EPUB_LIMITS.maxXmlBytes));
  const map = byLocalName(doc, "navMap")[0] ?? null;
  return byLocalName(doc, "navPoint").slice(0, EPUB_LIMITS.maxTocEntries).map((point) => {
    const label = Array.from(point.children).find((c) => c.localName === "navLabel");
    const content = Array.from(point.children).find((c) => c.localName === "content");
    return {
      label: (label?.textContent ?? "").replace(/\s+/g, " ").trim(),
      depth: ancestorDepth(point, "navPoint", map),
      path: resolveEpubPath(ncxPath, content?.getAttribute("src") ?? ""),
    };
  });
}

/** Opens an EPUB: spine order, title, author and table of contents. Reads
 *  only the directory, container, package and navigation entries. */
export async function openEpub(source: ByteSource): Promise<EpubBook> {
  const listing = await listZipArchive(source);
  const entries = new Map(listing.entries.filter((e) => !e.directory).map((e) => [e.name, e]));
  const shell = entryCache(source, entries);
  return withEntries(shell, () => parsePackage(shell));
}

function parsePackage(shell: EntryCache): EpubBook {
  const { source, entries } = shell;
  const container = parseXml(readText(shell, "META-INF/container.xml", EPUB_LIMITS.maxXmlBytes));
  const opfPath = byLocalName(container, "rootfile")[0]?.getAttribute("full-path") ?? "";
  if (!opfPath || !entries.has(opfPath)) throw new Error("This book does not name a package document.");
  const opf = parseXml(readText(shell, opfPath, EPUB_LIMITS.maxXmlBytes));
  const manifest = new Map<string, { path: string | null; type: string; properties: string }>();
  const mediaTypes = new Map<string, string>();
  for (const item of byLocalName(opf, "item").slice(0, EPUB_LIMITS.maxSpineItems * 4)) {
    const path = resolveEpubPath(opfPath, item.getAttribute("href") ?? "");
    const type = item.getAttribute("media-type") ?? "";
    manifest.set(item.getAttribute("id") ?? "", { path, type, properties: item.getAttribute("properties") ?? "" });
    if (path) mediaTypes.set(path, type);
  }
  const spineEl = byLocalName(opf, "spine")[0];
  const spine: string[] = [];
  for (const ref of byLocalName(opf, "itemref").slice(0, EPUB_LIMITS.maxSpineItems)) {
    const path = manifest.get(ref.getAttribute("idref") ?? "")?.path;
    if (path && entries.has(path) && ref.getAttribute("linear") !== "no") spine.push(path);
  }
  if (spine.length === 0) throw new Error("This book has no readable chapters.");
  const navPath = [...manifest.values()].find((m) => /(^|\s)nav(\s|$)/.test(m.properties))?.path;
  const ncxPath = manifest.get(spineEl?.getAttribute("toc") ?? "")?.path
    ?? [...manifest.values()].find((m) => m.type === "application/x-dtbncx+xml")?.path;
  let raw: Array<{ label: string; depth: number; path: string | null }> = [];
  try {
    if (navPath && entries.has(navPath)) raw = navToc(shell, navPath);
    else if (ncxPath && entries.has(ncxPath)) raw = ncxToc(shell, ncxPath);
  } catch {
    raw = [];
  }
  const spineIndex = new Map(spine.map((path, index) => [path, index]));
  const toc = raw.filter((t) => t.label).map((t) => ({ label: t.label, depth: Math.min(t.depth, 8), spineIndex: t.path ? spineIndex.get(t.path) ?? -1 : -1 }));
  const dc = (name: string) => (opf.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", name)[0]?.textContent ?? "").trim();
  return { title: dc("title"), creator: dc("creator"), spine, toc, source, entries, mediaTypes };
}

/** Inlines package resources as data URLs within the chapter budget. */
function resourceInliner(book: EpubBook, entriesRead: EntryCache) {
  const cache = new Map<string, string | null>();
  let used = 0;
  return (path: string | null): string | null => {
    if (!path) return null;
    if (cache.has(path)) return cache.get(path) ?? null;
    const entry = book.entries.get(path);
    const type = book.mediaTypes.get(path) || IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""] || "";
    let url: string | null = null;
    if (entry && /^(image|font)\//.test(type) && entry.size <= EPUB_LIMITS.maxResourceBytes
      && used + entry.size <= EPUB_LIMITS.maxChapterResourceBytes) {
      try {
        const bytes = entryBytes(entriesRead, path, EPUB_LIMITS.maxResourceBytes);
        used += bytes.length;
        url = `data:${type};base64,${bytesToBase64(bytes)}`;
      } catch {
        url = null;
      }
    }
    cache.set(path, url);
    return url;
  };
}

function rewriteCss(css: string, owner: string, inline: (path: string | null) => string | null): string {
  return replaceCssUrls(css, (_full, dq, sq, bare) => {
    const url = inline(resolveEpubPath(owner, dq ?? sq ?? bare ?? ""));
    return url ? `url("${url}")` : "none";
  });
}

const URL_ATTRS = ["src", "srcset", "poster", "data", "background", "href", "action", "formaction", "cite", "longdesc"];

/**
 * Markup for spine item `index`. Only package images, fonts and stylesheets
 * survive; every other URL attribute is removed. NOT sanitized: callers pass
 * it to the saved-HTML frame purifier and an empty-sandbox frame.
 */
export async function epubChapterMarkup(book: EpubBook, index: number): Promise<string> {
  const cache = entryCache(book.source, book.entries);
  return withEntries(cache, () => chapterMarkup(book, cache, index));
}

function chapterMarkup(book: EpubBook, cache: EntryCache, index: number): string {
  const path = book.spine[index];
  if (path === undefined) throw new Error("This chapter does not exist.");
  const text = readText(cache, path, EPUB_LIMITS.maxChapterBytes);
  let doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
  if (doc.getElementsByTagName("parsererror").length > 0 || !doc.body) doc = new DOMParser().parseFromString(text, "text/html");
  const inline = resourceInliner(book, cache);
  let cssChars = 0;
  const styles: string[] = [];
  const addCss = (css: string, owner: string) => {
    if (cssChars + css.length > EPUB_LIMITS.maxCssChars) return;
    cssChars += css.length;
    styles.push(`<style>${escapeStyleText(rewriteCss(css, owner, inline))}</style>`);
  };
  for (const link of byLocalName(doc, "link")) {
    if (!/(^|\s)stylesheet(\s|$)/i.test(link.getAttribute("rel") ?? "")) continue;
    const cssPath = resolveEpubPath(path, link.getAttribute("href") ?? "");
    const entry = cssPath ? book.entries.get(cssPath) : undefined;
    if (!cssPath || !entry || entry.size > EPUB_LIMITS.maxCssChars) continue;
    try { addCss(readText(cache, cssPath, EPUB_LIMITS.maxCssChars), cssPath); } catch { /* omit a damaged stylesheet */ }
  }
  for (const style of byLocalName(doc, "style")) addCss(style.textContent ?? "", path);
  const body = doc.body ?? byLocalName(doc, "body")[0];
  if (!body) throw new Error("This chapter has no body.");
  const converted = new Set<Element>();
  // SVG cover pages wrap one <image>; the purifier drops its href, so show it as <img>.
  for (const image of Array.from(body.getElementsByTagNameNS(SVG_NS, "image")).slice(0, EPUB_LIMITS.maxImagesPerChapter)) {
    const href = image.getAttribute("href") ?? image.getAttributeNS(XLINK_NS, "href") ?? "";
    const url = inline(resolveEpubPath(path, href));
    const svg = image.closest("svg");
    if (url && svg) {
      const img = doc.createElementNS("http://www.w3.org/1999/xhtml", "img");
      img.setAttribute("src", url);
      img.setAttribute("alt", "");
      svg.replaceWith(img);
      converted.add(img);
    } else image.remove();
  }
  const images = new Map<Element, string | null>();
  for (const img of byLocalName(body, "img").slice(0, EPUB_LIMITS.maxImagesPerChapter)) {
    const src = img.getAttribute("src") ?? "";
    images.set(img, converted.has(img) ? src : inline(resolveEpubPath(path, src)));
  }
  for (const element of Array.from(body.getElementsByTagName("*"))) {
    for (const attr of URL_ATTRS) element.removeAttribute(attr);
    element.removeAttributeNS(XLINK_NS, "href");
    const style = element.getAttribute("style");
    if (style) element.setAttribute("style", rewriteCss(style, path, inline));
  }
  for (const [img, url] of images) if (url) img.setAttribute("src", url);
  const base = "body{max-width:42em;margin:2em auto;padding:0 1.5em;line-height:1.6}img,svg{max-width:100%;height:auto}";
  const serializer = new XMLSerializer();
  return `<!doctype html><html><head><style>${base}</style>${styles.join("")}</head>${serializer.serializeToString(body)}</html>`;
}
