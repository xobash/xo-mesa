import { useEffect, useMemo } from "react";
import { useAppStore } from "../store";
import type { RightPanel } from "../types";
import { closeCurrentPopoutWindow, dockIntoMainWindow, installNativeDragDock } from "../lib/windowDock";
import { panelContent } from "./workspaceViews";

/** A panel rendered standalone in its own OS window (?panel=…). */
export function PanelWindow({
  kind,
  graphWindowBootstrapped,
}: {
  kind: RightPanel;
  /** The graph window started from a main-window snapshot and refreshes from disk shortly after. */
  graphWindowBootstrapped: boolean;
}) {
  const routeParams = useMemo(() => new URLSearchParams(location.search), []);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const activePath = useAppStore((s) => s.activePath);
  const selectFile = useAppStore((s) => s.selectFile);
  const openVault = useAppStore((s) => s.openVault);
  // The note this panel should follow (so a popped-out Preview shows the same
  // document as the pane it came from), passed as ?sel= in the URL.
  const sel = routeParams.get("sel");
  const requestedVault = routeParams.get("vault");
  useEffect(() => {
    if (vaultPath && sel) void selectFile(sel);
  }, [vaultPath, sel, selectFile]);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void installNativeDragDock({
      kind: "panel",
      view: kind,
      relPath: activePath ?? sel,
    })
      .then((cleanup) => (dispose = cleanup))
      .catch((error) => console.warn("[mesa] native panel docking unavailable:", error));
    return () => dispose?.();
  }, [kind, activePath, sel]);
  useEffect(() => {
    if (!graphWindowBootstrapped || !requestedVault) return;
    const refresh = () => void openVault(requestedVault);
    const id = window.setTimeout(refresh, 1200);
    return () => window.clearTimeout(id);
  }, [graphWindowBootstrapped, requestedVault, openVault]);

  // Graph fills the native window. Drag its OS title bar over Mesa to dock it.
  if (kind === "graph") {
    return (
      <div className="panel-window panel-window-chromeless">
        <div className="panel-window-body">
          {vaultPath ? panelContent(kind) : <div className="editor-empty">Loading…</div>}
        </div>
      </div>
    );
  }

  const title = kind[0].toUpperCase() + kind.slice(1);
  return (
    <div className="panel-window">
      <header className="doc-window-bar">
        <span>{title}</span>
        <div className="dock-actions">
          <button
            className="dock-btn"
            onClick={() =>
              void dockIntoMainWindow({
                kind: "panel",
                view: kind,
                relPath: activePath ?? sel,
              })
            }
          >
            Dock
          </button>
          <button
            className="icon-btn"
            onClick={() => void closeCurrentPopoutWindow()}
            aria-label={`Close ${title} window`}
          >
            ×
          </button>
        </div>
      </header>
      <div className="panel-window-body">
        {vaultPath ? (
          panelContent(kind)
        ) : (
          <div className="editor-empty">Loading…</div>
        )}
      </div>
    </div>
  );
}
