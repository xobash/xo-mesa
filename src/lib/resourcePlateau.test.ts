import { beforeEach, describe, expect, it } from "vitest";
import {
  clearResourceSamples,
  recordResourceSample,
  summarizeResourcePlateau,
} from "./resourcePlateau";
import type { BackgroundWorkSnapshot } from "./backgroundWorkGovernor";

const governor = (queued = 0): BackgroundWorkSnapshot => ({
  active: 0,
  queued,
  limit: 2,
  pressure: "idle",
  byKind: {},
});

const working = (chars = 0) => ({ decodedChars: chars, decodedDocuments: 0 });

describe("resource plateau diagnostics", () => {
  beforeEach(() => clearResourceSamples());

  it("reports warming until enough local samples exist", () => {
    recordResourceSample({ nowMs: 0, working: working(), governor: governor(), activeJobs: 0, pdfRasterBytes: 0, heapBytes: null });
    expect(summarizeResourcePlateau()?.trend).toBe("warming");
  });

  it("reports plateau when owned resources stop growing", () => {
    for (let i = 0; i < 6; i++) {
      recordResourceSample({ nowMs: i * 1000, working: working(100), governor: governor(), activeJobs: 0, pdfRasterBytes: 1024, heapBytes: 10_000 });
    }
    const summary = summarizeResourcePlateau();
    expect(summary?.trend).toBe("plateau");
    expect(summary?.decodedDeltaBytes).toBe(0);
  });

  it("reports growth when queues or owned memory rise across the window", () => {
    recordResourceSample({ nowMs: 0, working: working(100), governor: governor(), activeJobs: 0, pdfRasterBytes: 0, heapBytes: null });
    for (let i = 1; i < 6; i++) {
      recordResourceSample({ nowMs: i * 1000, working: working(30_000_000), governor: governor(2), activeJobs: 1, pdfRasterBytes: 0, heapBytes: null });
    }
    const summary = summarizeResourcePlateau();
    expect(summary?.trend).toBe("growing");
    expect(summary?.queuedDelta).toBe(2);
  });
});
