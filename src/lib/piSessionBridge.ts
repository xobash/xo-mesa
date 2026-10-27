/** Renderer-local shared Pi state without component imports. Pass session identity explicitly across webviews. */
export interface PiSessionSnapshot {
  sessionId: string | null;
  vaultPath: string | null;
  contextText: string | null;
  cols: number;
  rows: number;
}

/** The detached Pi webview emits this only after it has adopted the live PTY
 * and installed its output listener. The main window keeps the source surface
 * mounted until this handshake arrives, so a failed popout never strands Pi. */
export const AGENT_WINDOW_READY_EVENT = "mesa://agent-window-ready";
/** Main-workspace AgentContext broadcast to detached Pi renderer realms. */
export const AGENT_CONTEXT_EVENT = "mesa://agent-context";

let snapshot: PiSessionSnapshot = {
  sessionId: null,
  vaultPath: null,
  contextText: null,
  cols: 80,
  rows: 24,
};

export function setPiSessionSnapshot(next: PiSessionSnapshot): void {
  snapshot = next;
}

export function getPiSessionSnapshot(): PiSessionSnapshot {
  return snapshot;
}

/** Ask the registered PTY owner to restart for new launch configuration; return whether a live session stopped. */
let restartImpl: (() => Promise<boolean>) | null = null;
const restartListeners = new Set<() => void>();

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

const exitListeners = new Set<(code: number | null) => void>();

/** Tell mounted Pi surfaces that the shared session ended on its own. */
export function notifySharedPiExit(code: number | null): void {
  for (const listener of exitListeners) listener(code);
}

export function onSharedPiExit(fn: (code: number | null) => void): () => void {
  exitListeners.add(fn);
  return () => {
    exitListeners.delete(fn);
  };
}
