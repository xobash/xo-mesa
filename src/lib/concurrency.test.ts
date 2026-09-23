import { describe, expect, it } from "vitest";
import { forEachConcurrent } from "./concurrency";

describe("forEachConcurrent", () => {
  it("processes every item while enforcing the requested concurrency", async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachConcurrent(Array.from({ length: 50 }, (_, i) => i), 7, async (item) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      seen.push(item);
      active--;
    });
    expect(peak).toBe(7);
    expect(seen.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i)
    );
  });

  it("normalizes unusable limits to one worker", async () => {
    let active = 0;
    let peak = 0;
    await forEachConcurrent([1, 2, 3], 0, async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
    });
    expect(peak).toBe(1);
  });

  it("rejects when a task fails instead of reporting partial success", async () => {
    await expect(
      forEachConcurrent([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("failed");
      })
    ).rejects.toThrow("failed");
  });

  it("stops scheduling new work after cancellation", async () => {
    let stopped = false;
    const seen: number[] = [];
    await forEachConcurrent(
      [0, 1, 2, 3, 4, 5],
      1,
      async (item) => {
        seen.push(item);
        if (item === 2) stopped = true;
      },
      () => stopped
    );
    expect(seen).toEqual([0, 1, 2]);
  });
});
