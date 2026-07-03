/**
 * Tiny read-only mirror of AgentPanel's SHARED_PI_SESSION, so store.ts can
 * see whether a live Pi session is running (to hand it off when popping Pi
 * out into its own OS window) without importing the AgentPanel *component*
 * module — store.ts otherwise only imports from lib/ and types, and a
 * store <-> component import cycle is worth avoiding.
 *
 * This only works WITHIN one Tauri webview/renderer: a popped-out Pi window
 * is a separate JS realm and can't see this module's state at all, which is
 * exactly why the live session id has to be carried across that boundary
 * explicitly (as a `piSession` query param on the popout window's URL) —
 * see `openAgentWindow` in store.ts and `adoptSharedPiSession` in
 * AgentPanel.tsx.
 */
export interface PiSessionSnapshot {
  sessionId: string | null;
  vaultPath: string | null;
  contextText: string | null;
}

let snapshot: PiSessionSnapshot = {
  sessionId: null,
  vaultPath: null,
  contextText: null,
};

export function setPiSessionSnapshot(next: PiSessionSnapshot): void {
  snapshot = next;
}

export function getPiSessionSnapshot(): PiSessionSnapshot {
  return snapshot;
}
