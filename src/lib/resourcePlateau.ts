import type { BackgroundWorkSnapshot } from "./backgroundWorkGovernor";
import type { workingSetStats } from "./documentWorkingSet";

export interface ResourceSample {
  at: number;
  heapBytes: number | null;
  decodedBytes: number;
  backgroundActive: number;
  backgroundQueued: number;
  activeJobs: number;
  pdfRasterBytes: number;
}

export interface ResourcePlateau {
  samples: number;
  oldestMs: number;
  newestMs: number;
  heapDeltaBytes: number | null;
  decodedDeltaBytes: number;
  queuedDelta: number;
  activeJobDelta: number;
  pdfRasterDeltaBytes: number;
  trend: "warming" | "plateau" | "growing";
}

type MemoryPerformance = Performance & {
  memory?: { usedJSHeapSize?: number };
};

const MAX_SAMPLES = 120;
const WARMUP_SAMPLES = 6;
const GROWTH_FLOOR_BYTES = 50 * 1024 * 1024;

const samples: ResourceSample[] = [];
type WorkingSetStats = ReturnType<typeof workingSetStats>;

export function readRendererHeapBytes(): number | null {
  if (typeof performance === "undefined") return null;
  const used = (performance as MemoryPerformance).memory?.usedJSHeapSize;
  return typeof used === "number" && Number.isFinite(used) ? used : null;
}

export function recordResourceSample(input: {
  nowMs: number;
  working: WorkingSetStats;
  governor: BackgroundWorkSnapshot;
  activeJobs: number;
  pdfRasterBytes: number;
  heapBytes?: number | null;
}): ResourceSample {
  const sample: ResourceSample = {
    at: input.nowMs,
    heapBytes: input.heapBytes === undefined ? readRendererHeapBytes() : input.heapBytes,
    decodedBytes: input.working.decodedChars * 2,
    backgroundActive: input.governor.active,
    backgroundQueued: input.governor.queued,
    activeJobs: input.activeJobs,
    pdfRasterBytes: input.pdfRasterBytes,
  };
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  return sample;
}

export function getResourceSamples(): ResourceSample[] {
  return [...samples];
}

export function clearResourceSamples(): void {
  samples.length = 0;
}

export function summarizeResourcePlateau(
  history: readonly ResourceSample[] = samples
): ResourcePlateau | null {
  if (history.length === 0) return null;
  const first = history[0];
  const last = history[history.length - 1];
  const heapDeltaBytes =
    first.heapBytes !== null && last.heapBytes !== null
      ? last.heapBytes - first.heapBytes
      : null;
  const decodedDeltaBytes = last.decodedBytes - first.decodedBytes;
  const queuedDelta = last.backgroundQueued - first.backgroundQueued;
  const activeJobDelta = last.activeJobs - first.activeJobs;
  const pdfRasterDeltaBytes = last.pdfRasterBytes - first.pdfRasterBytes;
  const positiveHeapGrowth = heapDeltaBytes !== null && heapDeltaBytes >= GROWTH_FLOOR_BYTES;
  const positiveOwnedGrowth =
    decodedDeltaBytes + pdfRasterDeltaBytes >= GROWTH_FLOOR_BYTES ||
    queuedDelta > 0 ||
    activeJobDelta > 0;
  const trend =
    history.length < WARMUP_SAMPLES
      ? "warming"
      : positiveHeapGrowth || positiveOwnedGrowth
        ? "growing"
        : "plateau";
  return {
    samples: history.length,
    oldestMs: first.at,
    newestMs: last.at,
    heapDeltaBytes,
    decodedDeltaBytes,
    queuedDelta,
    activeJobDelta,
    pdfRasterDeltaBytes,
    trend,
  };
}
