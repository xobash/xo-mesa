import { lazy, Suspense } from "react";
import { useAppStore } from "../store";
import { urlForPath, fileKind } from "../lib/vault";
import { warmPdfEngine } from "../lib/pdfThumb";
import { RtfView } from "./RtfView";
import { HtmlView } from "./HtmlView";

// PDF editing pulls in heavy libs (pdf.js + pdf-lib) — load them only when a
// PDF is actually opened so they stay out of the startup bundle.
const PdfView = lazy(() =>
  import("./PdfView").then((m) => ({ default: m.PdfView }))
);

// Prefetch that lazy chunk (and pdf.js's worker for hover thumbnails) once the
// app goes idle. The startup bundle stays lean, but the first PDF open/hover no
// longer pays ~1 MB of module download+parse on the interaction path.
function prefetchPdfStack(): void {
  void import("./PdfView");
  // pdfThumb itself is a tiny always-bundled module (PdfThumb.tsx imports it
  // statically) — the actual prefetch is warmPdfEngine() starting pdf.js.
  warmPdfEngine();
}
if (typeof window !== "undefined") {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => prefetchPdfStack(), { timeout: 4000 });
  } else {
    window.setTimeout(prefetchPdfStack, 2500);
  }
}

/** Inline viewer for non-text files (images, video, PDFs) in the main pane. */
export function MediaView({ rel }: { rel: string }) {
  const fileFor = useAppStore((s) => s.fileFor);
  const openDocWindow = useAppStore((s) => s.openDocWindow);
  const file = fileFor(rel);
  if (!file) return <div className="editor-empty">File not found.</div>;

  const src = urlForPath(file.path);
  const kind = fileKind(file.ext);

  return (
    <div className="media-view">
      {kind === "image" ? (
        <img className="media-el" src={src} alt={file.name} />
      ) : kind === "video" ? (
        <video className="media-el" src={src} controls />
      ) : kind === "pdf" ? (
        <Suspense fallback={<div className="editor-empty">Loading PDF editor…</div>}>
          <PdfView rel={rel} />
        </Suspense>
      ) : kind === "rtf" ? (
        <RtfView rel={rel} />
      ) : kind === "html" ? (
        <HtmlView rel={rel} />
      ) : (
        <div className="media-other">
          <div className="media-ext">{file.ext || "file"}</div>
          <div className="media-name">{file.name}</div>
          <button className="btn" onClick={() => void openDocWindow(rel)}>
            Open in a new window
          </button>
        </div>
      )}
    </div>
  );
}
