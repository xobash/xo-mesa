import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { IN_TAURI } from "../lib/vault";

interface DragPayload {
  type?: "enter" | "over" | "leave" | "drop";
  paths?: string[];
}

/**
 * Full-window drag-and-drop import. OS file drops don't fire DOM drop events in
 * a Tauri webview, so we listen to the native onDragDropEvent. Files are copied
 * into the vault (images → attachments/, .zip extracted). Browser demo: inert.
 */
export function DropOverlay() {
  const [active, setActive] = useState(false);
  const importDropped = useAppStore((s) => s.importDropped);

  useEffect(() => {
    if (!IN_TAURI) return;
    let unlisten: (() => void) | undefined;
    let lastDrop = 0;
    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      unlisten = await getCurrentWebview().onDragDropEvent(
        (event: { payload: DragPayload }) => {
          const type = event.payload?.type;
          if (type === "enter" || type === "over") setActive(true);
          else if (type === "leave") setActive(false);
          else if (type === "drop") {
            setActive(false);
            const now = Date.now();
            if (now - lastDrop < 400) return; // dedupe known double-fire
            lastDrop = now;
            // be tolerant of payload shape differences across Tauri versions
            const p = event.payload as DragPayload & { paths?: string[] };
            const paths: string[] = Array.isArray(p?.paths)
              ? p.paths
              : Array.isArray(event.payload as unknown as string[])
              ? (event.payload as unknown as string[])
              : [];
            if (paths.length) {
              void importDropped(paths);
            } else {
              useAppStore.setState({ status: "Drop received no file paths." });
            }
          }
        }
      );
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [importDropped]);

  if (!active) return null;
  return (
    <div className="drop-overlay">
      <div className="drop-card">
        <div className="drop-icon">⤓</div>
        <div className="drop-title">Drop to add to your vault</div>
        <div className="drop-sub">Notes, images, PDFs &amp; .zip archives</div>
      </div>
    </div>
  );
}
