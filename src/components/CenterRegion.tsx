import { useAppStore } from "../store";
import { startViewDrag } from "./panelDrag";
import { VIEW_LABEL, ViewTitle, handleWorkspacePiTearOff, viewContent } from "./workspaceViews";

/** The center region: one workspace view with a drag-to-swap header. */
export function CenterRegion() {
  const centerView = useAppStore((s) => s.settings.centerView);
  const drag = useAppStore((s) => s.dragView);
  const draggingFile = useAppStore((s) => s.draggingFile);
  const keyboardFocus = useAppStore((s) => s.keyboardFocus);
  const closeCenter = useAppStore((s) => s.closeCenter);

  return (
    <main
      className={
        "center" +
        (drag || draggingFile ? " drop-target" : "") +
        (keyboardFocus.region === "center" ? " kbd-focus" : "")
      }
      data-region="center"
    >
      {centerView !== "agent" && <div
        className={"center-head" + (centerView === "empty" ? " empty" : "")}
        onPointerDown={(e) => {
          if (centerView !== "empty") startViewDrag(centerView, "center", e);
        }}
        title={
          centerView === "empty"
            ? "Center is empty"
            : "Drag to swap this view with the right side"
        }
      >
        <span className="region-grip" aria-hidden="true">
          ⠿
        </span>
        <ViewTitle view={centerView} />
        {centerView !== "empty" && (
          <button
            className="stack-btn"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={closeCenter}
            title={`Close ${VIEW_LABEL[centerView]} view`}
            aria-label={`Close ${VIEW_LABEL[centerView]} view`}
          >
            ×
          </button>
        )}
      </div>}
      <div className="center-body">
        {viewContent(
          centerView,
          centerView === "agent"
            ? {
                windowTitle: "Pi agent",
                onTitleBarPointerDown: (event) => startViewDrag("agent", "center", event),
                onTitleBarKeyDown: handleWorkspacePiTearOff,
                titleBarHint: "Drag to move or separate · Ctrl/Cmd+Shift+Enter separates",
                onClose: closeCenter,
              }
            : undefined
        )}
      </div>
      {drag ? (
        <div className="region-drop-hint">Drop {VIEW_LABEL[drag.view]} here</div>
      ) : draggingFile ? (
        <div className="region-drop-hint">Open file here</div>
      ) : null}
    </main>
  );
}
