/**
 * One local, cooperative admission gate for work that is useful but never more
 * important than an input response.  It intentionally does not try to cancel
 * native work already in flight: callers keep their existing cancellation and
 * correctness rules.  It controls the next unit of work instead.
 */
export type BackgroundWorkKind = "index" | "thumbnail" | "sync" | "watcher" | "research" | "pdf";

export interface BackgroundWorkSnapshot {
  active: number;
  queued: number;
  limit: number;
  pressure: "idle" | "busy" | "interactive";
  byKind: Partial<Record<BackgroundWorkKind, { active: number; queued: number }>>;
}

export interface BackgroundWorkHandle<T> {
  promise: Promise<T>;
  cancel(reason?: unknown): boolean;
}

export class BackgroundWorkCancelledError extends Error {
  constructor(message = "Background work cancelled before it started.") {
    super(message);
    this.name = "BackgroundWorkCancelledError";
  }
}

type Job = {
  kind: BackgroundWorkKind;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  started: boolean;
  cancelled: boolean;
  enqueuedAt: number;
  order: number;
};

const STARVATION_BOOST_MS = 5_000;

const priority: Record<BackgroundWorkKind, number> = {
  pdf: 0, index: 2, watcher: 2, sync: 3, research: 4, thumbnail: 5,
};

class BackgroundWorkGovernor {
  private queue: Job[] = [];
  private active = 0;
  private interactiveUntil = 0;
  private longTaskUntil = 0;
  private listeners = new Set<() => void>();
  private observed = false;
  private nextOrder = 0;

  constructor() {
    // Long-task observation is local, optional, and never retained as telemetry.
    if (typeof PerformanceObserver !== "undefined") {
      try {
        new PerformanceObserver((list) => {
          if (list.getEntries().some((entry) => entry.duration >= 50)) {
            this.longTaskUntil = Date.now() + 1200;
            this.pump();
          }
        }).observe({ type: "longtask", buffered: true } as PerformanceObserverInit);
        this.observed = true;
      } catch { /* unsupported browser/webview */ }
    }
  }

  private limit(): number {
    const cores = typeof navigator === "undefined" ? 2 : Math.max(1, navigator.hardwareConcurrency || 2);
    const now = Date.now();
    if (now < this.interactiveUntil) return 0;
    if (now < this.longTaskUntil) return 1;
    // Leave one logical processor and one WebView message-pump slot available.
    return Math.max(1, Math.min(4, Math.floor(cores / 2)));
  }

  noteInteraction(kind: "typing" | "scroll" | "drag" | "pdf" | "resize" = "typing"): void {
    const quiet = kind === "typing" ? 180 : kind === "resize" ? 260 : 140;
    this.interactiveUntil = Math.max(this.interactiveUntil, Date.now() + quiet);
    this.schedulePump(quiet);
    this.emit();
  }

  run<T>(kind: BackgroundWorkKind, task: () => Promise<T>): Promise<T> {
    return this.enqueue(kind, task).promise;
  }

  enqueue<T>(kind: BackgroundWorkKind, task: () => Promise<T>): BackgroundWorkHandle<T> {
    let job!: Job;
    const promise = new Promise<T>((resolve, reject) => {
      job = {
        kind,
        run: task,
        resolve: resolve as (value: unknown) => void,
        reject,
        started: false,
        cancelled: false,
        enqueuedAt: Date.now(),
        order: this.nextOrder++,
      };
      this.queue.push(job);
      this.sortQueue();
      this.pump();
    });
    return {
      promise,
      cancel: (reason?: unknown) => {
        if (job.started || job.cancelled) return false;
        const index = this.queue.indexOf(job);
        if (index < 0) return false;
        job.cancelled = true;
        this.queue.splice(index, 1);
        job.reject(reason ?? new BackgroundWorkCancelledError());
        this.emit();
        this.pump();
        return true;
      },
    };
  }

  snapshot(): BackgroundWorkSnapshot {
    const byKind: BackgroundWorkSnapshot["byKind"] = {};
    for (const job of this.queue) byKind[job.kind] = { active: byKind[job.kind]?.active ?? 0, queued: (byKind[job.kind]?.queued ?? 0) + 1 };
    return { active: this.active, queued: this.queue.length, limit: this.limit(), pressure: Date.now() < this.interactiveUntil ? "interactive" : Date.now() < this.longTaskUntil ? "busy" : "idle", byKind };
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  resetForTests(): void {
    while (this.queue.length) {
      const job = this.queue.shift()!;
      job.cancelled = true;
      job.reject(new BackgroundWorkCancelledError("Background work reset before it started."));
    }
    this.interactiveUntil = 0;
    this.longTaskUntil = 0;
    this.emit();
  }
  private emit(): void { this.listeners.forEach((listener) => listener()); }
  private schedulePump(delay: number): void { if (typeof window !== "undefined") window.setTimeout(() => this.pump(), delay + 1); }
  private sortQueue(): void {
    const now = Date.now();
    this.queue.sort((a, b) => {
      const aPriority = priority[a.kind] - Math.floor((now - a.enqueuedAt) / STARVATION_BOOST_MS);
      const bPriority = priority[b.kind] - Math.floor((now - b.enqueuedAt) / STARVATION_BOOST_MS);
      return aPriority - bPriority || a.order - b.order;
    });
  }
  private pump(): void {
    const limit = this.limit();
    while (this.active < limit && this.queue.length) {
      this.sortQueue();
      const job = this.queue.shift()!;
      if (job.cancelled) continue;
      job.started = true;
      this.active++;
      this.emit();
      void job.run().then(job.resolve, job.reject).finally(() => { this.active--; this.emit(); this.pump(); });
    }
    if (this.queue.length && limit === 0) this.schedulePump(Math.max(1, this.interactiveUntil - Date.now()));
    if (!this.observed) this.emit();
  }
}

export const backgroundWork = new BackgroundWorkGovernor();

export function runCancellableBackgroundWork<T>(
  kind: BackgroundWorkKind,
  task: () => Promise<T>,
  stopped: () => boolean,
  message = "Background work cancelled before it started."
): Promise<T> {
  if (stopped()) return Promise.reject(new BackgroundWorkCancelledError(message));
  const handle = backgroundWork.enqueue(kind, async () => {
    if (stopped()) throw new BackgroundWorkCancelledError(message);
    return task();
  });
  if (stopped()) handle.cancel(new BackgroundWorkCancelledError(message));
  const check = () => {
    if (stopped()) handle.cancel(new BackgroundWorkCancelledError(message));
  };
  const timer =
    typeof window !== "undefined"
      ? window.setInterval(check, 50)
      : setInterval(check, 50);
  return handle.promise.finally(() => {
    if (typeof window !== "undefined") window.clearInterval(timer as number);
    else clearInterval(timer as ReturnType<typeof setInterval>);
  });
}
