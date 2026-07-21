import { emitTo } from "@tauri-apps/api/event";
import type { PaneView } from "../types";

export const DOCK_WINDOW_EVENT = "mesa://dock-window";
export const GLOBAL_AGENT_EVENT = "mesa://global-agent";

export type DockWindowPayload =
  | { kind: "doc"; relPath: string }
  | { kind: "panel"; view: PaneView; relPath?: string | null }
  | { kind: "agent" };

interface PhysicalPoint {
  x: number;
  y: number;
}

interface PhysicalRect extends PhysicalPoint {
  width: number;
  height: number;
}

const NATIVE_DOCK_MOVE_THRESHOLD = 24;
const NATIVE_DOCK_RELEASE_DELAY_MS = 180;

function pointInsidePhysicalRect(point: PhysicalPoint, rect: PhysicalRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function shouldDockNativeWindow({
  initial,
  current,
  cursor,
  main,
  pointerWasOutsideMain = true,
}: {
  initial: PhysicalPoint;
  current: PhysicalPoint;
  cursor: PhysicalPoint;
  main: PhysicalRect;
  pointerWasOutsideMain?: boolean;
}): boolean {
  if (!pointerWasOutsideMain) return false;
  if (Math.hypot(current.x - initial.x, current.y - initial.y) < NATIVE_DOCK_MOVE_THRESHOLD) {
    return false;
  }
  return pointInsidePhysicalRect(cursor, main);
}

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
  // webviewWindow stays a dynamic import — it is not in the entry chunk and
  // only popped-out windows ever call this. event.js is already startup code.
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await emitTo("main", DOCK_WINDOW_EVENT, payload);
  await getCurrentWebviewWindow().close();
}

/** Dock after a deliberate native-title-bar drag is released over Mesa. */
export async function installNativeDragDock(
  payload: DockWindowPayload
): Promise<() => void> {
  const [{ getCurrentWindow, cursorPosition }, { WebviewWindow }] = await Promise.all([
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/webviewWindow"),
  ]);
  const currentWindow = getCurrentWindow();
  const initial = await currentWindow.outerPosition();
  const initialMainWindow = await WebviewWindow.getByLabel("main");
  const [initialMainPosition, initialMainSize, initialCursor] = initialMainWindow
    ? await Promise.all([
        initialMainWindow.outerPosition(),
        initialMainWindow.outerSize(),
        cursorPosition(),
      ])
    : [null, null, null];
  let pointerWasOutsideMain =
    !!initialMainPosition &&
    !!initialMainSize &&
    !!initialCursor &&
    !pointInsidePhysicalRect(initialCursor, {
      ...initialMainPosition,
      ...initialMainSize,
    });
  let latest = initial;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  const evaluate = async () => {
    if (finished) return;
    const mainWindow = await WebviewWindow.getByLabel("main");
    if (!mainWindow) return;
    const [mainPosition, mainSize, cursor] = await Promise.all([
      mainWindow.outerPosition(),
      mainWindow.outerSize(),
      cursorPosition(),
    ]);
    if (
      shouldDockNativeWindow({
        initial,
        current: latest,
        cursor,
        main: { ...mainPosition, ...mainSize },
        pointerWasOutsideMain,
      })
    ) {
      finished = true;
      await dockIntoMainWindow(payload);
    }
  };

  const unlisten = await currentWindow.onMoved(({ payload: position }) => {
    latest = position;
    void (async () => {
      const mainWindow = await WebviewWindow.getByLabel("main");
      if (!mainWindow || pointerWasOutsideMain) return;
      const [mainPosition, mainSize, cursor] = await Promise.all([
        mainWindow.outerPosition(),
        mainWindow.outerSize(),
        cursorPosition(),
      ]);
      const inside = pointInsidePhysicalRect(cursor, { ...mainPosition, ...mainSize });
      if (!inside) pointerWasOutsideMain = true;
    })();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void evaluate(), NATIVE_DOCK_RELEASE_DELAY_MS);
  });

  return () => {
    finished = true;
    if (timer) clearTimeout(timer);
    unlisten();
  };
}

export async function startDraggingCurrentWindow(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

export async function closeCurrentPopoutWindow(): Promise<void> {
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().close();
}
