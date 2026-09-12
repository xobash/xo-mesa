/**
 * Local-only timing marks for native acceptance runs.
 *
 * The timeline never leaves the renderer and keeps a small bounded ring. It
 * also works when an evaluator does not expose `window.performance`.
 */
export interface MesaPerfMark {
  at: number;
  name: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface MesaPerfTimeline {
  startedAt: number;
  events: MesaPerfMark[];
}

type MesaPerfWindow = Window & { __MESA_PERF__?: MesaPerfTimeline };

const MAX_EVENTS = 256;

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** Add one local timing mark. No-op during SSR or non-window unit tests. */
export function markMesaPerf(
  name: string,
  detail?: Record<string, string | number | boolean | null>
): void {
  if (typeof window === "undefined") return;
  const w = window as MesaPerfWindow;
  const timeline =
    w.__MESA_PERF__ ??
    (w.__MESA_PERF__ = { startedAt: now(), events: [] });
  timeline.events.push({ at: now() - timeline.startedAt, name, detail });
  if (timeline.events.length > MAX_EVENTS) {
    timeline.events.splice(0, timeline.events.length - MAX_EVENTS);
  }
}

export function getMesaPerfTimeline(): MesaPerfTimeline {
  if (typeof window === "undefined") return { startedAt: now(), events: [] };
  const w = window as MesaPerfWindow;
  return w.__MESA_PERF__ ?? { startedAt: now(), events: [] };
}

/** Start local long-task observation when the host exposes the browser API. */
export function observeMesaLongTasks(): (() => void) | undefined {
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") return undefined;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        markMesaPerf("long-task", { durationMs: Math.round(entry.duration), source: entry.name || "unknown" });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
    return () => observer.disconnect();
  } catch {
    return undefined;
  }
}
