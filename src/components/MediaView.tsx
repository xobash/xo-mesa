import { useCallback } from "react";
import { useAppStore } from "../store";
import { FileKindView } from "./FileKindView";

/** Inline viewer for non-text files (images, video, PDFs, presentations) in the main pane. */
export function MediaView({ rel }: { rel: string }) {
  const file = useAppStore((s) => s.fileFor(rel));
  const setBinaryDirty = useAppStore((s) => s.setBinaryDirty);
  // Unsaved PDF edits exist only in the editor; the store guards close,
  // navigation and vault actions with this flag. PdfView clears it on unmount.
  // RTF, Word, image, presentation and spreadsheet editors report the same way.
  const onDirtyChange = useCallback((dirty: boolean) => setBinaryDirty(rel, dirty), [rel, setBinaryDirty]);
  if (!file) return <div className="editor-empty">File not found.</div>;
  return (
    <div className="media-view">
      <FileKindView rel={rel} file={file} editable onDirtyChange={onDirtyChange} />
    </div>
  );
}
