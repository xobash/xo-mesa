import { Fragment, useRef, useState } from "react";
import { useAppStore } from "../store";
import { startViewDrag } from "./panelDrag";
import { VIEW_LABEL, ViewTitle, handleWorkspacePiTearOff, viewContent } from "./workspaceViews";

/** The right region: a vertical stack of panels (any number visible at once),
 *  each with a header (drag to reorder / edge-tear-off, × to close) and resizable
 *  dividers. Panels are added/removed from the top bar or by dragging here. */
export function RightStack() {
  const stack = useAppStore((s) => s.settings.rightStack);
  const drag = useAppStore((s) => s.dragView);
  const draggingFile = useAppStore((s) => s.draggingFile);
  const keyboardFocus = useAppStore((s) => s.keyboardFocus);
  const removeViewFromWorkspace = useAppStore((s) => s.removeViewFromWorkspace);
  const ref = useRef<HTMLElement | null>(null);
  const [weights, setWeights] = useState<Record<string, number>>({});

  const startStackResize = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    const section = ref.current;
    if (!section) return;
    const above = stack[i - 1];
    const below = stack[i];
    const h = section.clientHeight || 1;
    const wa = weights[above] ?? 1;
    const wb = weights[below] ?? 1;
    const startY = e.clientY;
    const move = (ev: PointerEvent) => {
      const frac = ((ev.clientY - startY) / h) * stack.length;
      setWeights((w) => ({
        ...w,
        [above]: Math.max(0.25, wa + frac),
        [below]: Math.max(0.25, wb - frac),
      }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section
      ref={ref}
      className={
        "right-stack" +
        (drag || draggingFile ? " drop-target" : "") +
        (keyboardFocus.region === "right" ? " kbd-focus" : "") +
        (stack.length === 0 ? " empty" : "")
      }
      data-region="right"
    >
      {stack.length === 0 && !drag && !draggingFile && (
        <div className="stack-empty">
          Drag the editor or a panel here, or use the top bar — Preview · Graph · Tasks.
        </div>
      )}
      {stack.map((p, i) => (
        <Fragment key={p}>
          {i > 0 && (
            <div
              className="stack-divider"
              onPointerDown={(e) => startStackResize(i, e)}
            />
          )}
          <div
            className="stack-pane"
            data-stack-index={i}
            style={{ flexGrow: weights[p] ?? 1 }}
          >
            {p !== "agent" && (
              <div
                className={
                  "stack-head" +
                  (keyboardFocus.region === "right" && keyboardFocus.rightIndex === i
                    ? " kbd-focus"
                    : "")
                }
                onPointerDown={(e) => startViewDrag(p, "stack", e)}
                title="Drag to reorder · drag out to pop into a window"
              >
                <span className="region-grip" aria-hidden="true">⠿</span>
                <ViewTitle view={p} />
                <button
                  className="stack-btn"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => removeViewFromWorkspace(p)}
                  title={`Close ${VIEW_LABEL[p]} view`}
                  aria-label={`Close ${VIEW_LABEL[p]} view`}
                >
                  ×
                </button>
              </div>
            )}
            <div className="stack-body">
              {viewContent(
                p,
                p === "agent"
                  ? {
                      windowTitle: "Pi agent",
                      onTitleBarPointerDown: (event) => startViewDrag("agent", "stack", event),
                      onTitleBarKeyDown: handleWorkspacePiTearOff,
                      titleBarHint: "Drag to move or separate · Ctrl/Cmd+Shift+Enter separates",
                      onClose: () => removeViewFromWorkspace("agent"),
                    }
                  : undefined
              )}
            </div>
          </div>
        </Fragment>
      ))}
      {drag ? (
        <div className="region-drop-hint">Drop {VIEW_LABEL[drag.view]} here</div>
      ) : draggingFile ? (
        <div className="region-drop-hint">Open file here</div>
      ) : null}
    </section>
  );
}
