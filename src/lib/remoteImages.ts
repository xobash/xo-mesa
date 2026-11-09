/** Pure remote-image URL helpers. The native broker session and React hook live in components/useRemoteImageRewrite.ts. */

/** Rewrites one remote image URL to a loadable URL, or "" when it must not load. */
export type RemoteImageRewrite = (raw: string) => string;

/** Route an http(s) or protocol-relative URL through the window-owned `mesa-web` broker. */
export function brokerImageUrl(base: string, token: string, raw: string): string {
  const value = raw.trim();
  let url: URL;
  try { url = new URL(/^\/\//.test(value) ? `https:${value}` : value); } catch { return ""; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  return `${base}${token}?u=${encodeURIComponent(url.href)}`;
}

export interface SrcsetCandidate { url: string; descriptors: string[] }

const isSrcsetSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";

/**
 * Parse `srcset` as the HTML standard does: a URL is a run of non-whitespace,
 * so commas inside it (CDN transforms, data URLs) stay part of the URL. A comma
 * separates candidates only at the end of a URL or after its descriptors.
 */
export function parseSrcset(value: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  const n = value.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSrcsetSpace(value[i]) || value[i] === ",")) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !isSrcsetSpace(value[i])) i++;
    let end = i;
    const descriptors: string[] = [];
    if (value[end - 1] === ",") {
      while (end > start && value[end - 1] === ",") end--;
    } else {
      let token = "";
      let inParens = false;
      for (; i < n; i++) {
        const c = value[i];
        if (inParens) { token += c; if (c === ")") inParens = false; continue; }
        if (isSrcsetSpace(c)) { if (token) descriptors.push(token); token = ""; continue; }
        if (c === ",") { i++; break; }
        if (c === "(") inParens = true;
        token += c;
      }
      if (token) descriptors.push(token);
    }
    if (end > start) out.push({ url: value.slice(start, end), descriptors });
  }
  return out;
}

/** Serialize candidates as `url descriptor…, url descriptor…`. */
export function mapSrcset(value: string, rewrite: (url: string) => string): string {
  return parseSrcset(value)
    .map(({ url, descriptors }) => [rewrite(url), ...descriptors].join(" "))
    .join(", ");
}

/** Apply a rewrite to every candidate of a `srcset` value. */
export function rewriteSrcset(value: string, rewrite: RemoteImageRewrite): string {
  // A remote srcset never needs inline data candidates.
  if (/^data:/i.test(value.trim())) return "";
  return mapSrcset(value, rewrite);
}
