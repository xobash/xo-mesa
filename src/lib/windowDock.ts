import { emitTo } from "@tauri-apps/api/event";
import type { PaneView } from "../types";

export const DOCK_WINDOW_EVENT = "mesa://dock-window";
export const GLOBAL_AGENT_EVENT = "mesa://global-agent";

export type DockWindowPayload =
  | { kind: "doc"; relPath: string }
  | { kind: "panel"; view: PaneView; relPath?: string | null }
  | { kind: "agent" };

export interface NativeDragDockOptions {
  /** Ignore native move events until the user presses a DOM drag region.
   * Decorated windows can emit startup position corrections large enough to
   * look like a deliberate move; Pi uses a Mesa-owned drag region, so it can
   * distinguish that correction from a real dock-back gesture. */
  requireUserDragArm?: boolean;
}

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
const NATIVE_DOCK_MIN_MOVE_EVENTS = 3;
const NATIVE_DOCK_MIN_MOVE_SPAN_MS = 80;

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
  dragWasArmed = true,
  nativeMoveCount = NATIVE_DOCK_MIN_MOVE_EVENTS,
  nativeMoveSpanMs = NATIVE_DOCK_MIN_MOVE_SPAN_MS,
}: {
  initial: PhysicalPoint;
  current: PhysicalPoint;
  cursor: PhysicalPoint;
  main: PhysicalRect;
  pointerWasOutsideMain?: boolean;
  dragWasArmed?: boolean;
  nativeMoveCount?: number;
  nativeMoveSpanMs?: number;
}): boolean {
  if (!dragWasArmed || !pointerWasOutsideMain) return false;
  if (
    nativeMoveCount < NATIVE_DOCK_MIN_MOVE_EVENTS ||
    nativeMoveSpanMs < NATIVE_DOCK_MIN_MOVE_SPAN_MS
  ) {
    return false;
  }
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
  payload: DockWindowPayload,
  options: NativeDragDockOptions = {}
): Promise<() => void> {
  const [{ getCurrentWindow, cursorPosition }, { WebviewWindow }] = await Promise.all([
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/webviewWindow"),
  ]);
  const currentWindow = getCurrentWindow();
  let initial = await currentWindow.outerPosition();
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
  let dragArmed = !options.requireUserDragArm;
  let nativeMoveCount = 0;
  let firstNativeMoveAt = 0;
  let lastNativeMoveAt = 0;
  let gestureReleased = false;

  const disarmDockGesture = () => {
    if (!options.requireUserDragArm) return;
    dragArmed = false;
    nativeMoveCount = 0;
    firstNativeMoveAt = 0;
    lastNativeMoveAt = 0;
    gestureReleased = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const armFromDragRegion = (event: PointerEvent) => {
    if (!options.requireUserDragArm || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("button, input, textarea, select, a")) return;
    if (!target.closest("[data-tauri-drag-region]")) return;
    // Use the last native position as the gesture baseline. `onMoved` updates
    // it even while unarmed, so startup frame corrections cannot contribute
    // distance to the user's later drag.
    initial = latest;
    // Dock-back requires this gesture to actually leave Mesa. Do not inherit
    // the cursor state captured during listener installation or assume that a
    // press in the detached title bar began outside the main window.
    pointerWasOutsideMain = false;
    dragArmed = true;
    nativeMoveCount = 0;
    firstNativeMoveAt = 0;
    lastNativeMoveAt = 0;
    gestureReleased = false;
  };
  const finishPointerInteraction = () => {
    gestureReleased = true;
    // A click/focus with no actual native window movement is not a drag and
    // must not leave docking armed for a later startup/focus correction.
    if (nativeMoveCount === 0) {
      disarmDockGesture();
      return;
    }
    // When the webview receives pointerup after native title-bar movement,
    // settle promptly. If the OS consumes pointerup, the existing move-settle
    // timer remains the cross-platform fallback.
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void evaluate(), NATIVE_DOCK_RELEASE_DELAY_MS);
  };
  if (options.requireUserDragArm) {
    document.addEventListener("pointerdown", armFromDragRegion, true);
    window.addEventListener("pointerup", finishPointerInteraction, true);
    window.addEventListener("pointercancel", finishPointerInteraction, true);
  }

  const evaluate = async () => {
    if (finished || !dragArmed) return;
    const mainWindow = await WebviewWindow.getByLabel("main");
    if (!mainWindow) return;
    const [mainPosition, mainSize, cursor] = await Promise.all([
      mainWindow.outerPosition(),
      mainWindow.outerSize(),
      cursorPosition(),
    ]);
    const main = { ...mainPosition, ...mainSize };
    const cursorInsideMain = pointInsidePhysicalRect(cursor, main);
    const nativeMoveSpanMs =
      nativeMoveCount > 1 ? lastNativeMoveAt - firstNativeMoveAt : 0;
    if (
      shouldDockNativeWindow({
        initial,
        current: latest,
        cursor,
        main,
        pointerWasOutsideMain,
        dragWasArmed: dragArmed,
        nativeMoveCount,
        nativeMoveSpanMs,
      })
    ) {
      finished = true;
      await dockIntoMainWindow(payload);
      return;
    }
    // Once native movement has settled over Mesa, an ineligible gesture was a
    // click/jitter/startup correction, not a dock. Disarm it so later focus or
    // layout movement cannot accumulate into a false positive. A real drag
    // paused outside Mesa remains armed and can still continue inward.
    if (cursorInsideMain || gestureReleased) {
      disarmDockGesture();
    }
  };

  const unlisten = await currentWindow.onMoved(({ payload: position }) => {
    latest = position;
    if (!dragArmed) return;
    const now = performance.now();
    if (nativeMoveCount === 0) firstNativeMoveAt = now;
    lastNativeMoveAt = now;
    nativeMoveCount += 1;
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
    document.removeEventListener("pointerdown", armFromDragRegion, true);
    window.removeEventListener("pointerup", finishPointerInteraction, true);
    window.removeEventListener("pointercancel", finishPointerInteraction, true);
    unlisten();
  };
}

export async function closeCurrentPopoutWindow(): Promise<void> {
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().close();
}
