import type { NoteMeta, VaultFile } from "../types";
import { codeLineScanner } from "./markdownCode";
import { backlinksFor, makeResolver } from "./graph";
import {
  DEFAULT_DEEP_RESEARCH_LIMITS,
  clampDepth,
  truncateUtf8,
  utf8ByteLength,
  type DeepResearchLimits,
  type ResearchDepth,
} from "./deepResearchConfig";
import { safeNoteTitle } from "./deepResearchNaming";
// Startup-safe module; this lazy module shares its one canonicalization.
import { canonicalizeSourceUrl } from "./deepResearchUrls";

/** Pure research models, context selection, result validation, and deterministic apply planning.
 * Treat vault and web content as data. Side effects and recovery belong to the run driver.
 * Graph, naming, prompt and change-set logic live in their own deepResearch* modules; this module
 * re-exports them so lazy importers load one entry point. */

export {
  DEFAULT_DEEP_RESEARCH_LIMITS,
  RESEARCH_DEPTH_PRESETS,
  DEPTH_LIMITS,
  clampDepth,
  depthForPreset,
  limitsForDepth,
  utf8ByteLength,
  truncateUtf8,
  type DeepResearchLimits,
  type ResearchDepth,
  type ResearchDepthPreset,
} from "./deepResearchConfig";
export {
  buildResearchGraph,
  type ResearchGraphEdge,
  type ResearchGraphLayout,
  type ResearchGraphModel,
  type ResearchGraphNode,
  type ResearchGraphNodeKind,
  type ResearchGraphSource,
} from "./deepResearchGraph";
export { safeFolderName, safeNoteTitle, titleSlug } from "./deepResearchNaming";
export { buildResearchPrompt } from "./deepResearchPrompt";
export { buildChangeSet, type ResearchChangeSet } from "./deepResearchChangeSet";
export type { ProposedOp } from "./researchApplyPlan";

// ---------------------------------------------------------------------------
// Run model
// ---------------------------------------------------------------------------

export type DeepResearchPhase =
  | "idle"
  | "planning"
  | "researching"
  | "synthesizing"
  | "review"
  | "applying"
  | "done"
  | "error"
  | "cancelled";

/** Which boundary the current run has reached before research activity exists. */
export type DeepResearchLaunchStage =
  | "idle"
  | "preparing"
  | "restarting-pi"
  | "starting-pi"
  | "bridge-ready"
  | "submitting"
  | "waiting-for-model"
  | "active"
  | "finishing"
  | "review"
  | "applying"
  | "done"
  | "error"
  | "cancelled";

/** Live, user-visible activity during a run — what the agent is doing now. */
export type ResearchActivityKind =
  | "plan"       // sub-question set announced
  | "round"      // started a new breadth/verification/synthesis pass
  | "subquestion"// started researching a sub-question
  | "search"     // ran a web search (query parsed from the search-engine URL)
  | "source"     // opened a source
  | "note"       // finished reading/summarizing a source
  | "synthesize" // assembling notes/report
  | "status";    // generic status line

export interface ResearchActivity {
  kind: ResearchActivityKind;
  message: string;
  /** Sub-question this activity belongs to, when relevant. */
  subQuestion?: string;
  /** One-based research round this activity belongs to, when relevant. */
  round?: number;
  /** Source URL being opened/read, when relevant. */
  sourceUrl?: string;
  /** Source title, when known. */
  sourceTitle?: string;
  /**
   * True when Mesa OBSERVED this activity itself (a brokered browser
   * navigation) rather than trusting the model's self-reported progress call.
   */
  observed?: boolean;
  /** Monotonic timestamp (ms) for ordering/display. */
  at: number;
}

export type SourceKind = "verified" | "inference" | "conflict" | "unknown";

export interface SourceRecord {
  url: string;
  title: string;
  /** Publication/retrieval date string if the model found one. */
  date?: string;
}

export interface ResearchClaim {
  text: string;
  kind: SourceKind;
  /** Canonical URL that backs this claim, when there is one. */
  sourceUrl?: string;
}

export interface ProposedNote {
  title: string;
  markdown: string;
  /** Canonical source URL this note summarizes, when it is a source note. */
  sourceUrl: string | null;
  /** Additional `[[targets]]` the note should link to. */
  links: string[];
}

