import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BROWSER_STATUS,
  LAUNCH_CHECK_DELAY_MS,
  UPDATE_STATUS_EVENT,
  normalizeUpdateStatus,
  restartToUpdate,
  supersedes,
  type RestartDeps,
  type UpdateStatus,
} from "../lib/updates";

/**
 * Main-window cache of the native update status. Settings reads it
 * synchronously (`useSyncExternalStore`), so the launch check's result shows
 * the moment Settings opens. It lives outside the app store: progress events
 * never re-render the shell.
 */
let snapshot: UpdateStatus = BROWSER_STATUS;
const listeners = new Set<() => void>();

export function getUpdateStatus(): UpdateStatus {
  return snapshot;
}

export function subscribeUpdateStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Publish a native status unless a newer one already arrived. */
function publish(next: UpdateStatus): void {
  if (!supersedes(next, snapshot)) return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

function publishNative(payload: unknown): void {
  publish(normalizeUpdateStatus(payload));
}

function publishError(reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason);
  publish({ ...snapshot, state: "error", message: message || "The update check failed." });
}

/** Check now. With `download` (Automatic updates on), an update downloads at once. */
export async function checkForUpdates(download: boolean): Promise<void> {
  try {
    publishNative(await invoke("updater_check", { download }));
  } catch (reason) {
    publishError(reason);
  }
}

/** "Download and install" for a version a check-only run found. */
export async function downloadUpdate(): Promise<void> {
  try {
    publishNative(await invoke("updater_download"));
  } catch (reason) {
    publishError(reason);
  }
}

/** Stop an in-flight download (Automatic updates turned off). */
export async function cancelUpdateDownload(): Promise<void> {
  try {
    publishNative(await invoke("updater_cancel"));
  } catch (reason) {
    publishError(reason);
  }
}

/** Returns "" once the relaunch is under way, else a short reason to show. */
export function restartForUpdate(guard: Omit<RestartDeps, "restart">): Promise<string> {
  return restartToUpdate({ ...guard, restart: () => invoke("updater_restart") });
}

export interface UpdateWatcherOptions {
  /** The "Automatic updates" setting; off means no launch check at all. */
  autoCheck: boolean;
  /** Test seam; defaults to an idle callback after `LAUNCH_CHECK_DELAY_MS`. */
  schedule?: (run: () => void) => () => void;
}

function idleAfterDelay(run: () => void): () => void {
  let idle: number | undefined;
  const timer = setTimeout(() => {
    if (typeof requestIdleCallback === "function") idle = requestIdleCallback(run, { timeout: 5_000 });
    else run();
  }, LAUNCH_CHECK_DELAY_MS);
  return () => {
    clearTimeout(timer);
    if (idle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
  };
}

/**
 * Main window only: follow native status events, load the cached status,
 * and with automatic updates on, start the background launch check (with
 * download) once the window has settled. Returns a disposer.
 */
export function watchUpdates({ autoCheck, schedule = idleAfterDelay }: UpdateWatcherOptions): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let cancelCheck: (() => void) | undefined;
  void listen<unknown>(UPDATE_STATUS_EVENT, (event) => publishNative(event.payload))
    .then(async (stop) => {
      if (disposed) { stop(); return; }
      unlisten = stop;
      publishNative(await invoke("updater_status"));
      if (!disposed && autoCheck) cancelCheck = schedule(() => { if (!disposed) void checkForUpdates(true); });
    })
    .catch(publishError);
  return () => {
    disposed = true;
    unlisten?.();
    cancelCheck?.();
  };
}
