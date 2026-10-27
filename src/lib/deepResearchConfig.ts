import type { DeepResearchLimits, ResearchDepth, ResearchDepthPreset } from "./deepResearch";

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

export const RESEARCH_DEPTH_PRESETS: Record<ResearchDepthPreset, ResearchDepth> = {
  quick: { rounds: 1, subQuestions: 3, maxSources: 8, maxGeneratedNotes: 4 },
  standard: { rounds: 2, subQuestions: 5, maxSources: 16, maxGeneratedNotes: 8 },
  deep: { rounds: 3, subQuestions: 8, maxSources: 28, maxGeneratedNotes: 12 },
};

const DEPTH_LIMITS = {
  rounds: { min: 1, max: 5 }, subQuestions: { min: 1, max: 12 },
  maxSources: { min: 1, max: 40 }, maxGeneratedNotes: { min: 1, max: 16 },
} as const;

export function clampDepth(depth: ResearchDepth): ResearchDepth {
  const c = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
  return {
    rounds: c(depth.rounds, DEPTH_LIMITS.rounds.min, DEPTH_LIMITS.rounds.max),
    subQuestions: c(depth.subQuestions, DEPTH_LIMITS.subQuestions.min, DEPTH_LIMITS.subQuestions.max),
    maxSources: c(depth.maxSources, DEPTH_LIMITS.maxSources.min, DEPTH_LIMITS.maxSources.max),
    maxGeneratedNotes: c(depth.maxGeneratedNotes, DEPTH_LIMITS.maxGeneratedNotes.min, DEPTH_LIMITS.maxGeneratedNotes.max),
  };
}

export function limitsForDepth(base: DeepResearchLimits, depth: ResearchDepth): DeepResearchLimits {
  const d = clampDepth(depth);
  return { ...base, maxSources: d.maxSources, maxGeneratedNotes: d.maxGeneratedNotes };
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

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
