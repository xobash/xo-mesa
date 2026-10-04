import { describe, expect, it } from "vitest";
import {
  cpuPercent,
  requestProcessTreeSample,
  resetProcessTreeResourceSamples,
  type ProcessTreeSample,
} from "./processResources";

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

  it("coalesces overlapping diagnostics ticks into one native request", async () => {
    resetProcessTreeResourceSamples();
    let resolve!: (value: ProcessTreeSample) => void;
    let calls = 0;
    const request = () => {
      calls += 1;
      return new Promise<ProcessTreeSample>((done) => { resolve = done; });
    };
    const first = requestProcessTreeSample(request);
    const second = requestProcessTreeSample(request);
    expect(calls).toBe(1);
    resolve(sample({ sampledAtMs: 1_000, cpuTimeMs: 100 }));
    await expect(first).resolves.toMatchObject({ cpuPercent: null });
    await expect(second).resolves.toMatchObject({ cpuPercent: null });
  });
});

it("rejects CPU comparisons when the observed process membership changes", () => {
  expect(cpuPercent(sample({ processIds: [7, 8], processCount: 2 }), sample({ sampledAtMs: 1000, cpuTimeMs: 8000, processIds: [7, 9], processCount: 2 }))).toBeNull();
});
it("a failed sample is retryable without an unhandled cleanup rejection", async () => {
  resetProcessTreeResourceSamples();
  await expect(requestProcessTreeSample(async () => { throw new Error("unavailable"); })).rejects.toThrow("unavailable");
  await expect(requestProcessTreeSample(async () => sample({}))).resolves.toMatchObject({ pid: 7 });
});
