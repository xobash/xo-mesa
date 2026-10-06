export interface TerminalResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

/** Serialize PTY resize IPC and collapse queued dimensions to the newest request. */
export function createLatestTerminalResizeQueue(
  send: (request: TerminalResizeRequest) => Promise<void>
): {
  enqueue(request: TerminalResizeRequest): void;
  flush(): Promise<void>;
} {
  let pending: TerminalResizeRequest | null = null;
  let draining: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    while (pending) {
      const next = pending;
      pending = null;
      try {
        await send(next);
      } catch {
        // A stopped session or a renderer that lost resize ownership is
        // expected during tear-out/dock transitions. The next request remains
        // authoritative, so resize failures must not poison the queue.
      }
    }
  };

  const start = (): Promise<void> => {
    if (!draining) {
      draining = drain().finally(() => {
        draining = null;
        if (pending) void start();
      });
    }
    return draining;
  };

  return {
    enqueue(request) {
      pending = request;
      void start();
    },
    async flush() {
      while (draining || pending) {
        await start();
      }
    },
  };
}
