import { invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./vault";

export interface ProcessTreeSample {
  pid: number;
  sampledAtMs: number;
  processCount: number;
  rssBytes: number;
  cpuTimeMs: number | null;
  unsupportedReason: string | null;
  /** Native samples identify descendants only, never all shared engine/GPU resources. */
  coverage?: "descendants-only";
  processIds?: number[];
}

export interface ProcessTreeRateSample extends ProcessTreeSample {
  cpuPercent: number | null;
}

let lastSample: ProcessTreeSample | null = null;
let pendingSample: Promise<ProcessTreeRateSample> | null = null;

export async function sampleProcessTreeResources(): Promise<ProcessTreeRateSample | null> {
  if (!IN_TAURI) return null;
  return requestProcessTreeSample(() => invoke<ProcessTreeSample>("diagnostics_process_tree"));
}

export function resetProcessTreeResourceSamples(): void {
  lastSample = null;
  pendingSample = null;
}

/** One diagnostics sample at a time prevents interval ticks from queuing IPC. */
export function requestProcessTreeSample(
  request: () => Promise<ProcessTreeSample>
): Promise<ProcessTreeRateSample> {
  if (pendingSample) return pendingSample;
  const pending = request().then((sample) => {
    const previous = lastSample;
    lastSample = sample;
    return { ...sample, cpuPercent: cpuPercent(previous, sample) };
  });
  pendingSample = pending;
  const cleanup = () => { if (pendingSample === pending) pendingSample = null; };
  void pending.then(cleanup, cleanup);
  return pendingSample;
}

export function cpuPercent(
  previous: ProcessTreeSample | null,
  current: ProcessTreeSample
): number | null {
  if (
    !previous ||
    previous.pid !== current.pid ||
    previous.processCount !== current.processCount ||
    (previous.processIds !== undefined && current.processIds !== undefined && previous.processIds.join(",") !== current.processIds.join(",")) ||
    previous.cpuTimeMs === null ||
    current.cpuTimeMs === null ||
    current.sampledAtMs <= previous.sampledAtMs
  ) {
    return null;
  }
  const cpuDelta = current.cpuTimeMs - previous.cpuTimeMs;
  if (cpuDelta < 0) return null;
  return (cpuDelta / (current.sampledAtMs - previous.sampledAtMs)) * 100;
}
