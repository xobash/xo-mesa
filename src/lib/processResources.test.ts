import { describe, expect, it } from "vitest";
import { cpuPercent, type ProcessTreeSample } from "./processResources";

const sample = (overrides: Partial<ProcessTreeSample>): ProcessTreeSample => ({
  pid: 7,
  sampledAtMs: 0,
  processCount: 1,
  rssBytes: 0,
  cpuTimeMs: 0,
  unsupportedReason: null,
  ...overrides,
});

describe("process resource diagnostics", () => {
  it("calculates process-tree CPU from monotonic OS CPU time", () => {
    const previous = sample({ sampledAtMs: 1_000, cpuTimeMs: 200 });
    const current = sample({ sampledAtMs: 2_000, cpuTimeMs: 450 });

    expect(cpuPercent(previous, current)).toBe(25);
  });

  it("withholds CPU when samples cannot be compared safely", () => {
    expect(cpuPercent(null, sample({ sampledAtMs: 1_000 }))).toBeNull();
    expect(cpuPercent(sample({ pid: 1 }), sample({ pid: 2 }))).toBeNull();
    expect(cpuPercent(sample({ cpuTimeMs: null }), sample({ cpuTimeMs: 1 }))).toBeNull();
    expect(cpuPercent(sample({ sampledAtMs: 2_000 }), sample({ sampledAtMs: 1_000 }))).toBeNull();
    expect(cpuPercent(sample({ cpuTimeMs: 10 }), sample({ cpuTimeMs: 5 }))).toBeNull();
  });
});
