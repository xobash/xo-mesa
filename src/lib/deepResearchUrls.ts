import type { ResearchActivity } from "./deepResearch";

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|dclid$|msclkid$|mc_cid$|mc_eid$|igshid$|ref$|ref_src$|spm$)/i;

/**
 * Canonicalize a web URL for dedup and citation: lowercase scheme/host, strip
 * a leading `www.`, drop tracking params, sort the rest, drop the fragment,
 * and drop a trailing slash (except the root). Query values stay encoded, so
 * `?q=a%26b` keeps one parameter. Returns `null` for anything that is not a
 * valid absolute http(s) URL — non-http schemes (file:, javascript:, data:)
 * are rejected outright.
 */
export function canonicalizeSourceUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  let u: URL;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return null;
  const params = new URLSearchParams(
    [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAMS.test(k))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  ).toString();
  let path = u.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}${path}${params ? `?${params}` : ""}`;
}

export function activityForNavigation(rawUrl: string, at: number): ResearchActivity | null {
  const url = canonicalizeSourceUrl(rawUrl);
  if (!url) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const param = host === "duckduckgo.com" || host === "html.duckduckgo.com" || host === "bing.com" || host === "search.brave.com" || host === "ecosia.org" || host === "kagi.com" ? "q"
    : host === "startpage.com" ? "query"
    : (host === "google.com" || host.endsWith(".google.com") || /^google\.[a-z.]+$/.test(host)) && parsed.pathname.startsWith("/search") ? "q" : null;
  const query = param ? parsed.searchParams.get(param)?.trim() : null;
  if (query) return { kind: "search", message: `Searched for “${query}”`, sourceUrl: url, observed: true, at };
  const label = parsed.hostname + (parsed.pathname === "/" ? "" : parsed.pathname);
  return { kind: "source", message: `Opened ${label}`, sourceUrl: url, sourceTitle: label, observed: true, at };
}
