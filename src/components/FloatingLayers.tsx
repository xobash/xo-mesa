import { useAppStore } from "../store";
import { PreviewCard } from "./PreviewCard";

/** Single floating preview card for sidebar files/folders and tag chips. */
export function PreviewLayer() {
  const preview = useAppStore((s) => s.hoverPreview);
  if (!preview) return null;
  return (
    <div className="preview-layer">
      <PreviewCard target={preview.target} x={preview.x} y={preview.y} fixed />
    </div>
  );
}

export function DragGhostLayer() {
  const ghost = useAppStore((s) => s.dragGhost);
  if (!ghost) return null;
  return (
    <div
      className={"drag-ghost " + ghost.kind}
      style={{ transform: `translate3d(${ghost.x + 14}px, ${ghost.y + 14}px, 0)` }}
    >
      {ghost.kind === "file" ? "File" : "Move"} · {ghost.label}
    </div>
  );
}
