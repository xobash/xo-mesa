import { describe, expect, it } from "vitest";
import { replayTerminalSnapshot } from "./terminalReplay";

describe("replayTerminalSnapshot", () => {
  it("replays output at the historical dimensions in exact order", async () => {
    const operations: string[] = [];
    const terminal = {
      reset: () => operations.push("reset"),
      resize: (cols: number, rows: number) =>
        operations.push(`resize:${cols}x${rows}`),
      write: (data: string, callback?: () => void) => {
        operations.push(`write:${data}`);
        callback?.();
      },
    };

    await replayTerminalSnapshot(terminal, {
      data: "ignored-fallback",
      seq: 4,
      events: [
        { kind: "resize", cols: 80, rows: 24 },
        { kind: "output", data: "first" },
        { kind: "resize", cols: 68, rows: 25 },
        { kind: "output", data: "second" },
      ],
    });

    expect(operations).toEqual([
      "reset",
      "resize:80x24",
      "write:first",
      "resize:68x25",
      "write:second",
    ]);
  });

  it("falls back to legacy raw snapshots", async () => {
    const writes: string[] = [];
    await replayTerminalSnapshot(
      {
        reset: () => undefined,
        resize: () => undefined,
        write: (data, callback) => {
          writes.push(data);
          callback?.();
        },
      },
      { data: "legacy", seq: 1 }
    );
    expect(writes).toEqual(["legacy"]);
  });
});
