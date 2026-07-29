export interface PdfPerfEvent {
  at: number;
  name: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface PdfPerfRun {
  id: number;
  file: {
    relPath: string;
    ext: string;
    size?: number;
  };
  startedAt: number;
  events: PdfPerfEvent[];
  /** Totals for things that happen per page. Recording those as events would
   *  overrun the event budget on a long document and evict the open-path
   *  timeline, which is the part every measurement starts from. */
  counters: Record<string, number>;
}

interface PdfPerfGlobal {
  runs: PdfPerfRun[];
  activeRunId: number | null;
}

type PdfPerfWindow = Window & {
  __MESA_PDF_PERF__?: PdfPerfGlobal;
};

const MAX_RUNS = 12;
const MAX_EVENTS_PER_RUN = 240;
/** The open path is the whole point of the timeline, so eviction drops from the
 *  middle and always keeps the first events of the run. */
const KEEP_HEAD_EVENTS = 60;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function perfState(): PdfPerfGlobal | null {
  if (typeof window === "undefined") return null;
  const w = window as PdfPerfWindow;
  if (!w.__MESA_PDF_PERF__) {
    w.__MESA_PDF_PERF__ = { runs: [], activeRunId: null };
  }
  return w.__MESA_PDF_PERF__;
}

function activeRun(state: PdfPerfGlobal, runId: number): PdfPerfRun | null {
  return state.runs.find((run) => run.id === runId) ?? null;
}

export function startPdfPerfRun(file: {
  relPath: string;
  ext: string;
  size?: number;
}): number | null {
  const state = perfState();
  if (!state) return null;
  const id = Math.floor(now() * 1000);
  const run: PdfPerfRun = {
    id,
    file: {
      relPath: file.relPath,
      ext: file.ext,
      size: file.size,
    },
    startedAt: now(),
    events: [],
    counters: {},
  };
  state.runs.push(run);
  if (state.runs.length > MAX_RUNS) {
    state.runs.splice(0, state.runs.length - MAX_RUNS);
  }
  state.activeRunId = id;
  markPdfPerf(run.id, "open-requested");
  return id;
}

export function markPdfPerf(
  runId: number | null,
  name: string,
  detail?: Record<string, string | number | boolean | null>
): void {
  const state = perfState();
  if (!state || runId === null) return;
  const run = activeRun(state, runId);
  if (!run) return;
  run.events.push({
    at: now() - run.startedAt,
    name,
    detail,
  });
  if (run.events.length > MAX_EVENTS_PER_RUN) {
    run.events.splice(KEEP_HEAD_EVENTS, run.events.length - MAX_EVENTS_PER_RUN);
  }
}

/** Add to a per-run total. Use this for anything that happens once per page. */
export function countPdfPerf(runId: number | null, name: string, by = 1): void {
  const state = perfState();
  if (!state || runId === null) return;
  const run = activeRun(state, runId);
  if (!run) return;
  run.counters[name] = (run.counters[name] ?? 0) + by;
}

export function activePdfPerfRun(): PdfPerfRun | null {
  const state = perfState();
  if (!state || state.activeRunId === null) return null;
  return activeRun(state, state.activeRunId);
}
