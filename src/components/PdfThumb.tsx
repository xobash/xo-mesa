import { useEffect, useRef, useState } from "react";
import { warmPdfThumb } from "../lib/pdfThumb";

/**
 * A real first-page thumbnail of a PDF, for sidebar/hover previews. pdf.js is
 * dynamically imported so it stays out of the startup bundle and only loads
 * when a PDF is actually previewed.
 */
export function PdfThumb({ path }: { path: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    (async () => {
      try {
        const snapshot = await warmPdfThumb(path);
        const canvas = ref.current;
        if (cancelled || !canvas) return;
        canvas.width = snapshot.width;
        canvas.height = snapshot.height;
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.drawImage(snapshot.canvas, 0, 0);
        if (!cancelled) setReady(true);
      } catch {
        if (!cancelled) setErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (err) return <div className="preview-media-other">Can't preview this PDF</div>;
  return <canvas ref={ref} className={"preview-pdf-canvas" + (ready ? " ready" : "")} />;
}
