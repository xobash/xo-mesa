import { getStore } from "../store";
import { IN_TAURI } from "../lib/vault";
import type { PaneView } from "../types";
import { hitWorkspaceRegion, type DragFrom } from "../lib/panes";

const VIEW_LABEL: Record<PaneView, string> = {
  doc: "Editor",
  agent: "Pi",
  preview: "Preview",
  graph: "Graph",
  tasks: "Tasks",
};

/**
 * Pointer-drag for a panel — a top-bar handle (`from: "handle"`) or a stacked
 * panel's header (`from: "stack"`). Drop on the right region to add/reorder it
 * (at the position under the pointer); drop outside the window to pop it into
 * its own OS window; a plain click (no drag) runs `onClick`.
 *
 * Pointer-based (not HTML5 draggable) so it never triggers Tauri's native
 * file-drop overlay.
 */
export function startViewDrag(
  view: PaneView,
  from: DragFrom,
  e: React.PointerEvent,
  onClick?: () => void
): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    /* pointer capture is best-effort across webviews */
  }
  document.body.classList.add("is-dragging");
  window.getSelection()?.removeAllRanges();
  const start = { x: e.clientX, y: e.clientY };
  let moved = false;
  let last = start;
  let raf = 0;

  const setGhost = (x: number, y: number) => {
    last = { x, y };
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      getStore().setDragGhost({
        kind: "view",
        label: VIEW_LABEL[view],
        x: last.x,
        y: last.y,
      });
    });
  };

  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    document.body.classList.remove("is-dragging");
    getStore().setDragGhost(null);
  };

  const move = (ev: PointerEvent) => {
    window.getSelection()?.removeAllRanges();
    if (
      !moved &&
      Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 6
    ) {
      moved = true;
      getStore().setDragView({ view, from });
    }
    if (moved) setGhost(ev.clientX, ev.clientY);
  };

  const up = (ev: PointerEvent) => {
    cleanup();
    if (!moved) {
      getStore().setDragView(null);
      onClick?.();
      return;
    }
    const outside =
      ev.clientX < 0 ||
      ev.clientY < 0 ||
      ev.clientX > window.innerWidth ||
      ev.clientY > window.innerHeight;
    if (outside) {
      if (IN_TAURI) {
        if (view === "doc") {
          const active = getStore().activePath;
          if (active) void getStore().openDocWindow(active);
          if (from !== "handle") getStore().removeViewFromWorkspace("doc");
        } else if (view === "agent") {
          void getStore().openAgentWindow();
          if (from !== "handle") getStore().removeViewFromWorkspace("agent");
        } else {
          void getStore().openPanelWindow(view);
          if (from !== "handle") getStore().removeViewFromWorkspace(view);
        }
      }
      getStore().setDragView(null);
      return;
    }
    const centerEl = document.querySelector("[data-region='center']");
    const rightEl = document.querySelector("[data-region='right']");
    const region = hitWorkspaceRegion(
      ev.clientX,
      ev.clientY,
      centerEl?.getBoundingClientRect(),
      rightEl?.getBoundingClientRect()
    );
    if (region === "center") {
      getStore().dropViewInCenter();
      return;
    }
    if (region === "right") {
      // insert at the position under the pointer within the stack
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const paneEl = el?.closest("[data-stack-index]");
      let index = getStore().settings.rightStack.length;
      if (paneEl) {
        const idx = Number(paneEl.getAttribute("data-stack-index"));
        const r = paneEl.getBoundingClientRect();
        index = ev.clientY < r.top + r.height / 2 ? idx : idx + 1;
      }
      getStore().dropViewAt(index);
    } else {
      getStore().setDragView(null);
    }
  };

  const cancel = () => {
    cleanup();
    getStore().setDragView(null);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", cancel);
}
