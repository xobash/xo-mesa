export interface CloseRequest { preventDefault(): void }
export interface CloseWindow {
  onCloseRequested(callback: (event: CloseRequest) => Promise<void>): Promise<() => void>;
  close(): Promise<void>;
}
/** A verified flush grants one close request, and only while no new edits exist. */
export function installCloseGuard(window: CloseWindow, flush: () => Promise<void>, pending: () => boolean, error: (message: string) => void): () => void {
  let disposed = false, flushing = false, authorized = false;
  let unlisten: (() => void) | undefined;
  void window.onCloseRequested(async event => {
    if (disposed) return;
    if (authorized && !pending()) { authorized = false; return; }
    authorized = false;
    event.preventDefault();
    if (flushing) return;
    flushing = true;
    try {
      await flush();
      if (disposed) return;
      // Release admission before close(), which may synchronously emit the next request.
      flushing = false;
      authorized = true;
      await window.close();
    } catch (reason) {
      authorized = false;
      if (!disposed) error(`Close stopped: ${String(reason)}`);
    } finally { flushing = false; }
  }).then(stop => { if (disposed) stop(); else unlisten = stop; })
    .catch(reason => { if (!disposed) error(`Close safety failed to start: ${String(reason)}`); });
  return () => { disposed = true; unlisten?.(); };
}
