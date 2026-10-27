export interface CloseRequest { preventDefault(): void }
export interface CloseWindow {
  onCloseRequested(callback: (event: CloseRequest) => Promise<void>): Promise<() => void>;
  close(): Promise<void>;
}
export type BlockedClose = (reason: unknown) => Promise<"keep" | "discard">;

/** Timeout ends the close attempt, not the underlying verified write. */
export async function flushBeforeClose(flush: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([flush(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Saving has taken more than 15 seconds.")), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** A verified flush grants one close request, unless the user explicitly abandons edits. */
export function installCloseGuard(window: CloseWindow, flush: () => Promise<void>, pending: () => boolean, error: (message: string) => void, onBlocked?: BlockedClose): () => void {
  let disposed = false, flushing = false, authorized = false, forced = false;
  let unlisten: (() => void) | undefined;
  void window.onCloseRequested(async event => {
    if (disposed) return;
    if (forced) { forced = false; return; }
    if (authorized && !pending()) { authorized = false; return; }
    authorized = false;
    event.preventDefault();
    if (flushing) return;
    flushing = true;
    try {
      try { await flushBeforeClose(flush); }
      catch (reason) {
        if (disposed) return;
        error(`Close stopped: ${String(reason)}`);
        if (!onBlocked || await onBlocked(reason) !== "discard" || disposed) return;
        forced = true;
      }
      if (disposed) return;
      flushing = false;
      authorized = !forced;
      await window.close();
    } catch (reason) {
      authorized = false;
      forced = false;
      if (!disposed) error(`Close stopped: ${String(reason)}`);
    } finally { flushing = false; }
  }).then(stop => { if (disposed) stop(); else unlisten = stop; })
    .catch(reason => { if (!disposed) error(`Close safety failed to start: ${String(reason)}`); });
  return () => { disposed = true; unlisten?.(); };
}

export interface PendingEditState {
  flushSave(): Promise<void>;
  textSaveState: { pending: number };
  dirtyBinaryPaths: readonly string[];
}
/** Close/Quit checks: flush text saves, then refuse while a PDF editor holds unsaved edits. */
export function pendingEditGuard(state: () => PendingEditState) {
  return {
    flush: async (): Promise<void> => {
      await state().flushSave();
      const pdfs = state().dirtyBinaryPaths;
      if (pdfs.length) throw new Error(`Save the PDF edits in ${pdfs.join(", ")} first`);
    },
    pending: (): boolean => state().textSaveState.pending > 0 || state().dirtyBinaryPaths.length > 0,
  };
}
