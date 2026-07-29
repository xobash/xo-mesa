import { archiveRelPath } from "./agent";

export interface ArchiveFetchedPage {
  finalUrl: string;
  contentType: string;
  body: string | null;
}

export interface WebArchiveResult {
  sourceUrl: string;
  finalUrl: string;
  relPath: string;
  /** True when Mesa saved a link record because the page body was unavailable. */
  linkRecord: boolean;
  warning?: string;
}

export interface WebArchiveDependencies {
  fetchPage: (url: string) => Promise<ArchiveFetchedPage>;
  writeText: (relPath: string, html: string) => Promise<void>;
}

export interface ResearchSourceArchiveState {
  url: string;
  title?: string;
  status: "reading" | "done";
  archiveStatus?: "saving" | "saved" | "failed";
  archiveRelPath?: string;
  archiveKind?: "page" | "link";
  archiveError?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function savedFromMarker(url: string): string {
  // "--" is not valid inside an HTML comment. Percent-encoding the two
  // hyphens preserves the URL when parsed while keeping the marker valid.
  const commentUrl = url.replace(/--/g, "%2D%2D");
  return `<!-- saved from url=(${String(commentUrl.length).padStart(4, "0")})${commentUrl} -->`;
}

/**
 * Make fetched HTML reopen against its original web location. The saved-from
 * marker is consumed by Mesa's browser/demo renderer; the base element gives
 * the desktop asset-protocol iframe the same relative-URL behavior.
 */
export function prepareArchivedHtml(rawHtml: string, sourceUrl: string): string {
  const marker = savedFromMarker(sourceUrl);
  if (!rawHtml.trim()) return marker;
  if (/<base(?:\s|>)/i.test(rawHtml)) return `${marker}\n${rawHtml}`;
  const base = `<base href="${escapeHtml(sourceUrl)}">`;
  if (/<head(?:\s[^>]*)?>/i.test(rawHtml)) {
    return `${marker}\n${rawHtml.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${base}`)}`;
  }
  return `${marker}\n${base}\n${rawHtml}`;
}

export function archiveLinkRecord(sourceUrl: string, error: unknown): string {
  const safeUrl = escapeHtml(sourceUrl);
  const safeError = escapeHtml(error instanceof Error ? error.message : String(error));
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Archived source link</title>
</head>
<body>
<h1>Archived source link</h1>
<p><a href="${safeUrl}">${safeUrl}</a></p>
<p>Mesa could not save the page body, so it preserved the source link instead.</p>
<p>Error: ${safeError}</p>
</body>
</html>`;
}

/**
 * Shared archive transaction used by the browser's Archive button and Deep
 * Research. Fetch failure is recoverable: Mesa still writes a useful local
 * link record. A vault write failure rejects and must be surfaced by the
 * caller.
 */
export async function archiveWebPage(
  sourceUrl: string,
  dependencies: WebArchiveDependencies,
  options: {
    relPath?: string;
    cachedPage?: ArchiveFetchedPage | null;
    now?: Date;
  } = {}
): Promise<WebArchiveResult> {
  const relPath = options.relPath ?? archiveRelPath(sourceUrl, options.now);
  let finalUrl = sourceUrl;
  let html: string;
  let linkRecord = false;
  let warning: string | undefined;

  try {
    const page = options.cachedPage?.body
      ? options.cachedPage
      : await dependencies.fetchPage(sourceUrl);
    finalUrl = page.finalUrl || sourceUrl;
    if (!page.body?.trim()) {
      throw new Error(`no HTML body (${page.contentType || "unknown content type"})`);
    }
    html = prepareArchivedHtml(page.body, finalUrl);
  } catch (error) {
    linkRecord = true;
    warning = error instanceof Error ? error.message : String(error);
    html = archiveLinkRecord(sourceUrl, error);
  }

  await dependencies.writeText(relPath, html);
  return { sourceUrl, finalUrl, relPath, linkRecord, warning };
}

/**
 * Allocate readable, collision-resistant paths for one accepted source set.
 * A source gets a distinct timestamp second even when the whole set starts
 * archiving at once.
 */
export function researchArchiveRelPaths(
  sourceUrls: string[],
  startedAt: number
): string[] {
  return sourceUrls.map((url, index) =>
    archiveRelPath(url, new Date(startedAt + index * 1000))
  );
}

/**
 * Promote only the validated finish payload's sources into the archive queue.
 * Pages that appeared in the live navigation feed but were not ultimately
 * cited remain visible without being saved.
 */
export function queueAcceptedResearchSources(
  liveSources: ResearchSourceArchiveState[],
  acceptedSources: { url: string; title?: string }[]
): ResearchSourceArchiveState[] {
  const acceptedByUrl = new Map(
    acceptedSources.map((source) => [source.url, source])
  );
  const queued = liveSources.map((source) => {
    const accepted = acceptedByUrl.get(source.url);
    if (!accepted) return source;
    acceptedByUrl.delete(source.url);
    return {
      ...source,
      title: accepted.title || source.title,
      status: "done" as const,
      archiveStatus: "saving" as const,
      archiveRelPath: undefined,
      archiveKind: undefined,
      archiveError: undefined,
    };
  });
  for (const accepted of acceptedByUrl.values()) {
    queued.push({
      url: accepted.url,
      title: accepted.title,
      status: "done",
      archiveStatus: "saving",
    });
  }
  return queued;
}
