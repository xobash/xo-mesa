import { describe, expect, it, vi } from "vitest";
import { LatestWinsQueue, SupersededTaskError } from "./latestWinsQueue";

describe("LatestWinsQueue", () => {
  it("finishes active work and skips every stale queued interaction", async () => {
    const queue = new LatestWinsQueue<string, string>();
    let finishActive!: (value: string) => void;
    let finishLatest!: (value: string) => void;
    const activeRun = vi.fn(
      () => new Promise<string>((resolve) => (finishActive = resolve))
    );
    const staleRun = vi.fn(async () => "stale");
    const latestRun = vi.fn(
      () => new Promise<string>((resolve) => (finishLatest = resolve))
    );

    const active = queue.enqueue("a", activeRun);
    const stale = queue.enqueue("b", staleRun);
    const latest = queue.enqueue("c", latestRun);
    const staleResult = stale.catch((error) => error);

    finishActive("active");
    await expect(active).resolves.toBe("active");
    await vi.waitFor(() => expect(latestRun).toHaveBeenCalledTimes(1));
    expect(staleRun).not.toHaveBeenCalled();

    finishLatest("latest");
    await expect(latest).resolves.toBe("latest");
    expect(await staleResult).toBeInstanceOf(SupersededTaskError);
  });

  it("can reprioritize an already queued key after a cache hit", async () => {
    const queue = new LatestWinsQueue<string, string>();
    let finishActive!: (value: string) => void;
    const active = queue.enqueue(
      "active",
      () => new Promise<string>((resolve) => (finishActive = resolve))
    );
    const first = queue.enqueue("first", async () => "first");
    const second = queue.enqueue("second", async () => "second");
    const secondResult = second.catch((error) => error);

    queue.prioritize("first");
    finishActive("done");

    await expect(active).resolves.toBe("done");
    await expect(first).resolves.toBe("first");
    expect(await secondResult).toBeInstanceOf(SupersededTaskError);
  });

  it("runs only the newest generation when the same key was queued twice", async () => {
    const queue = new LatestWinsQueue<string, string>();
    let finishActive!: (value: string) => void;
    const active = queue.enqueue(
      "active",
      () => new Promise<string>((resolve) => (finishActive = resolve))
    );
    const oldRun = vi.fn(async () => "old");
    const newRun = vi.fn(async () => "new");
    const old = queue.enqueue("same", oldRun);
    const oldResult = old.catch((error) => error);
    const newest = queue.enqueue("same", newRun);

    finishActive("done");
    await expect(active).resolves.toBe("done");
    await expect(newest).resolves.toBe("new");
    expect(oldRun).not.toHaveBeenCalled();
    expect(await oldResult).toBeInstanceOf(SupersededTaskError);
  });
});
