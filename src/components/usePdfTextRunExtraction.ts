import { useEffect, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { Util, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  mergePdfTextRunSources,
  projectPdfTextRuns,
  type PdfTextRun,
  type PdfTextRunSource,
} from "../lib/pdfTextRuns";
import { addStalePages, stalePageNumbers, type StalePages } from "../lib/pdfStalePages";
import { markPdfPerf } from "./pdfPerf";
import { nextFrame } from "./pdfjsTasks";

/** Text-run state the extractor shares with `usePdfEditor`, which resets it
 *  with the document and marks pages stale on edits. */
export interface PdfTextRunExtractionState {
  enabled: boolean;
  extractText: boolean;
  doc: PDFDocumentProxy | null;
  renderScale: number;
  textRunSources: PdfTextRunSource[];
  setTextRunSources: Dispatch<SetStateAction<PdfTextRunSource[]>>;
  staleTextPagesRef: MutableRefObject<StalePages>;
  textRunSourcesRef: MutableRefObject<PdfTextRunSource[]>;
  extractedPageCountRef: MutableRefObject<number>;
  pdfPerfRunRef: MutableRefObject<number | null>;
}

/** Extract text runs at scale 1 (only stale pages when possible) and project
 *  them to the current render scale. */
export function usePdfTextRunExtraction({
  enabled,
  extractText,
  doc,
  renderScale,
  textRunSources,
  setTextRunSources,
  staleTextPagesRef,
  textRunSourcesRef,
  extractedPageCountRef,
  pdfPerfRunRef,
}: PdfTextRunExtractionState): PdfTextRun[] {
  // Extract zoom-independent text at scale 1; project to screen coordinates below.
  useEffect(() => {
    if (!enabled || !extractText || !doc) {
      textRunSourcesRef.current = [];
      extractedPageCountRef.current = 0;
      setTextRunSources([]);
      return;
    }
    // A page-scoped edit only changes the page it touched, so re-extract just
    // those pages and keep the rest. Anything that could shift page indices or
    // touch unknown pages (structural edits, undo/redo, an external reload, the
    // first pass) falls back to the whole document — a stale run would place a
    // replacement on the wrong glyphs.
    const pending = staleTextPagesRef.current;
    staleTextPagesRef.current = null;
    const canReuse =
      textRunSourcesRef.current.length > 0 &&
      extractedPageCountRef.current === doc.numPages;
    const scopedPages = canReuse ? stalePageNumbers(pending, doc.numPages) : null;
    let cancelled = false;
    let published = false;
    (async () => {
      try {
        markPdfPerf(pdfPerfRunRef.current, "text-extraction-start", {
          scopedPages: scopedPages?.length ?? null,
          totalPages: doc.numPages,
        });
        const nextSources: PdfTextRunSource[] = [];
        const pageNumbers =
          scopedPages ??
          Array.from({ length: doc.numPages }, (_, pageIdx) => pageIdx + 1);
        for (const i of pageNumbers) {
          const page = await doc.getPage(i);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: 1 });
          const text = await page.getTextContent();
          if (cancelled) return;
          for (const item of text.items) {
            const raw = item as {
              str?: string;
              width?: number;
              height?: number;
              transform?: number[];
            };
            const value = raw.str?.trim();
            if (!value || !raw.transform) continue;
            const matrix = Util.transform(viewport.transform, raw.transform);
            nextSources.push({
              page: i - 1,
              text: raw.str ?? "",
              unitLeft: matrix[4],
              unitTop: matrix[5],
              unitHeight: Math.hypot(matrix[2], matrix[3]),
              rawWidth: raw.width,
              rawHeight: raw.height,
              fallbackWidth: value.length * 6,
              pdfX: raw.transform[4],
              pdfYBase: raw.transform[5],
            });
          }
          if (i % 4 === 0) await nextFrame();
        }
        if (cancelled) return;
        const merged = scopedPages
          ? mergePdfTextRunSources(
              textRunSourcesRef.current,
              nextSources,
              new Set(scopedPages.map((pageNumber) => pageNumber - 1))
            )
          : nextSources;
        textRunSourcesRef.current = merged;
        extractedPageCountRef.current = doc.numPages;
        published = true;
        setTextRunSources(merged);
        markPdfPerf(pdfPerfRunRef.current, "text-extraction-end", {
          runs: merged.length,
        });
      } catch {
        if (!cancelled) {
          textRunSourcesRef.current = [];
          extractedPageCountRef.current = 0;
          setTextRunSources([]);
        }
      }
    })();
    return () => {
      cancelled = true;
      // This pass consumed the pending work up front. If it never published,
      // hand exactly that work back, or the next pass would merge fresh runs
      // into sources this one was meant to replace — stale hit boxes place a
      // replacement on the wrong glyphs.
      if (published) return;
      staleTextPagesRef.current = addStalePages(
        staleTextPagesRef.current,
        scopedPages
          ? new Set(scopedPages.map((pageNumber) => pageNumber - 1))
          : "all"
      );
    };
    // The refs and setter are the editor's stable identities.
  }, [
    enabled,
    extractText,
    doc,
    staleTextPagesRef,
    textRunSourcesRef,
    extractedPageCountRef,
    pdfPerfRunRef,
    setTextRunSources,
  ]);

  return useMemo(
    () => projectPdfTextRuns(textRunSources, renderScale),
    [textRunSources, renderScale]
  );
}
