import { getStore } from "../store";
import { hitWorkspaceRegion } from "../lib/panes";

/**
 * Pointer-drag a file from the sidebar. A plain click runs `onClick` (open in
 * the editor). A drag drops it where you let go:
 *   • a region showing the editor → open it there
 *   • a region showing a panel    → switch that region to Preview and show it
 *   • outside the app             → pop it into its own window
 * Pointer-based (not HTML5 drag) so Tauri's native file-drop never triggers.
 */
export function startFileDrag(
  rel: string,
  e: React.PointerEvent,
  onClick: () => void
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
  const label = rel.split("/").pop() ?? rel;

  const setGhost = (x: number, y: number) => {
    last = { x, y };
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      getStore().setDragGhost({ kind: "file", label, x: last.x, y: last.y });
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
    getStore().setDraggingFile(null);
  };

  const move = (ev: PointerEvent) => {
    window.getSelection()?.removeAllRanges();
    if (!moved && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 6) {
      moved = true;
      getStore().setDraggingFile(rel);
    }
    if (moved) setGhost(ev.clientX, ev.clientY);
  };

  const up = (ev: PointerEvent) => {
    cleanup();
    if (!moved) {
      onClick();
      return;
    }
    const outside =
      ev.clientX < 0 ||
      ev.clientY < 0 ||
      ev.clientX > window.innerWidth ||
      ev.clientY > window.innerHeight;
    const centerEl = document.querySelector("[data-region='center']");
    const rightEl = document.querySelector("[data-region='right']");
    const region = hitWorkspaceRegion(
      ev.clientX,
      ev.clientY,
      centerEl?.getBoundingClientRect(),
      rightEl?.getBoundingClientRect()
    );
    if (region === "right") {
      const s = getStore();
      // dropped on the right region -> put the document view there, then show it
      if (!s.settings.rightStack.includes("doc")) s.moveViewToRight("doc");
      void s.selectFile(rel);
    } else if (region === "center") {
      const s = getStore();
      if (s.settings.centerView !== "doc") s.moveViewToCenter("doc");
      void s.selectFile(rel);
    } else if (outside) {
      void getStore().openDocWindow(rel); // dragged OUT of the app → own window
    } else {
      void getStore().selectFile(rel); // default: open in the editor
    }
  };

  const cancel = () => {
    cleanup();
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", cancel);
}
