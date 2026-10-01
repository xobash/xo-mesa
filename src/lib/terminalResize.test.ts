import { describe, expect, it } from "vitest";
import {
  createLatestTerminalResizeQueue,
  type TerminalResizeRequest,
} from "./terminalResize";

describe("createLatestTerminalResizeQueue", () => {
  it("serializes IPC and collapses an in-flight burst to the latest size", async () => {
    const sent: TerminalResizeRequest[] = [];
    const releases: Array<() => void> = [];
    let concurrent = 0;
    let peakConcurrent = 0;
    const queue = createLatestTerminalResizeQueue(async (request) => {
      sent.push(request);
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      await new Promise<void>((resolve) => releases.push(resolve));
      concurrent -= 1;
    });

    queue.enqueue({ sessionId: "term-1", cols: 60, rows: 20 });
    await Promise.resolve();
    queue.enqueue({ sessionId: "term-1", cols: 70, rows: 21 });
    queue.enqueue({ sessionId: "term-1", cols: 80, rows: 24 });

    expect(sent).toEqual([{ sessionId: "term-1", cols: 60, rows: 20 }]);
    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([
      { sessionId: "term-1", cols: 60, rows: 20 },
      { sessionId: "term-1", cols: 80, rows: 24 },
    ]);
    releases.shift()?.();
    await queue.flush();
    expect(peakConcurrent).toBe(1);
  });

  it("continues after a transient resize failure", async () => {
    const sent: number[] = [];
    const queue = createLatestTerminalResizeQueue(async ({ cols }) => {
      sent.push(cols);
      if (cols === 80) throw new Error("stale owner");
    });

    queue.enqueue({ sessionId: "term-1", cols: 80, rows: 24 });
    await queue.flush();
    queue.enqueue({ sessionId: "term-1", cols: 100, rows: 30 });
    await queue.flush();

    expect(sent).toEqual([80, 100]);
  });
});
