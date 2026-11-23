import { lazy, Suspense, useState } from "react";
import { imageEditRefusalForExt } from "../lib/imageEditFormats";
import { urlForPath } from "../lib/vault";
import type { VaultFile } from "../types";
import { VaultImage } from "./VaultImage";

// Canvas editing loads only when the user asks to edit.
const ImageEditor = lazy(() => import("./ImageEditor").then((m) => ({ default: m.ImageEditor })));

/** Main-pane image: the native viewer, plus an editor for PNG, JPEG and WebP. */
export function ImageMediaView({ file, onDirtyChange }: { file: VaultFile; onDirtyChange: (dirty: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  if (editing) {
    return (
      <Suspense fallback={<div className="editor-empty">Loading image editor…</div>}>
        <ImageEditor file={file} onDirtyChange={onDirtyChange} onDone={() => setEditing(false)} />
      </Suspense>
    );
  }
  return (
    <div className="image-view">
      <VaultImage key={file.mtime ?? 0} className="media-el" src={urlForPath(file.path)} alt={file.name} />
      <div className="image-view-bar">
        {reason && <span className="image-view-reason" role="status">{reason}</span>}
        <button className="btn ghost" onClick={() => {
          const refusal = imageEditRefusalForExt(file.ext);
          setReason(refusal);
          if (!refusal) setEditing(true);
        }}>Edit image</button>
      </div>
    </div>
  );
}
