import type { PaneView } from "../types";

export const DOCK_WINDOW_EVENT = "mesa://dock-window";
export const GLOBAL_AGENT_EVENT = "mesa://global-agent";
// Broadcast (all windows) the instant a Pi terminal session receives its
// first real keystroke. Every Mesa surface that can host the shared Pi
// session — main-window modal/overlay/workspace pane, and any popped-out Pi
// OS window that reattached to the same backend session — tracks its own
// local "has this session been talked to yet" flag so it knows whether it's
// safe to silently relaunch `pi` on a startup-context change. That flag only
// updates from `onData` in whichever window the user is actually typing
// into, so without this broadcast a *different* window holding the same
// session id could still think it's untouched and kill the live process out
// from under the user (e.g. type in the popped-out window, then dock back).
export const PI_INPUT_SEEN_EVENT = "mesa://pi-input-seen";

export type DockWindowPayload =
  | { kind: "doc"; relPath: string }
  | { kind: "panel"; view: PaneView; relPath?: string | null }
  | { kind: "agent" };

export function isDockableView(value: unknown): value is PaneView {
  return (
    value === "doc" ||
    value === "agent" ||
    value === "preview" ||
    value === "graph" ||
    value === "tasks"
  );
}

export function normalizeDockWindowPayload(
  value: unknown
): DockWindowPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  if (payload.kind === "agent") return { kind: "agent" };
  if (payload.kind === "doc" && typeof payload.relPath === "string") {
    const relPath = payload.relPath.trim();
    return relPath ? { kind: "doc", relPath } : null;
  }
  if (payload.kind === "panel" && isDockableView(payload.view)) {
    return {
      kind: "panel",
      view: payload.view,
      relPath:
        typeof payload.relPath === "string" && payload.relPath.trim()
          ? payload.relPath.trim()
          : null,
    };
  }
  return null;
}

export async function dockIntoMainWindow(payload: DockWindowPayload): Promise<void> {
  const [{ emitTo }, { getCurrentWebviewWindow }] = await Promise.all([
    import("@tauri-apps/api/event"),
    import("@tauri-apps/api/webviewWindow"),
  ]);
  await emitTo("main", DOCK_WINDOW_EVENT, payload);
  await getCurrentWebviewWindow().close();
}

export async function closeCurrentPopoutWindow(): Promise<void> {
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().close();
}
