/** Startup-safe Deep Research limits, depth presets and UTF-8 byte helpers. Keep this module free of heavy imports. */

export interface DeepResearchLimits {
  /** Max notes whose content is injected into the research context. */
  maxContextNotes: number;
  /** Max bytes of a single note's content in context. */
  maxNoteBytes: number;
  /** Max total bytes of note content in context. */
  maxTotalBytes: number;
  /** Max sources kept after canonicalization/dedup. */
  maxSources: number;
  /** Max generated source notes (the report note is separate). */
  maxGeneratedNotes: number;
  /** Max bytes of a single generated note. */
  maxGeneratedNoteBytes: number;
  /** Max bytes of the generated report. */
  maxReportBytes: number;
  /** Max total model-generated report/note/update markdown bytes. */
  maxGeneratedTotalBytes: number;
  /** Max related existing notes the report links to / may update. */
  maxRelated: number;
}

export const DEFAULT_DEEP_RESEARCH_LIMITS: DeepResearchLimits = {
  maxContextNotes: 24,
  maxNoteBytes: 8 * 1024,
  maxTotalBytes: 96 * 1024,
  maxSources: 24,
  maxGeneratedNotes: 8,
  maxGeneratedNoteBytes: 24 * 1024,
  maxReportBytes: 32 * 1024,
  maxGeneratedTotalBytes: 512 * 1024,
  maxRelated: 12,
};

/**
 * How thoroughly a run researches: how many sub-questions to expand into, how
 * many sources to consult, and how many notes to generate. A preset is a
 * starting point the user can fine-tune per run in the panel.
 */
export interface ResearchDepth {
  /** Deliberate research passes (breadth, verification, synthesis/gap closure). */
  rounds: number;
  /** Sub-questions to expand the query into. */
  subQuestions: number;
  /** Cap on sources to consult / keep. */
  maxSources: number;
  /** Cap on generated source notes. */
  maxGeneratedNotes: number;
}

export type ResearchDepthPreset = "quick" | "standard" | "deep";

export const RESEARCH_DEPTH_PRESETS: Record<ResearchDepthPreset, ResearchDepth> = {
  quick: { rounds: 1, subQuestions: 3, maxSources: 8, maxGeneratedNotes: 4 },
  standard: { rounds: 2, subQuestions: 5, maxSources: 16, maxGeneratedNotes: 8 },
  deep: { rounds: 3, subQuestions: 8, maxSources: 28, maxGeneratedNotes: 12 },
};

export const DEPTH_LIMITS = {
  rounds: { min: 1, max: 5 },
  subQuestions: { min: 1, max: 12 },
  maxSources: { min: 1, max: 40 },
  maxGeneratedNotes: { min: 1, max: 16 },
} as const;

/** Clamp a depth to the allowed ranges. */
export function clampDepth(depth: ResearchDepth): ResearchDepth {
  const c = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
  return {
    rounds: c(depth.rounds, DEPTH_LIMITS.rounds.min, DEPTH_LIMITS.rounds.max),
    subQuestions: c(depth.subQuestions, DEPTH_LIMITS.subQuestions.min, DEPTH_LIMITS.subQuestions.max),
    maxSources: c(depth.maxSources, DEPTH_LIMITS.maxSources.min, DEPTH_LIMITS.maxSources.max),
    maxGeneratedNotes: c(depth.maxGeneratedNotes, DEPTH_LIMITS.maxGeneratedNotes.min, DEPTH_LIMITS.maxGeneratedNotes.max),
  };
}

/** The clamped depth for a persisted preset name; unknown names fall back to "standard". */
export function depthForPreset(preset: string): ResearchDepth {
  const known = Object.prototype.hasOwnProperty.call(RESEARCH_DEPTH_PRESETS, preset);
  return clampDepth(RESEARCH_DEPTH_PRESETS[known ? (preset as ResearchDepthPreset) : "standard"]);
}

/** Merge a depth into a limits object (depth overrides source/note caps). */
export function limitsForDepth(base: DeepResearchLimits, depth: ResearchDepth): DeepResearchLimits {
  const d = clampDepth(depth);
  return { ...base, maxSources: d.maxSources, maxGeneratedNotes: d.maxGeneratedNotes };
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Truncate without splitting a Unicode code point, measured in UTF-8 bytes. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(value) <= maxBytes) return value;
  let used = 0;
  let out = "";
  for (const codePoint of value) {
    const bytes = utf8ByteLength(codePoint);
    if (used + bytes > maxBytes) break;
    out += codePoint;
    used += bytes;
  }
  return out;
}

/** A fresh Deep Research run identifier. */
export function createRunId(): string {
  return `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
