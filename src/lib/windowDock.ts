import type { PaneView } from "../types";

export const DOCK_WINDOW_EVENT = "mesa://dock-window";
export const GLOBAL_AGENT_EVENT = "mesa://global-agent";

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
