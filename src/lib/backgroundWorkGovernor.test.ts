import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backgroundWork,
  runCancellableBackgroundWork,
} from "./backgroundWorkGovernor";

describe("background work governor", () => {
  afterEach(() => {
    vi.useRealTimers();
    backgroundWork.resetForTests();
    vi.unstubAllGlobals();
  });

  it("keeps one pending pump timer across bursts of interaction and resumes at the same time", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.setSystemTime(10_000);
    let ran = false;
    backgroundWork.noteInteraction("drag");
    void backgroundWork.run("index", async () => { ran = true; }).catch(() => undefined);
    for (let i = 1; i < 100; i++) {
      vi.advanceTimersByTime(5);
      backgroundWork.noteInteraction("drag");
    }
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    // Last interaction at +495 ms: drag quiet is 140 ms, the pump runs 1 ms after.
    await vi.advanceTimersByTimeAsync(10_636 - Date.now() - 1);
    expect(ran).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ran).toBe(true);
  });

  it("queues nonessential work while interaction is active", () => {
    backgroundWork.noteInteraction("typing");
    let ran = false;
    void backgroundWork.run("index", async () => { ran = true; }).catch(() => undefined);
    expect(backgroundWork.snapshot().queued).toBeGreaterThan(0);
    expect(ran).toBe(false);
  });

  it("removes cancelled queued work before it starts", async () => {
    backgroundWork.noteInteraction("typing");
    let ran = false;
    const handle = backgroundWork.enqueue("thumbnail", async () => { ran = true; });
    expect(handle.cancel()).toBe(true);
    await expect(handle.promise).rejects.toThrow("Background work cancelled");
    expect(ran).toBe(false);
  });

  it("cancels queued work when its owner becomes stale", async () => {
    vi.useFakeTimers();
    backgroundWork.noteInteraction("typing");
    let stopped = false;
    let ran = false;
    const promise = runCancellableBackgroundWork(
      "index",
      async () => {
        ran = true;
      },
      () => stopped
    );
    void promise.catch(() => undefined);
    expect(backgroundWork.snapshot().queued).toBeGreaterThan(0);
    stopped = true;
    await vi.advanceTimersByTimeAsync(60);
    await expect(promise).rejects.toThrow("Background work cancelled");
    expect(ran).toBe(false);
  });

  it("stops polling for staleness once the job has started", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let checks = 0;
    const promise = runCancellableBackgroundWork(
      "index",
      () => new Promise<void>((resolve) => { release = resolve; }),
      () => { checks++; return false; }
    );
    await vi.advanceTimersByTimeAsync(0);
    const atStart = checks;
    await vi.advanceTimersByTimeAsync(500);
    expect(checks).toBe(atStart);
    expect(vi.getTimerCount()).toBe(0);
    release();
    await promise;
  });

  it("ages old low-priority work ahead of newer high-priority work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    backgroundWork.noteInteraction("typing");
    const order: string[] = [];
    const oldThumbnail = backgroundWork.enqueue("thumbnail", async () => {
      order.push("old-thumbnail");
    });

    vi.setSystemTime(16_000);
    const newSync = backgroundWork.enqueue("sync", async () => {
      order.push("new-sync");
    });
    const trigger = backgroundWork.enqueue("index", async () => {
      order.push("trigger");
    });

    await Promise.all([oldThumbnail.promise, newSync.promise, trigger.promise]);
    expect(order[0]).toBe("old-thumbnail");
  });
});
