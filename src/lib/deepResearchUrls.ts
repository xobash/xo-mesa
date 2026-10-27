import type { ResearchActivity } from "./deepResearch";

const TRACKING_PARAMS = /^(utm_[^]+|fbclid|gclid|mc_cid|mc_eid)$/i;

export function canonicalizeSourceUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let u: URL;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return null;
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const qs = params.length ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&") : "";
  let path = u.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}${path}${qs}`;
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