export interface RelatedNote {
  relPath: string;
  reason: string;
  /**
   * Optional source-backed addition for the existing note. Mesa applies it
   * only when confidence is high and at least one cited source survives
   * validation; a reason/backlink alone never mutates an existing note.
   */
  update?: {
    markdown: string;
    sourceUrls: string[];
    confidence: "high" | "medium" | "low";
  };
}

export interface DeepResearchResult {
  version: 1;
  /** The sub-questions the agent expanded the query into. */
  subQuestions?: string[];
  report: { title: string; markdown: string };
  notes: ProposedNote[];
  sources: SourceRecord[];
  claims: ResearchClaim[];
  related: RelatedNote[];
}

export interface DeepResearchContextNote {
  relPath: string;
  title: string;
  tags: string[];
  content: string;
  /** Why this note was selected (active/selected/backlink/outgoing/tag/search). */
  via: string[];
  /** True when credential-like values were removed before model injection. */
  redacted?: boolean;
}

/** workspace selects active, selected, and directly linked notes; vault also searches shared tags and content.
 * Both scopes report omissions when context limits apply. */
export type ResearchContextScope = "workspace" | "vault";

export interface DeepResearchContext {
  query: string;
  scope: ResearchContextScope;
  notes: DeepResearchContextNote[];
  totalBytes: number;
  truncated: boolean;
  omittedNotes: number;
  /** One-line human summary shown in the UI and prepended to the prompt. */
  summary: string;
}

// ---------------------------------------------------------------------------
// URL canonicalization + source dedup
// ---------------------------------------------------------------------------

export { canonicalizeSourceUrl };

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
const textField = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

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

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

export interface BuildContextInput {
  query: string;
  activePath: string | null;
  selectedPaths: string[];
  files: VaultFile[];
  notes: Record<string, NoteMeta>;
  content: Record<string, string>;
  limits: DeepResearchLimits;
  /** Context gathering scope; defaults to `workspace`. */
  scope?: ResearchContextScope;
}

function isHiddenArtifact(rel: string): boolean {
  // Dot-prefixed segment anywhere in the path: `.file.md`, `.folder/note.md`,
  // and `.name.ext.mesa-save-…tmp` write artifacts all stay out of context —
  // they are either Mesa's in-flight write machinery or private/credential
  // material that must never be injected into the model.
  const parts = rel.split("/");
  if (parts.some((seg) => seg.startsWith("."))) return true;
  const base = (parts[parts.length - 1] ?? "").toLowerCase().replace(/\.(?:md|markdown|txt)$/i, "");
  return /^(?:credentials?|secrets?|api[-_ ]?keys?|private[-_ ]?keys?|tokens?|passwords?|auth)$/.test(base);
}

/** Remove credential-shaped values while preserving surrounding note prose. */
export function redactResearchContent(content: string): { content: string; redacted: boolean } {
  let redacted = false;
  const replace = (pattern: RegExp, replacement: string | ((...args: string[]) => string)) => {
    content = content.replace(pattern, (...args) => {
      redacted = true;
      return typeof replacement === "string" ? replacement : replacement(...(args as string[]));
    });
  };
  replace(
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
    "[REDACTED PRIVATE KEY]"
  );
  replace(
    /^([^\S\r\n\u2028\u2029]*(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|sync[_ -]?key|secret|password|private[_ -]?key)\s*[:=]\s*)(\S.*)$/gim,
    (...args) => `${args[1]}[REDACTED]`
  );
  replace(
    /\b(?:AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
    "[REDACTED CREDENTIAL]"
  );
  replace(
    /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\b/g,
    "[REDACTED CREDENTIAL]"
  );
  return { content, redacted };
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "by", "at", "as", "it", "its", "this",
  "that", "what", "how", "why", "when", "where", "which", "who", "does",
  "do", "did", "from", "about", "into", "over", "under", "between",
]);

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 8);
}

/** Select active, explicit, and neighbouring notes first; vault scope adds shared-tag and content matches.
 * Exclude hidden paths, deduplicate, cap notes/bytes, and report truncation. */
