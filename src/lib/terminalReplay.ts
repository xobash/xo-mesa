interface TerminalReplayEvent {
  kind: "output" | "resize";
  data?: string;
  rows?: number;
  cols?: number;
}

/** Native `terminal_snapshot`: the ordered output/resize history up to `seq`. */
export interface TerminalSnapshot {
  seq: number;
  events: TerminalReplayEvent[];
}

/** The snapshot's output as one text, without the grid timeline. */
export function snapshotTranscript(snapshot: Pick<TerminalSnapshot, "events">): string {
  let text = "";
  for (const event of snapshot.events) {
    if (event.kind === "output" && typeof event.data === "string") text += event.data;
  }
  return text;
}

interface ReplayTerminal {
  reset(): void;
  resize(cols: number, rows: number): void;
  write(data: string, callback?: () => void): void;
}

function writeAndWait(terminal: ReplayTerminal, data: string): Promise<void> {
  if (!data) return Promise.resolve();
  return new Promise<void>((resolve) => terminal.write(data, resolve));
}

/**
 * Reconstruct a terminal using the PTY's historical resize/output timeline.
 * Replaying raw TUI bytes at only the detached window's current width changes
 * line wrapping and makes cursor-up rewrites leave duplicated/stale lines.
 */
export async function replayTerminalSnapshot(
  terminal: ReplayTerminal,
  snapshot: TerminalSnapshot
): Promise<void> {
  terminal.reset();
  for (const event of snapshot.events) {
    if (
      event.kind === "resize" &&
      Number.isFinite(event.cols) &&
      Number.isFinite(event.rows) &&
      (event.cols ?? 0) >= 2 &&
      (event.rows ?? 0) >= 2
    ) {
      terminal.resize(Math.floor(event.cols!), Math.floor(event.rows!));
      continue;
    }
    if (event.kind === "output" && typeof event.data === "string") {
      await writeAndWait(terminal, event.data);
    }
  }
}

/** Keep an exit behind live bytes received while snapshot replay is pending. */
export function createTerminalReplayGate<T, E>(output: (event: T) => void, exit: (event: E) => void) {
  let replaying = true;
  let pending: T[] = [];
  let pendingExit: E | undefined;
  return {
    output(event: T) { if (replaying) pending.push(event); else output(event); },
    exit(event: E) { if (replaying) pendingExit = event; else exit(event); },
    complete() {
      if (!replaying) return;
      replaying = false;
      for (const event of pending) output(event);
      pending = [];
      if (pendingExit !== undefined) { const event = pendingExit; pendingExit = undefined; exit(event); }
    },
  };
}
