/** Native `terminal://exit` payload: Pi's PTY reached EOF and the child was reaped. */
export interface PiExitEvent {
  sessionId: string;
  code: number | null;
}

export interface PiSessionFields {
  sessionId: string | null;
  vaultPath: string | null;
  contextText: string | null;
  lastOutputSeq: number;
}

/**
 * Forget the shared Pi session when the exit event names it, so the next
 * `ensureSharedPiSession` spawns a fresh one. Returns false for a stale event
 * (a session that was already stopped or replaced).
 */
export function retireExitedPiSession(session: PiSessionFields, event: PiExitEvent): boolean {
  if (!session.sessionId || session.sessionId !== event.sessionId) return false;
  session.sessionId = null;
  session.vaultPath = null;
  session.contextText = null;
  session.lastOutputSeq = 0;
  return true;
}

export function piExitMessage(code: number | null): string {
  return code === null ? "Pi exited" : `Pi exited (code ${code})`;
}