export function buildResearchContext(input: BuildContextInput): DeepResearchContext {
  const { query, activePath, selectedPaths, notes, content, limits } = input;
  const scope: ResearchContextScope = input.scope ?? "workspace";
  const mdFiles = input.files.filter((f) => f.isMarkdown && !isHiddenArtifact(f.relPath));
  const byRel = new Map(mdFiles.map((f) => [f.relPath, f]));

  const picked = new Map<string, DeepResearchContextNote>();
  const via = (rel: string, why: string) => {
    const cur = picked.get(rel);
    if (cur) {
      if (!cur.via.includes(why)) cur.via.push(why);
    }
  };

  const add = (rel: string, why: string): boolean => {
    const f = byRel.get(rel);
    const meta = notes[rel];
    if (!f || !meta) return false;
    if (picked.has(rel)) {
      via(rel, why);
      return true;
    }
    const safe = redactResearchContent(content[rel] ?? "");
    picked.set(rel, {
      relPath: rel,
      title: meta.title,
      tags: meta.tags,
      content: safe.content,
      via: [why],
      redacted: safe.redacted || undefined,
    });
    return true;
  };

  // 1. Active + selected — always first, never dropped.
  if (activePath) add(activePath, "active");
  for (const rel of selectedPaths) add(rel, "selected");

  // 2. Backlinks into the active note, and its outgoing links.
  if (activePath && notes[activePath]) {
    for (const src of backlinksFor(notes, activePath)) add(src, "backlink");
    // One index for every outgoing link — `resolveTarget` would rebuild it per
    // link, which is O(notes) each time on a note that can carry hundreds.
    const resolve = makeResolver(notes);
    for (const raw of notes[activePath].rawLinks) {
      const tgt = resolve(raw);
      if (tgt) add(tgt, "outgoing");
    }
  }

  // Vault scope only: mine the rest of the vault. Workspace scope stops at
  // what the user's surfaces are showing — no whole-vault sweeps.
  if (scope === "vault") {
    // 3. Notes sharing a tag with any already-picked note.
    const pickedTags = new Set<string>();
    for (const n of picked.values()) for (const t of n.tags) pickedTags.add(t);
    if (pickedTags.size) {
      for (const f of mdFiles) {
        const meta = notes[f.relPath];
        if (meta && meta.tags.some((t) => pickedTags.has(t))) add(f.relPath, "tag");
      }
    }

    // 4. Bounded content search over the remaining notes.
    const terms = queryTerms(query);
    if (terms.length) {
      for (const f of mdFiles) {
        if (picked.has(f.relPath)) continue;
        const text = (content[f.relPath] ?? "").toLowerCase();
        const name = f.name.toLowerCase();
        if (terms.some((t) => text.includes(t) || name.includes(t))) add(f.relPath, "search");
      }
    }
  }

  // Enforce caps deterministically: keep insertion order (active/selected win).
  const all = [...picked.values()];
  const kept: DeepResearchContextNote[] = [];
  let totalBytes = 0;
  let omitted = 0;
  let truncated = false;
  for (let i = 0; i < all.length; i++) {
    const n = all[i];
    if (i >= limits.maxContextNotes) {
      omitted++;
      truncated = true;
      continue;
    }
    let body = n.content;
    if (utf8ByteLength(body) > limits.maxNoteBytes) {
      body = truncateUtf8(body, limits.maxNoteBytes);
      truncated = true;
    }
    const bodyBytes = utf8ByteLength(body);
    if (totalBytes + bodyBytes > limits.maxTotalBytes) {
      omitted++;
      truncated = true;
      continue;
    }
    totalBytes += bodyBytes;
    kept.push({ ...n, content: body });
  }

  const summary =
    `${kept.length} note${kept.length === 1 ? "" : "s"} in context` +
    (truncated ? ` (${omitted} omitted, ${totalBytes} B, truncated)` : `, ${totalBytes} B`);

  return { query, scope, notes: kept, totalBytes, truncated, omittedNotes: omitted, summary };
}

// ---------------------------------------------------------------------------
// Result validation
// ---------------------------------------------------------------------------

