import { useCallback, type ReactNode } from "react";
import type { OdfPackage } from "../lib/odf/odfPackage";
import type { VaultFile } from "../types";
import { FileFallbackView } from "./FileFallbackView";
import type { OdfEditor } from "./useOdfEditor";
import { usePartBlobUrls } from "./usePartBlobUrls";

// Shared toolbar and notices for the OpenDocument views: read-only until
// Edit, the refusal reasons when editing is off, unsaved state, and the
// verified Save / Save as copy / Discard actions.

export function OdfToolbar<D>({ editor, editable, label, children }: { editor: OdfEditor<D>; editable: boolean; label: string; children?: ReactNode }) {
  const pkg = editor.pkg;
  if (!pkg) return null;
  const policy = pkg.policy;
  return (
    <>
      {editable && (
        <div className="pdf-toolbar pptx-toolbar" role="toolbar" aria-label={label}>
          {!editor.editing ? (
            <button className="btn" disabled={!policy.canEdit} onClick={editor.startEditing}>Edit</button>
          ) : (
            <>
              <button className="btn ghost" onClick={editor.undo} disabled={!editor.canUndo}>Undo</button>
              <button className="btn ghost" onClick={editor.redo} disabled={!editor.canRedo}>Redo</button>
              {children && <span className="pptx-sep" aria-hidden="true" />}
              {children}
              <span className="spacer" />
              {editor.dirty && <span className="pptx-dirty" role="status">Unsaved changes</span>}
              {editor.dirty && <button className="btn ghost" onClick={() => void editor.discard()}>Discard</button>}
              <button className="btn" disabled={!editor.dirty || editor.saving} onClick={() => void editor.saveCopy()}>Save as copy</button>
              <button className="btn primary" disabled={!editor.dirty || editor.saving || editor.diskChanged} onClick={() => void editor.save()}>
                {editor.saving ? "Saving…" : "Save"}
              </button>
              <button className="btn ghost" onClick={() => void editor.finish()}>Done</button>
            </>
          )}
        </div>
      )}
      {editable && !policy.canEdit && <div className="rtf-notice" role="status">Read-only: {policy.refusals.join(" ")}</div>}
      {editor.editing && policy.warnings.length > 0 && <div className="rtf-notice" role="note">{policy.warnings.join(" ")}</div>}
      {editor.status && <div className="pdf-status" role="status">{editor.status}</div>}
    </>
  );
}

const IMAGE_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml" };

/** Blob URLs for package pictures (`usePartBlobUrls`). */
export function useOdfImageUrls(pkg: OdfPackage | null): (part: string) => string | null {
  return usePartBlobUrls(useCallback((part: string) => {
    const bytes = pkg?.parts.get(part);
    const mime = IMAGE_BY_EXT[part.slice(part.lastIndexOf(".") + 1).toLowerCase()];
    return bytes && mime ? { bytes, mime } : null;
  }, [pkg]));
}

/** A file Mesa cannot show as OpenDocument: the reason, then the details view. */
export function OdfFailed({ file, message }: { file: VaultFile; message: string }) {
  return (
    <div className="sheet-view">
      <div className="sheet-notice warn" role="alert">{message}</div>
      <FileFallbackView file={file} />
    </div>
  );
}
