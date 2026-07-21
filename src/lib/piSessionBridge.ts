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

/**
 * A request from store-level code (Deep Research) to restart the shared Pi
 * session so it picks up a changed launch configuration (e.g. loading the
 * deep-research extension). AgentPanel registers the real implementation
 * (which owns the PTY lifecycle); the store calls `requestSharedPiRestart`
 * without importing the component module. Returns true when a live session
 * was actually stopped and will respawn on the next ensure.
 */
let restartImpl: (() => Promise<boolean>) | null = null;
let restartListeners = new Set<() => void>();

export function registerSharedPiRestart(fn: () => Promise<boolean>): void {
  restartImpl = fn;
}

export async function requestSharedPiRestart(): Promise<boolean> {
  if (!restartImpl) return false;
  const stopped = await restartImpl();
  if (stopped) {
    // Notify mounted Pi surfaces so their session effect respawns the shared
    // session (it reads the current store launch config, e.g. an active Deep
    // Research run). Without this, the effect's deps haven't changed and the
    // session would stay stopped until the surface remounts.
    for (const l of restartListeners) l();
  }
  return stopped;
}

/** Subscribe a Pi surface to shared-session restart requests. */
export function onSharedPiRestart(fn: () => void): () => void {
  restartListeners.add(fn);
  return () => {
    restartListeners.delete(fn);
  };
}
