import { codeLineScanner } from "./markdownCode";
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
export { dedupeSources, presentResearchSource, type ResearchSourcePresentation } from "./deepResearchSources";
export { buildResearchContext, redactResearchContent, type BuildContextInput } from "./deepResearchContext";
import { dedupeSources, textField } from "./deepResearchSources";
import { redactResearchContent } from "./deepResearchContext";

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
