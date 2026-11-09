import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { isLikelyBlankPdfPaint } from "../lib/pdfBytes";
import type { StalePages } from "../lib/pdfStalePages";
import { pdfPageWindow } from "../lib/pdfPageWindow";
import {
  pdfCanvasBackingScale,
  pdfPaintAheadPages,
  planPdfCanvasRelease,
} from "../lib/pdfCanvasBudget";
import { pdfPagesToRender } from "../lib/pdfRenderPlan";
import { countPdfPerf, markPdfPerf } from "./pdfPerf";
import { isPdfjsCancellation, nextFrame } from "./pdfjsTasks";

/** Pages kept painted on either side of the ones the viewer says are on screen,
 *  so ordinary scrolling always lands on pixels that are already there. */
const PAINT_AHEAD_PAGES = 3;
/** Painted pages are only released once they fall outside this wider band. The
 *  gap between the two bounds is hysteresis: scrolling back and forth across a
 *  page boundary must not thrash a page between painted and released. */
const RELEASE_AFTER_PAGES = 8;

/** Confirm blank paints against drawing operations; fall back if pdf.js cannot
 * answer. Unreadable canvas pixels are inconclusive. */
export async function paintedBlankUnexpectedly(
  ctx: { getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray } },
  canvas: { width: number; height: number },
  page: Pick<PDFPageProxy, "getOperatorList">
): Promise<boolean> {
  let blank: boolean;
  try {
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    blank = isLikelyBlankPdfPaint(pixels.data, canvas.width, canvas.height);
  } catch {
    // Reading the pixels back can fail on its own; that is not a render failure.
    return false;
  }
  if (!blank) return false;
  try {
    const { fnArray } = await page.getOperatorList();
    return fnArray.length > 0;
  } catch {
    // If pdf.js cannot say, keep the protective behaviour rather than guessing.
    return true;
  }
}

/** The bitmap the page-1 blank check reads. A display-scaled bitmap is
 * first drawn down to the CSS box, so the read-back costs what it did at
 * ratio 1 and a mark that was visible there is still visible. */
function blankProbe(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  viewport: { width: number; height: number }
): [CanvasRenderingContext2D, { width: number; height: number }] {
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  if (canvas.width <= width && canvas.height <= height) return [ctx, canvas];
  const probe = document.createElement("canvas");
  probe.width = width;
  probe.height = height;
  const probeCtx = probe.getContext("2d");
  if (!probeCtx) return [ctx, canvas];
  probeCtx.drawImage(canvas, 0, 0, width, height);
  return [probeCtx, probe];
}

/** State the page painter shares with `usePdfEditor`. Refs and setters are the
 *  editor's own, so edits, canvas binding and document resets stay authoritative. */
export interface PdfPagePaintState {
  enabled: boolean;
  doc: PDFDocumentProxy | null;
  renderScale: number;
  devicePixelRatio: number;
  canvasVersion: number;
  onscreenVersion: number;
  firstPagePainted: boolean;
  lastRenderedDocRef: MutableRefObject<PDFDocumentProxy | null>;
  stalePaintPagesRef: MutableRefObject<StalePages>;
  paintedPagesRef: MutableRefObject<Map<number, number>>;
  allPagesPaintedRef: MutableRefObject<boolean>;
  canvasRefs: MutableRefObject<Map<number, HTMLCanvasElement>>;
  viewports: MutableRefObject<Map<number, PageViewport>>;
  pageSizesRef: MutableRefObject<Map<number, { width: number; height: number }>>;
  onscreenPagesRef: MutableRefObject<ReadonlySet<number> | null>;
  pdfPerfRunRef: MutableRefObject<number | null>;
  setPageSizeVersion: Dispatch<SetStateAction<number>>;
  setFirstPagePainted: Dispatch<SetStateAction<boolean>>;
  setStatus: Dispatch<SetStateAction<string>>;
  setRenderError: Dispatch<SetStateAction<boolean>>;
}

/** Rasterize the mounted pages in the viewport band, then measure every page's
 *  scale-1 box in the background. */