/** Validate run identity, structure, and limits before producing a change set; deduplicate sources and retain uncertainty. */
export function validateResearchResult(
  result: DeepResearchResult,
  limits: DeepResearchLimits = DEFAULT_DEEP_RESEARCH_LIMITS
): DeepResearchResult {
  const rawSources = Array.isArray(result.sources) ? result.sources : [];
  const sources = dedupeSources(rawSources).slice(0, limits.maxSources);
  const byUrl = new Map<string, SourceRecord>();
  for (const source of sources) {
    byUrl.set(source.url, source);
  }

  const claims: ResearchClaim[] = (Array.isArray(result.claims) ? result.claims : [])
    .filter((c) => typeof c?.text === "string" && c.text.trim())
    .map((c) => {
      const sourceUrl = canonicalizeSourceUrl(textField(c.sourceUrl));
      const validSourceUrl = sourceUrl && byUrl.has(sourceUrl) ? sourceUrl : undefined;
      const rawKind =
        c.kind === "verified" || c.kind === "inference" || c.kind === "conflict" || c.kind === "unknown"
          ? c.kind
          : "unknown";
      return {
        text: c.text.trim(),
        kind: rawKind === "verified" && !validSourceUrl ? "unknown" : rawKind,
        sourceUrl: validSourceUrl,
      };
    });

  const report = {
    title: safeNoteTitle(typeof result.report?.title === "string" ? result.report.title : "Deep Research"),
    markdown: truncateUtf8(
      redactResearchContent(String(result.report?.markdown ?? "")).content,
      limits.maxReportBytes
    ),
  };
  let generatedBytesRemaining = Math.max(
    0,
    limits.maxGeneratedTotalBytes - utf8ByteLength(report.markdown)
  );

  const notes: ProposedNote[] = (Array.isArray(result.notes) ? result.notes : [])
    .filter((n) => typeof n?.title === "string" && n.title.trim() && typeof n?.markdown === "string")
    .slice(0, limits.maxGeneratedNotes)
    .map((n) => ({
      title: safeNoteTitle(n.title),
      markdown: truncateUtf8(
        redactResearchContent(n.markdown).content,
        Math.min(limits.maxGeneratedNoteBytes, generatedBytesRemaining)
      ),
      sourceUrl: canonicalizeSourceUrl(textField(n.sourceUrl)),
      links: Array.isArray(n.links) ? n.links.filter((l) => typeof l === "string") : [],
    }))
    // A source note must point at one of the surviving, validated sources.
    // Non-source synthesis notes may use sourceUrl=null.
    .filter((n) => !n.sourceUrl || byUrl.has(n.sourceUrl))
    .filter((n) => {
      const bytes = utf8ByteLength(n.markdown);
      if (!n.markdown || bytes > generatedBytesRemaining) return false;
      generatedBytesRemaining -= bytes;
      return true;
    });

  const relatedSeen = new Set<string>();
  const related: RelatedNote[] = (Array.isArray(result.related) ? result.related : [])
    .filter((r) => typeof r?.relPath === "string" && r.relPath.trim())
    .slice(0, limits.maxRelated)
    .map((r) => {
      const relPath = r.relPath.trim();
      const rawUpdate = r.update && typeof r.update === "object" ? r.update : undefined;
      const sourceUrls: string[] = [];
      if (rawUpdate && Array.isArray(rawUpdate.sourceUrls)) {
        const seenSources = new Set<string>();
        for (const rawUrl of rawUpdate.sourceUrls) {
          if (typeof rawUrl !== "string") continue;
          const url = canonicalizeSourceUrl(rawUrl);
          if (!url || !byUrl.has(url) || seenSources.has(url)) continue;
          seenSources.add(url);
          sourceUrls.push(url);
        }
      }
      const confidence = rawUpdate?.confidence === "high" || rawUpdate?.confidence === "medium"
        ? rawUpdate.confidence
        : "low";
      const markdown = typeof rawUpdate?.markdown === "string"
        ? truncateUtf8(
            redactResearchContent(rawUpdate.markdown.trim()).content,
            Math.min(limits.maxGeneratedNoteBytes, generatedBytesRemaining)
          )
        : "";
      const usableUpdate = Boolean(markdown && sourceUrls.length);
      if (usableUpdate) generatedBytesRemaining -= utf8ByteLength(markdown);
      return {
        relPath,
        reason: String(r.reason ?? "").trim(),
        update: usableUpdate
          ? { markdown, sourceUrls, confidence }
          : undefined,
      } satisfies RelatedNote;
    })
    .filter((r) => {
      const key = r.relPath.toLowerCase();
      if (relatedSeen.has(key)) return false;
      relatedSeen.add(key);
      return true;
    });

  const subQuestions = Array.isArray(result.subQuestions)
    ? result.subQuestions.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim())
    : [];

  return { version: 1, subQuestions, report, notes, sources, claims, related };
}

