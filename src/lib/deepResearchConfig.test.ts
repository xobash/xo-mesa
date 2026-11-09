import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DEEP_RESEARCH_LIMITS,
  DEPTH_LIMITS,
  RESEARCH_DEPTH_PRESETS,
  clampDepth,
  createRunId,
  depthForPreset,
  limitsForDepth,
  truncateUtf8,
  utf8ByteLength,
} from "./deepResearchConfig";

describe("UTF-8 byte limits", () => {
  it("truncates on code-point boundaries by bytes, not JavaScript code units", () => {
    expect(utf8ByteLength("😀a")).toBe(5);
    expect(truncateUtf8("😀a", 4)).toBe("😀");
    expect(truncateUtf8("😀a", 3)).toBe("");
  });
});

describe("clampDepth / limitsForDepth / presets", () => {
  it("clamps depth to the allowed ranges", () => {
    const d = clampDepth({ rounds: 99, subQuestions: 0, maxSources: 999, maxGeneratedNotes: -3 });
    expect(d.rounds).toBe(DEPTH_LIMITS.rounds.max);
    expect(d.subQuestions).toBe(DEPTH_LIMITS.subQuestions.min);
    expect(d.maxSources).toBe(DEPTH_LIMITS.maxSources.max);
    expect(d.maxGeneratedNotes).toBe(DEPTH_LIMITS.maxGeneratedNotes.min);
  });

  it("merges depth into limits, overriding source/note caps only", () => {
    const merged = limitsForDepth(DEFAULT_DEEP_RESEARCH_LIMITS, { rounds: 3, subQuestions: 6, maxSources: 20, maxGeneratedNotes: 10 });
    expect(merged.maxSources).toBe(20);
    expect(merged.maxGeneratedNotes).toBe(10);
    expect(merged.maxContextNotes).toBe(DEFAULT_DEEP_RESEARCH_LIMITS.maxContextNotes);
    expect(merged.maxTotalBytes).toBe(DEFAULT_DEEP_RESEARCH_LIMITS.maxTotalBytes);
  });

  it("presets are ordered quick < standard < deep in thoroughness", () => {
    expect(RESEARCH_DEPTH_PRESETS.quick.maxSources).toBeLessThan(RESEARCH_DEPTH_PRESETS.standard.maxSources);
    expect(RESEARCH_DEPTH_PRESETS.standard.maxSources).toBeLessThan(RESEARCH_DEPTH_PRESETS.deep.maxSources);
    expect(RESEARCH_DEPTH_PRESETS.quick.subQuestions).toBeLessThan(RESEARCH_DEPTH_PRESETS.deep.subQuestions);
    expect(RESEARCH_DEPTH_PRESETS.quick.rounds).toBeLessThan(RESEARCH_DEPTH_PRESETS.deep.rounds);
  });

  it("resolves a persisted preset name, falling back to standard for unknown names", () => {
    expect(depthForPreset("quick")).toEqual(RESEARCH_DEPTH_PRESETS.quick);
    expect(depthForPreset("deep")).toEqual(RESEARCH_DEPTH_PRESETS.deep);
    expect(depthForPreset("")).toEqual(RESEARCH_DEPTH_PRESETS.standard);
    expect(depthForPreset("bogus")).toEqual(RESEARCH_DEPTH_PRESETS.standard);
    // Inherited object keys are not presets.
    expect(depthForPreset("toString")).toEqual(RESEARCH_DEPTH_PRESETS.standard);
  });
});

describe("createRunId", () => {
  it("creates unique run ids", () => {
    const a = createRunId();
    const b = createRunId();
    expect(a).not.toBe(b);
  });

  it("uses a base-36 time stamp and an eight-character random suffix", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(36 ** 3);
    const random = vi.spyOn(Math, "random").mockReturnValue(0.123456789);
    try {
      expect(createRunId()).toBe("dr-1000-4fzzzxjy");
    } finally {
      now.mockRestore();
      random.mockRestore();
    }
  });
});
