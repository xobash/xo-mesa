import type { PaneView, RightPanel, WorkspaceView } from "../types";

/**
 * Two-region workspace logic — pure so drag/toggle behavior is unit-tested.
 * The center region and right stack can host the document view or utility
 * panels. A view can exist in exactly one place at a time.
 */
export type DragFrom = "handle" | "stack" | "center";

export interface PaneDrag {
  view: PaneView;
  from: DragFrom;
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

/**
 * Place `view` at `index` (removing any existing copy first, then clamping).
 * Used for both adding from a handle and reordering within the stack.
 */
export function placeView(
  stack: PaneView[],
  view: PaneView,
  index: number
): PaneView[] {
  const without = stack.filter((v) => v !== view);
  const i = Math.max(0, Math.min(index, without.length));
  return [...without.slice(0, i), view, ...without.slice(i)];
}

export interface WorkspacePlacement {
  centerView: WorkspaceView;
  rightStack: PaneView[];
}

/** Keep the visible workspace filled: if the center is empty but stacked views
 * exist, promote the first stacked view into the main region. */
export function fillWorkspace(
  centerView: WorkspaceView,
  rightStack: PaneView[]
): WorkspacePlacement {
  if (centerView !== "empty" || rightStack.length === 0) {
    return { centerView, rightStack };
  }
  const [nextCenter, ...nextRight] = rightStack;
  return { centerView: nextCenter, rightStack: nextRight };
}

/** Move or swap a view into the center region. */
export function placeInCenter(
  centerView: WorkspaceView,
  rightStack: PaneView[],
  view: PaneView
): WorkspacePlacement {
  if (view === centerView) return { centerView, rightStack };
  const oldIndex = rightStack.indexOf(view);
  const withoutDragged = rightStack.filter((v) => v !== view);
  const insertAt = oldIndex >= 0 ? Math.min(oldIndex, withoutDragged.length) : 0;
  const nextRight = centerView === "empty" || withoutDragged.includes(centerView)
    ? withoutDragged
    : [
        ...withoutDragged.slice(0, insertAt),
        centerView,
        ...withoutDragged.slice(insertAt),
      ];
  return { centerView: view, rightStack: nextRight };
}

/** Move or reorder a view inside the right stack, choosing a replacement center
 * when the view came from the center. */
export function placeInRight(
  centerView: WorkspaceView,
  rightStack: PaneView[],
  view: PaneView,
  index: number
): WorkspacePlacement {
  if (view !== centerView) {
    return { centerView, rightStack: placeView(rightStack, view, index) };
  }

  const candidates = rightStack.filter((v) => v !== view);
  const replacement = candidates[0] ?? "empty";
  if (replacement === centerView) return { centerView, rightStack };

  const withoutReplacement = candidates.filter((v) => v !== replacement);
  return {
    centerView: replacement,
    rightStack: placeView(withoutReplacement, view, index),
  };
}

export function closeCenterView(
  centerView: WorkspaceView,
  rightStack: PaneView[]
): WorkspacePlacement {
  if (centerView === "empty") return { centerView, rightStack };
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

/** Top-bar toggle behavior for workspace panels. The first opened view should
 * claim an empty workspace before stacking anything on the side. */
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
  return { centerView, rightStack: [...rightStack, panel] };
}

/** Opening/spawning a view should fill an empty workspace before creating a
 * side split. Explicit drag-to-right still uses `placeInRight`. */
export function openViewInWorkspace(
  centerView: WorkspaceView,
  rightStack: PaneView[],
  view: PaneView
): WorkspacePlacement {
  if (centerView === "empty") {
    return { centerView: view, rightStack: [] };
  }
  if (centerView === view || rightStack.includes(view)) {
    return { centerView, rightStack };
  }
  return { centerView, rightStack: [...rightStack, view] };
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
