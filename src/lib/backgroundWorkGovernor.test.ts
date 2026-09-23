import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backgroundWork,
  runCancellableBackgroundWork,
} from "./backgroundWorkGovernor";

describe("background work governor", () => {
  afterEach(() => {
    vi.useRealTimers();
    backgroundWork.resetForTests();
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
