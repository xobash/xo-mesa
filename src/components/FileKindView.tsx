import { lazy, Suspense } from "react";
import type { VaultFile } from "../types";
import { urlForPath, fileKind, isWordExt } from "../lib/vault";
import { isOpenDocumentExt, isPresentationExt } from "../lib/officeFormats";
import { RtfView } from "./LazyRtfView";
import { WordView } from "./LazyWordView";
import { SpreadsheetView } from "./LazySpreadsheetView";
import { HtmlView } from "./LazyHtmlView";
import { ImageMediaView } from "./ImageMediaView";
import { AudioPlayer, VideoPlayer } from "./MediaPlayer";
import { VaultImage } from "./VaultImage";

// Heavy engines stay out of the entry chunk: each loads only when its kind opens.
const PdfView = lazy(() => import("./PdfView").then((m) => ({ default: m.PdfView })));
const PresentationView = lazy(() => import("./PresentationView").then((m) => ({ default: m.PresentationView })));
const OpenDocumentView = lazy(() => import("./OpenDocumentView").then((m) => ({ default: m.OpenDocumentView })));
// Details, hex, archive, book and legacy Office views for every other file type.
const FileFallbackView = lazy(() => import("./FileFallbackView").then((m) => ({ default: m.FileFallbackView })));

export interface FileKindViewProps {
  rel: string;
  file: VaultFile;
  /** Main pane only: surfaces without the store's unsaved-edit guard stay view-only. */
  editable?: boolean;
  /** Dirty reports for editors; PDFs also report from detached windows. */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * The one kind-to-viewer route for non-text files. The main pane, detached
 * document windows and the browser popout all render through it, so every
 * kind has a viewer everywhere; unknown kinds get `FileFallbackView`.
 */
export function FileKindView({ rel, file, editable = false, onDirtyChange }: FileKindViewProps) {
  const src = urlForPath(file.path);
  const kind = fileKind(file.ext);
  const dirty = editable ? onDirtyChange : undefined;
  if (kind === "image") {
    return editable && onDirtyChange
      ? <ImageMediaView key={rel} file={file} onDirtyChange={onDirtyChange} />
      : <VaultImage className="doc-media" src={src} alt={file.name} />;
  }
  if (kind === "video") return <VideoPlayer key={src} className="media-el" src={src} name={file.name} ext={file.ext} />;
  if (kind === "audio") return <AudioPlayer key={src} src={src} name={file.name} ext={file.ext} />;
  if (kind === "pdf") {
    return (
      <Suspense fallback={<div className="editor-empty">Loading PDF editor…</div>}>
        <PdfView rel={rel} file={file} onDirtyChange={onDirtyChange} />
      </Suspense>
    );
  }
  if (kind === "rtf") return <RtfView key={rel} rel={rel} file={file} editable={editable} onDirtyChange={dirty} />;
  if (kind === "spreadsheet") return <SpreadsheetView key={rel} rel={rel} file={file} editable={editable} onDirtyChange={dirty} />;
  if (kind === "html") return <HtmlView rel={rel} file={file} />;
  if (isPresentationExt(file.ext)) {
    return (
      <Suspense fallback={<div className="editor-empty">Loading presentation…</div>}>
        <PresentationView key={rel} file={file} editable={editable} onDirtyChange={dirty} />
      </Suspense>
    );
  }
  if (isOpenDocumentExt(file.ext)) {
    return (
      <Suspense fallback={<div className="editor-empty">Loading document…</div>}>
        <OpenDocumentView key={rel} file={file} editable={editable} onDirtyChange={dirty} />
      </Suspense>
    );
  }
  if (isWordExt(file.ext)) return <WordView key={rel} rel={rel} file={file} editable={editable} onDirtyChange={dirty} />;
  return (
    <Suspense fallback={<div className="editor-empty">Loading file details…</div>}>
      <FileFallbackView file={file} />
    </Suspense>
  );
}