/**
 * Fail-closed quality gate for the report handed back by Pi. Prompting alone
 * is not a production guarantee: a result must contain the thesis-grade
 * apparatus the UI promises before Mesa will offer it for review.
 */
export function researchReportQualityIssues(
  result: DeepResearchResult,
  depth: ResearchDepth
): string[] {
  const markdown = result.report.markdown;
  // Only real Markdown headings count. Fenced examples and citations in the
  // next top-level section must not satisfy a missing findings subsection.
  const sections: Array<{ level: number; title: string; body: string }> = [];
  const isCode = codeLineScanner();
  for (const line of markdown.split(/\r?\n/)) {
    if (isCode(line)) continue;
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) sections.push({ level: heading[1].length, title: heading[2].replace(/[*_`]/g, ""), body: "" });
    else if (sections.length) sections[sections.length - 1].body += `${line}\n`;
  }
  const headings = sections.filter((section) => section.level === 2).map((section) =>
    section.title.trim().toLowerCase().replace(/&/g, "and")
  );
  const has = (pattern: RegExp) => headings.some((h) => pattern.test(h));
  const required: Array<[RegExp, string]> = [
    [/^abstract\b/, "Abstract"],
    [/^methodology\b/, "Methodology"],
    [/^findings\b/, "Findings"],
    [/^synthesis\b/, "Synthesis"],
    [/^confidence(?:\s+and)?\s+limitations\b/, "Confidence and limitations"],
    [/^disagreements?\b/, "Disagreements"],
    [/^open questions?\b/, "Open questions"],
  ];
  const issues = required.filter(([pattern]) => !has(pattern)).map(([, label]) => `missing ${label} section`);

  const subHeadings: Array<{ title: string; body: string }> = [];
  let inFindings = false;
  for (const section of sections) {
    if (section.level <= 2) inFindings = section.level === 2 && /^findings\b/i.test(section.title);
    else if (inFindings && section.level === 3) subHeadings.push({ ...section });
    else if (inFindings && subHeadings.length) subHeadings[subHeadings.length - 1].body += section.body;
  }
  const expectedSubQuestions = clampDepth(depth).subQuestions;
  const returnedSubQuestions = result.subQuestions?.length ?? 0;
  if (returnedSubQuestions !== expectedSubQuestions) {
    issues.push(`result defines ${returnedSubQuestions}/${expectedSubQuestions} sub-questions`);
  }
  if (subHeadings.length < expectedSubQuestions) {
    issues.push(`findings cover ${subHeadings.length}/${expectedSubQuestions} sub-questions`);
  }
  const normalizeHeading = (value: string) =>
    value
      .replace(/^\s*\d+[.)\-:]\s*/, "")
      .toLowerCase()
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  const reportUrls = new Set(
    (markdown.match(/https?:\/\/[^\s)\]}>,]+/g) ?? [])
      .map((u) => canonicalizeSourceUrl(u))
      .filter((u): u is string => Boolean(u))
  );
  const sourceUrls = new Set(result.sources.map((source) => source.url));
  for (const question of (result.subQuestions ?? []).slice(0, expectedSubQuestions)) {
    const wanted = normalizeHeading(question);
    const index = subHeadings.findIndex((match) => {
      const heading = normalizeHeading(match.title);
      return Boolean(wanted) && (heading === wanted || heading.startsWith(`${wanted} `));
    });
    if (index < 0) {
      issues.push(`missing findings subsection for sub-question "${question}"`);
      continue;
    }
    const cited = [...(subHeadings[index].body.match(/https?:\/\/[^\s)\]}>,]+/g) ?? [])]
      .map((u) => canonicalizeSourceUrl(u))
      .some((u) => Boolean(u && sourceUrls.has(u)));
    if (!cited) {
      issues.push(`findings subsection for sub-question "${question}" has no source URL citation`);
    }
  }
  if (result.sources.length === 0) {
    issues.push("result contains no validated sources");
  } else {
    const cited = result.sources.some((s) => reportUrls.has(s.url));
    if (!cited) issues.push("findings contain no inline source URL citations");
  }
  if (!result.claims.some((c) => c.kind === "verified" && c.sourceUrl)) {
    issues.push("result contains no source-backed verified claim");
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Transactional apply plan
// ---------------------------------------------------------------------------

export { buildApplyPlan } from "./researchApplyPlan";
export type { ApplyPlan, ApplyStep, RollbackStep } from "./researchApplyPlan";
