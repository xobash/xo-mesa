import { clamp } from "../lib/clamp";

export interface PaneResizeDrag {
  /** Layout element whose CSS width variables preview the drag. */
  el: HTMLElement;
  /** CSS variables that carry the width (e.g. `--sidebar-w`). */
  vars: readonly string[];
  startX: number;
  startWidth: number;
  min: number;
  max: number;
  /** +1 when dragging right widens the pane, -1 when it narrows it. */
  sign: 1 | -1;
  commit(width: number): void;
}

/**
 * Drag a pane border: the width updates live on the element and commits on
 * pointerup. A pointercancel (lost capture, OS gesture) restores the start
 * width without committing. Both end the drag and remove every window
 * listener, so a later stray pointerup never commits an old width. The
 * returned function cancels a drag still in progress.
 */
export function startPaneResizeDrag(drag: PaneResizeDrag): () => void {
  const { el, vars, startX, startWidth, min, max, sign } = drag;
  let width: number | null = null;
  let active = true;
  const show = (value: number) => {
    for (const name of vars) el.style.setProperty(name, value + "px");
  };
  const move = (ev: PointerEvent) => {
    width = clamp(startWidth + sign * (ev.clientX - startX), min, max);
    show(width);
  };
  const stop = () => {
    active = false;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
  };
  const up = () => {
    stop();
    if (width !== null) drag.commit(width);
  };
  const cancel = () => {
    if (!active) return;
    stop();
    if (width !== null) show(startWidth);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  return cancel;
}
