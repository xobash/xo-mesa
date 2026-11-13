import type { SourceRecord } from "./deepResearch";
import { canonicalizeSourceUrl } from "./deepResearchUrls";

// Source identity for display and canonical source deduplication.

export interface ResearchSourcePresentation {
  /** Canonical URL copied to the clipboard. */
  url: string;
  /** Compact browser-tab-style site identity. */
  siteName: string;
  host: string;
  /** Human-readable page title, never an opaque URL fallback. */
  pageTitle: string;
  /** Direct site favicon; the UI falls back to `initial` when unavailable. */
  faviconUrl: string;
  initial: string;
}

const RESEARCH_SITE_NAMES: Record<string, string> = {
  "wikipedia.org": "Wikipedia",
  "theguardian.com": "The Guardian",
  "dailymail.co.uk": "Daily Mail",
  "nytimes.com": "The New York Times",
  "washingtonpost.com": "The Washington Post",
  "bbc.com": "BBC",
  "bbc.co.uk": "BBC",
  "reuters.com": "Reuters",
  "apnews.com": "Associated Press",
  "archive.org": "Internet Archive",
  "youtube.com": "YouTube",
};

const COUNTRY_SECOND_LEVELS = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "com.ca", "co.nz"]);

function researchSiteName(host: string): string {
  for (const [domain, name] of Object.entries(RESEARCH_SITE_NAMES)) {
    if (host === domain || host.endsWith(`.${domain}`)) return name;
  }
  const parts = host.split(".").filter(Boolean);
  const suffix = parts.slice(-2).join(".");
  const coreIndex = COUNTRY_SECOND_LEVELS.has(suffix) ? parts.length - 3 : parts.length - 2;
  const core = parts[Math.max(0, coreIndex)] || host;
  return core
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function researchPageTitle(url: URL, rawTitle?: string): string {
  const title = (rawTitle ?? "").trim();
  const titleLooksLikeAddress =
    /^https?:\/\//i.test(title) ||
    title === url.hostname ||
    title.startsWith(`${url.hostname}/`) ||
    (!title.includes(" ") && title.includes("/"));
  if (title && !titleLooksLikeAddress) return title;

  const segments = url.pathname.split("/").filter(Boolean);
  const tail = segments[segments.length - 1] ?? "";
  if (!tail || /^(index|default)(\.[a-z0-9]+)?$/i.test(tail)) return researchSiteName(url.hostname);
  let decoded = tail;
  try {
    decoded = decodeURIComponent(tail);
  } catch {
    /* keep the encoded path segment */
  }
  const readable = decoded
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return readable || researchSiteName(url.hostname);
}

/**
 * Turn a canonical source into a browser-tab-style identity. This is display
 * only: the exact canonical URL remains available for one-click copy.
 */
export function presentResearchSource(rawUrl: string, rawTitle?: string): ResearchSourcePresentation | null {
  const canonical = canonicalizeSourceUrl(rawUrl);
  if (!canonical) return null;
  const url = new URL(canonical);
  const host = url.hostname.replace(/^www\./, "");
  const siteName = researchSiteName(host);
  return {
    url: canonical,
    siteName,
    host,
    pageTitle: researchPageTitle(url, rawTitle),
    faviconUrl: `${url.protocol}//${url.host}/favicon.ico`,
    initial: (siteName.match(/[A-Za-z0-9]/)?.[0] ?? "•").toUpperCase(),
  };
}

/** Text field from untrusted model output; anything other than a string is absent. */
export const textField = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** Canonicalize + dedupe a list of raw sources; drops malformed/duplicate entries and non-text fields. */
export function dedupeSources(raw: readonly unknown[]): SourceRecord[] {
  const seen = new Set<string>();
  const out: SourceRecord[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const record = s as Partial<Record<keyof SourceRecord, unknown>>;
    const url = canonicalizeSourceUrl(textField(record.url));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: textField(record.title) || url, date: textField(record.date) || undefined });
  }
  return out;
}