export function usePdfPagePaint({
  enabled,
  doc,
  renderScale,
  devicePixelRatio,
  canvasVersion,
  onscreenVersion,
  firstPagePainted,
  lastRenderedDocRef,
  stalePaintPagesRef,
  paintedPagesRef,
  allPagesPaintedRef,
  canvasRefs,
  viewports,
  pageSizesRef,
  onscreenPagesRef,
  pdfPerfRunRef,
  setPageSizeVersion,
  setFirstPagePainted,
  setStatus,
  setRenderError,
}: PdfPagePaintState): void {
  // Pixels are drawn at renderScale × this ratio (capped per page), so a ratio
  // change invalidates every page's paint credit.
  const paintedRatioRef = useRef(devicePixelRatio);

  // Render pages into their canvases whenever the parsed document, settled
  // zoom, or the mounted canvas set changes. No parsing happens here anymore.
  useEffect(() => {
    if (!enabled || !doc) return;
    // Consume page-scoped staleness only for its document change; zoom and canvas remounts repaint their band.
    const isDocumentChange = lastRenderedDocRef.current !== doc;
    lastRenderedDocRef.current = doc;
    const stalePages = isDocumentChange ? stalePaintPagesRef.current : "all";
    if (isDocumentChange) stalePaintPagesRef.current = null;
    if (paintedRatioRef.current !== devicePixelRatio) {
      paintedRatioRef.current = devicePixelRatio;
      paintedPagesRef.current.clear();
      allPagesPaintedRef.current = false;
    }
    let cancelled = false;
    let activeTask: RenderTask | null = null;
    (async () => {
      try {
        const mountedPageNumbers = Array.from(canvasRefs.current.keys())
          .map((pageIdx) => pageIdx + 1)
          .filter((pageNumber) => pageNumber >= 1 && pageNumber <= doc.numPages)
          .sort((a, b) => a - b);
        const mountedPages = new Set(mountedPageNumbers);
        // Estimate page bytes at the current scale to bound paint-ahead work.
        // Use the configured band until page geometry is available.
        const typicalPageBytes = (): number => {
          const size =
            pageSizesRef.current.get(0) ??
            pageSizesRef.current.values().next().value;
          if (!size) return 0;
          const cssWidth = size.width * renderScale;
          const cssHeight = size.height * renderScale;
          const backing = pdfCanvasBackingScale(cssWidth, cssHeight, devicePixelRatio);
          return cssWidth * backing * cssHeight * backing * 4;
        };
        const window = pdfPageWindow(onscreenPagesRef.current, doc.numPages, {
          ahead: pdfPaintAheadPages(typicalPageBytes(), PAINT_AHEAD_PAGES),
          keep: RELEASE_AFTER_PAGES,
        });
        // Release off-screen pixels before painting and invalidate their paint
        // credit. Bound retained canvases by bytes as well as page distance.
        const backingBytesOf = (pageIdx: number): number => {
          const canvas = canvasRefs.current.get(pageIdx);
          return canvas ? canvas.width * canvas.height * 4 : 0;
        };
        const releasePlan = planPdfCanvasRelease(
          paintedPagesRef.current.keys(),
          window,
          backingBytesOf
        );
        for (const pageIdx of releasePlan.release) {
          const canvas = canvasRefs.current.get(pageIdx);
          if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
          }
          paintedPagesRef.current.delete(pageIdx);
          allPagesPaintedRef.current = false;
          countPdfPerf(pdfPerfRunRef.current, "pagesReleased");
        }
        // Paint only mounted pages in the paint band that lack pixels at the current scale.
        const pageNumbers = pdfPagesToRender(
          mountedPageNumbers,
          window.paint,
          stalePages,
          doc.numPages,
          paintedPagesRef.current,
          renderScale
        );
        // Reported from both exits. The window can be finished by a pass that
        // still had pages to paint OR by one that found nothing left to do —
        // mounting a canvas reopens the question without creating any work.
        const noteWindowComplete = () => {
          if (allPagesPaintedRef.current) return;
          const complete = [...window.paint].every(
            (pageNumber) =>
              !mountedPages.has(pageNumber) ||
              paintedPagesRef.current.get(pageNumber - 1) === renderScale
          );
          if (!complete) return;
          allPagesPaintedRef.current = true;
          markPdfPerf(pdfPerfRunRef.current, "window-painted", {
            paintedPages: paintedPagesRef.current.size,
            windowPages: window.paint.size,
            totalPages: doc.numPages,
          });
        };
        if (!pageNumbers.length) {
          markPdfPerf(pdfPerfRunRef.current, "render-pass-skipped", {
            mountedCanvases: canvasRefs.current.size,
          });
          noteWindowComplete();
          return;
        }
        // Allocate one effect-local scratch canvas only when work exists; replace visible pixels after painting.
        const renderCanvas = document.createElement("canvas");
        countPdfPerf(pdfPerfRunRef.current, "renderPasses");
        countPdfPerf(pdfPerfRunRef.current, "pagesPlanned", pageNumbers.length);
        markPdfPerf(pdfPerfRunRef.current, "render-pass-start", {
          pages: pageNumbers.length,
          mountedCanvases: canvasRefs.current.size,
          totalPages: doc.numPages,
          documentChange: isDocumentChange,
        });
        for (const i of pageNumbers) {
          if (i === 1) markPdfPerf(pdfPerfRunRef.current, "page-1-render-start");
          const page = await doc.getPage(i);
          // Splits the first page's cost into the worker's side (fetching and
          // parsing the page's content stream and resources) and the main
          // thread's raster. They have completely different remedies, so a
          // combined number cannot tell you which one to attack.
          if (i === 1) markPdfPerf(pdfPerfRunRef.current, "page-1-ready");
          if (cancelled) return;
          const viewport = page.getViewport({ scale: renderScale });
          viewports.current.set(i - 1, viewport);
          // Record the page's box as soon as it is known, so the viewer can
          // reserve space for the pages around it without waiting for the
          // background measure pass to reach them.
          if (!pageSizesRef.current.has(i - 1)) {
            const unit = page.getViewport({ scale: 1 });
            pageSizesRef.current.set(i - 1, {
              width: unit.width,
              height: unit.height,
            });
            setPageSizeVersion((v) => v + 1);
          }
          const canvas = canvasRefs.current.get(i - 1);
          if (!canvas) continue;
          // `viewport` stays in CSS pixels (pointer and annotation geometry use
          // it); only the bitmap is scaled up for the display.
          const backing = pdfCanvasBackingScale(viewport.width, viewport.height, devicePixelRatio);
          renderCanvas.width = Math.floor(viewport.width * backing);
          renderCanvas.height = Math.floor(viewport.height * backing);
          const renderCtx = renderCanvas.getContext("2d");
          if (!renderCtx) continue;
          activeTask = page.render({
            canvasContext: renderCtx,
            viewport,
            ...(backing !== 1 ? { transform: [backing, 0, 0, backing, 0, 0] } : {}),
          });
          await activeTask.promise;
          activeTask = null;
          countPdfPerf(pdfPerfRunRef.current, "pageRasters");
          countPdfPerf(pdfPerfRunRef.current, "rasterBytes", renderCanvas.width * renderCanvas.height * 4);
          if (i === 1) markPdfPerf(pdfPerfRunRef.current, "page-1-raster-end");
          if (cancelled) return;
          if (i === 1) markPdfPerf(pdfPerfRunRef.current, "blank-check-start");
          if (i === 1 && (await paintedBlankUnexpectedly(...blankProbe(renderCanvas, renderCtx, viewport), page))) {
            if (cancelled) return;
            throw new Error("pdf.js rendered a blank first page");
          }
          if (i === 1) markPdfPerf(pdfPerfRunRef.current, "blank-check-end");
          if (cancelled) return;
          canvas.width = renderCanvas.width;
          canvas.height = renderCanvas.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          ctx.drawImage(renderCanvas, 0, 0);
          // Credit the page only once its pixels are actually on the visible
          // canvas, and only for the scale they were drawn at.
          paintedPagesRef.current.set(i - 1, renderScale);
          if (i === 1) {
            setFirstPagePainted(true);
            setStatus("");
            markPdfPerf(pdfPerfRunRef.current, "first-meaningful-page");
          } else if (doc.numPages > 8) {
            await nextFrame();
          }
        }
        markPdfPerf(pdfPerfRunRef.current, "render-pass-end", {
          renderedPages: paintedPagesRef.current.size,
          totalPages: doc.numPages,
        });
        noteWindowComplete();
        setRenderError(false);
      } catch (err) {
        if (!cancelled && !isPdfjsCancellation(err)) {
          console.error("[mesa] PDF render failed:", err);
          setStatus("");
          setRenderError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      activeTask?.cancel();
    };
    // The refs and setters are the editor's stable identities; listing them
    // never adds a render pass.
  }, [
    enabled,
    doc,
    renderScale,
    devicePixelRatio,
    canvasVersion,
    onscreenVersion,
    lastRenderedDocRef,
    stalePaintPagesRef,
    paintedPagesRef,
    allPagesPaintedRef,
    canvasRefs,
    viewports,
    pageSizesRef,
    onscreenPagesRef,
    pdfPerfRunRef,
    setPageSizeVersion,
    setFirstPagePainted,
    setStatus,
    setRenderError,
  ]);

  // Measure scale-1 geometry after first paint in yielding batches; reserve page layout without rasterizing.
  useEffect(() => {
    if (!enabled || !doc || !firstPagePainted) return;
    if (pageSizesRef.current.size >= doc.numPages) return;
    let cancelled = false;
    (async () => {
      try {
        markPdfPerf(pdfPerfRunRef.current, "page-measure-start", {
          totalPages: doc.numPages,
        });
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
          if (cancelled) return;
          if (pageSizesRef.current.has(pageNumber - 1)) continue;
          const page = await doc.getPage(pageNumber);
          if (cancelled) return;
          const unit = page.getViewport({ scale: 1 });
          pageSizesRef.current.set(pageNumber - 1, {
            width: unit.width,
            height: unit.height,
          });
          countPdfPerf(pdfPerfRunRef.current, "pagesMeasured");
          if (pageNumber % 16 === 0) {
            setPageSizeVersion((v) => v + 1);
            await nextFrame();
          }
        }
        if (cancelled) return;
        setPageSizeVersion((v) => v + 1);
        markPdfPerf(pdfPerfRunRef.current, "page-measure-end", {
          measured: pageSizesRef.current.size,
        });
      } catch (err) {
        // Measurement is an optimization, never a reason to fail the document:
        // without it the viewer falls back to estimating from a known page.
        if (!cancelled && !isPdfjsCancellation(err)) {
          console.warn("[mesa] PDF page measure failed:", err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, doc, firstPagePainted, pageSizesRef, pdfPerfRunRef, setPageSizeVersion]);
}
