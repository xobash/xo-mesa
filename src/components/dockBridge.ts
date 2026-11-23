import { DOCK_WINDOW_EVENT, GLOBAL_AGENT_EVENT } from "../lib/windowDock";

export type BridgeListen = (
  event: string,
  handler: (event: { payload: unknown }) => void
) => Promise<() => void>;

export interface DockBridgeHandlers {
  /** A detached window asks main to dock its view back. */
  dock(event: { payload: unknown }): void;
  /** The global agent shortcut fired. */
  globalAgent(): void;
}

/**
 * Register the dock and global-agent listeners in order. A failed
 * registration releases the ones already registered and reports through
 * `onError`; disposing before registration completes releases each listener
 * as soon as it arrives. Returns the disposer.
 */
export function installDockBridge(
  listen: BridgeListen,
  handlers: DockBridgeHandlers,
  onError: (error: unknown) => void
): () => void {
  let alive = true;
  const registered: Array<() => void> = [];
  const release = () => {
    for (const off of registered.splice(0)) off();
  };
  const register = async (event: string, handler: (event: { payload: unknown }) => void) => {
    const off = await listen(event, handler);
    if (alive) registered.push(off);
    else off();
    return alive;
  };
  void (async () => {
    if (!(await register(DOCK_WINDOW_EVENT, handlers.dock))) return;
    await register(GLOBAL_AGENT_EVENT, () => handlers.globalAgent());
  })().catch((error) => {
    release();
    onError(error);
  });
  return () => {
    alive = false;
    release();
  };
}
