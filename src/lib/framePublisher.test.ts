import { describe, expect, it } from "vitest";
import { createFramePublisher } from "./framePublisher";

describe("createFramePublisher", () => {
  it("publishes only the newest value from an event burst", () => {
    const frames: FrameRequestCallback[] = [];
    const published: number[] = [];
    const publisher = createFramePublisher<number>(
      (callback) => (frames.push(callback), frames.length),
      () => undefined,
      (value) => published.push(value)
    );
    for (let value = 1; value <= 1_000; value++) publisher.schedule(value);
    expect(frames).toHaveLength(1);
    expect(published).toEqual([]);
    frames[0](0);
    expect(published).toEqual([1_000]);
  });

  it("cancels a pending publication", () => {
    const frames: FrameRequestCallback[] = [];
    let cancelled = 0;
    const published: string[] = [];
    const publisher = createFramePublisher<string>(
      (next) => {
        frames.push(next);
        return 7;
      },
      (handle) => {
        expect(handle).toBe(7);
        cancelled++;
      },
      (value) => published.push(value)
    );
    publisher.schedule("stale");
    publisher.cancel();
    frames[0](0);
    expect(cancelled).toBe(1);
    expect(published).toEqual([]);
  });
});
