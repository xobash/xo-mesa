import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundWorkSnapshot } from "./backgroundWorkGovernor";

// Each test starts from a module instance with an empty sample history.
let plateau: typeof import("./resourcePlateau");
beforeEach(async () => {
  vi.resetModules();
  plateau = await import("./resourcePlateau");
});

const governor = (queued = 0): BackgroundWorkSnapshot => ({
  active: 0,
  queued,
  limit: 2,
  pressure: "idle",
  byKind: {},
});

const working = (chars = 0) => ({ decodedChars: chars, decodedDocuments: 0 });

describe("resource plateau diagnostics", () => {
  it("reports warming until enough local samples exist", () => {
    plateau.recordResourceSample({ nowMs: 0, working: working(), governor: governor(), activeJobs: 0, pdfRasterBytes: 0, heapBytes: null });
    expect(plateau.summarizeResourcePlateau()?.trend).toBe("warming");
  });

  it("reports plateau when owned resources stop growing", () => {
    for (let i = 0; i < 6; i++) {
      plateau.recordResourceSample({ nowMs: i * 1000, working: working(100), governor: governor(), activeJobs: 0, pdfRasterBytes: 1024, heapBytes: 10_000 });
    }
    const summary = plateau.summarizeResourcePlateau();
    expect(summary?.trend).toBe("plateau");
    expect(summary?.decodedDeltaBytes).toBe(0);
  });

  it("reports growth when queues or owned memory rise across the window", () => {
    plateau.recordResourceSample({ nowMs: 0, working: working(100), governor: governor(), activeJobs: 0, pdfRasterBytes: 0, heapBytes: null });
    for (let i = 1; i < 6; i++) {
      plateau.recordResourceSample({ nowMs: i * 1000, working: working(30_000_000), governor: governor(2), activeJobs: 1, pdfRasterBytes: 0, heapBytes: null });
    }
    const summary = plateau.summarizeResourcePlateau();
    expect(summary?.trend).toBe("growing");
    expect(summary?.queuedDelta).toBe(2);
  });
});

it("does not report a plateau when any heap sample is missing", () => {
  for (let i = 0; i < 6; i++) plateau.recordResourceSample({ nowMs: i * 1000, working: working(), governor: governor(), activeJobs: 0, pdfRasterBytes: 0, heapBytes: i === 2 ? null : 100 });
  expect(plateau.summarizeResourcePlateau()).toMatchObject({ trend: "incomplete", heapDeltaBytes: null });
});
