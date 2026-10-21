import type { PaneView, RightPanel, WorkspaceView } from "../types";

/**
 * Split-view workspace logic — pure so drag/toggle behavior is unit-tested.
 * The workspace shows at most two panes: the center and ONE side pane. A view
 * can exist in exactly one place at a time. Opening or dropping a view onto an
 * occupied pane replaces that pane; moving a view between the two panes swaps
 * them. Replaced views close and stay available from the top bar.
 */
export type DragFrom = "handle" | "stack" | "center";

export interface PaneDrag {
  view: PaneView;
  from: DragFrom;
}

/** Number of side panes beside the center: split view has exactly one. */
const SIDE_PANES = 1;

/** Clamp a side list to the split-view limit. */
function splitSide(stack: PaneView[]): PaneView[] {
  return stack.slice(0, SIDE_PANES);
}

/** Add `view` if absent, remove it if present (top-bar button behaviour). */
export function togglePanel(stack: PaneView[], view: RightPanel): PaneView[] {
  return stack.includes(view)
    ? stack.filter((v) => v !== view)
    : [...stack, view];
}

/** Remove a panel from the stack. */
export function removeView(stack: PaneView[], view: PaneView): PaneView[] {
  return stack.filter((v) => v !== view);
}


export interface WorkspacePlacement {
  centerView: WorkspaceView;
  rightStack: PaneView[];
}

/** Keep the visible workspace filled: if the center is empty but a side view
 * exists, promote it into the main region. */
export function fillWorkspace(
  centerView: WorkspaceView,
  rightStack: PaneView[]
): WorkspacePlacement {
  if (centerView !== "empty" || rightStack.length === 0) {
    return { centerView, rightStack: splitSide(rightStack) };
  }
  const [nextCenter, ...nextRight] = rightStack;
  return { centerView: nextCenter, rightStack: splitSide(nextRight) };
}

/** Move a view into the center: a side view swaps with the center; any other
 * view replaces the center. */
export function placeInCenter(
  centerView: WorkspaceView,
  rightStack: PaneView[],
  view: PaneView
): WorkspacePlacement {
  if (view === centerView) return { centerView, rightStack: splitSide(rightStack) };
  if (rightStack.includes(view)) {
    return { centerView: view, rightStack: centerView === "empty" ? [] : [centerView] };
  }
  return { centerView: view, rightStack: splitSide(rightStack) };
}

/** Move a view into the side pane: the center view swaps with the side view;
 * any other view replaces the side view. `index` is kept for drop-target
 * callers; split view has a single side slot. */
export function placeInRight(
  centerView: WorkspaceView,
  rightStack: PaneView[],
  view: PaneView,
  _index: number
): WorkspacePlacement {
  if (view !== centerView) return { centerView, rightStack: [view] };
  const replacement = rightStack.find((v) => v !== view) ?? "empty";
  return { centerView: replacement, rightStack: [view] };
}

export function closeCenterView(
  centerView: WorkspaceView,
  rightStack: PaneView[]
): WorkspacePlacement {
  if (centerView === "empty") return { centerView, rightStack: splitSide(rightStack) };
  return fillWorkspace("empty", rightStack);
}

export function removeFromWorkspace(
  centerView: WorkspaceView,
  rightStack: PaneView[],
  view: PaneView
): WorkspacePlacement {
  if (centerView === view) return closeCenterView(centerView, rightStack);
  return fillWorkspace(centerView, removeView(rightStack, view));
}

/** Top-bar toggle behavior for workspace panels. The first opened view claims
 * an empty workspace; the next one becomes (or replaces) the side pane. */
export function toggleWorkspacePanel(
  centerView: WorkspaceView,
  rightStack: PaneView[],
  panel: RightPanel
): WorkspacePlacement {
  if (centerView === "empty") {
    return { centerView: panel, rightStack: [] };
  }
  if (centerView === panel || rightStack.includes(panel)) {
    return removeFromWorkspace(centerView, rightStack, panel);
  }
  return { centerView, rightStack: [panel] };
}

/** Opening/spawning a view fills an empty workspace first, then the side pane
 * (replacing its current view). */
export function openViewInWorkspace(
  centerView: WorkspaceView,
  rightStack: PaneView[],
  view: PaneView
): WorkspacePlacement {
  if (centerView === "empty") {
    return { centerView: view, rightStack: [] };
  }
  if (centerView === view || rightStack.includes(view)) {
    return { centerView, rightStack: splitSide(rightStack) };
  }
  return { centerView, rightStack: [view] };
}

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type WorkspaceHit = "center" | "right" | null;

function contains(rect: RectLike | null | undefined, x: number, y: number): boolean {
  return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** Coordinate-based drop target detection. This is more reliable than
 * `elementFromPoint` during drags because drag ghosts, iframes, and transient
 * overlays can obscure the actual workspace element under the pointer. */
export function hitWorkspaceRegion(
  x: number,
  y: number,
  center: RectLike | null | undefined,
  right: RectLike | null | undefined
): WorkspaceHit {
  if (contains(right, x, y)) return "right";
  if (contains(center, x, y)) return "center";
  return null;
}
