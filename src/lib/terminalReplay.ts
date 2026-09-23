export interface TerminalReplayEvent {
  kind: "output" | "resize";
  data?: string;
  rows?: number;
  cols?: number;
}

export interface TerminalSnapshot {
  data: string;
  seq: number;
  events?: TerminalReplayEvent[];
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
  if (!snapshot.events?.length) {
    await writeAndWait(terminal, snapshot.data);
    return;
  }

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
