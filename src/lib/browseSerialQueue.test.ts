import { describe, expect, it, vi } from "vitest";
import { AbortableSerialQueue } from "../../src-tauri/resources/mesa-browser-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AbortableSerialQueue", () => {
  it("runs simultaneous browse calls in FIFO order", async () => {
    const queue = new AbortableSerialQueue();
    const firstDone = deferred<string>();
    const firstStarted = deferred<void>();
    const events: string[] = [];

    const first = queue.run(undefined, async () => {
      events.push("first:start");
      firstStarted.resolve();
      const result = await firstDone.promise;
      events.push("first:end");
      return result;
    });
    const second = queue.run(undefined, async () => {
      events.push("second:start");
      return "second";
    });

    await firstStarted.promise;
    expect(events).toEqual(["first:start"]);
    firstDone.resolve("first");
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("cancels a queued browse without running it or blocking the next one", async () => {
    const queue = new AbortableSerialQueue();
    const firstDone = deferred<void>();
    const skipped = vi.fn(async () => "must not run");
    const controller = new AbortController();

    const first = queue.run(undefined, async () => {
      await firstDone.promise;
      return "first";
    });
    const cancelled = queue.run(controller.signal, skipped);
    controller.abort(new Error("user cancelled"));

    await expect(cancelled).rejects.toThrow("user cancelled");
    expect(skipped).not.toHaveBeenCalled();
    const third = queue.run(undefined, async () => "third");
    firstDone.resolve();
    await expect(first).resolves.toBe("first");
    await expect(third).resolves.toBe("third");
    expect(skipped).not.toHaveBeenCalled();
  });
});
