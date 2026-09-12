import { invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./vault";

export interface ProcessTreeSample {
  pid: number;
  sampledAtMs: number;
  processCount: number;
  rssBytes: number;
  cpuTimeMs: number | null;
  unsupportedReason: string | null;
}

export interface ProcessTreeRateSample extends ProcessTreeSample {
  cpuPercent: number | null;
}

let lastSample: ProcessTreeSample | null = null;

export async function sampleProcessTreeResources(): Promise<ProcessTreeRateSample | null> {
  if (!IN_TAURI) return null;
  const sample = await invoke<ProcessTreeSample>("diagnostics_process_tree");
  const previous = lastSample;
  lastSample = sample;
  return { ...sample, cpuPercent: cpuPercent(previous, sample) };
}

export function resetProcessTreeResourceSamples(): void {
  lastSample = null;
}

export function cpuPercent(
  previous: ProcessTreeSample | null,
  current: ProcessTreeSample
): number | null {
  if (
    !previous ||
    previous.pid !== current.pid ||
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
