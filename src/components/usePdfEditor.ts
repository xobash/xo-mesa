import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { exists, readFile, remove, rename, writeFile } from "@tauri-apps/plugin-fs";
import { IN_TAURI, urlForPath } from "../lib/vault";
import type { VaultFile } from "../types";
import {
  assertValidPdfBytes,
  copyPdfBytes,
  getFormFields,
  isLikelyBlankPdfPaint,
  pdfBytesEqual,
  sanitizePdfBytes,
  type FormField,
} from "../lib/pdf";
import { persistPdfBytes } from "../lib/pdfSave";
import { pdfHistoryBytes, trimPdfHistory } from "../lib/pdfHistory";
import {
  mergePdfTextRunSources,
  projectPdfTextRuns,
  type PdfTextRun,
  type PdfTextRunSource,
} from "../lib/pdfTextRuns";
import {
  addStalePages,
  stalePageNumbers,
  type StalePages,
} from "../lib/pdfStalePages";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PdfTextRun } from "../lib/pdfTextRuns";

interface PdfEditorOptions {
  enabled?: boolean;
  extractText?: boolean;
  /** Extract fillable form fields (a full pdf-lib parse on the main thread).
   *  Off by default so the read-only viewer never pays for it; the editor
   *  turns it on when entering edit mode. */
  formFields?: boolean;
  /** Changes when the file changes on disk (e.g. its mtime). A change makes
   *  the hook re-check the disk bytes: our own save echo is ignored, a clean
   *  document adopts the new bytes, and unsaved edits are preserved. */
  reloadToken?: number;
}

interface PdfApplyOptions {
  pages?: number[];
  structural?: boolean;
}

type PdfTransform = (current: Uint8Array) => Promise<Uint8Array>;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * All of the PDF *document* logic — loading bytes, rendering pages with pdf.js,
 * the undo/redo history, and saving — extracted from the view so the component
 * is just annotation UI. Returns the canvas/viewport refs the view binds to.
 */
/** pdf.js failures caused by our own cancel/destroy during cleanup — not real
 *  render errors, so they must never flip the UI into the error/fallback state. */
function isPdfjsCancellation(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  if (name === "RenderingCancelledException" || name === "AbortException") return true;
  return /destroyed|cancell/i.test(String((err as Error)?.message ?? err));
}

/**
 * Did the first page come back blank when it had something to draw?
 *
 * A blank paint alone is NOT evidence of a broken render: blank cover sheets,
 * separator pages, and "this page intentionally left blank" leaves are ordinary
 * documents, and treating them as failures dropped the whole document into the
 * read-only native fallback — which silently costs the user every editing tool,
 * because the annotation surfaces only exist over Mesa's own page canvases.
 *
 * pdf.js answers the question directly: a page whose operator list is empty has
 * no drawing operations at all, so a blank result is the CORRECT one. Anything
 * else that paints blank is still treated as the failure it is. Asking is cheap
 * (measured 1-5 ms on the test corpus) and only happens on the rare blank paint.
 */
export async function paintedBlankUnexpectedly(
  ctx: { getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray } },
  canvas: { width: number; height: number },
  page: Pick<pdfjs.PDFPageProxy, "getOperatorList">
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

export function usePdfEditor(
  file: VaultFile | undefined,
  { enabled = true, extractText = false, formFields = false, reloadToken }: PdfEditorOptions = {}
) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [renderScale, setRenderScale] = useState(1.2);
  const [canvasVersion, setCanvasVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [renderError, setRenderError] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [fields, setFields] = useState<FormField[]>([]);
  // Extraction is zoom-independent; the screen-space projection is derived.
  const [textRunSources, setTextRunSources] = useState<PdfTextRunSource[]>([]);
  const [firstPagePainted, setFirstPagePainted] = useState(false);
  // Page completion is imperative canvas bookkeeping. Keep the complete set
  // available without publishing a new React state object after every page;
  // only page 1 changes visible UI (it retires the native warm-start iframe).
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const [history, setHistory] = useState<Uint8Array[]>([]);
  const [future, setFuture] = useState<Uint8Array[]>([]);
  const viewports = useRef<Map<number, pdfjs.PageViewport>>(new Map());
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  // Pages whose PIXELS are stale. Accumulates exactly like the text set below,
  // so two scoped edits landing before one reparse repaint both pages.
  const stalePaintPagesRef = useRef<StalePages>(null);
  const lastRenderedDocRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  // Pages whose extracted TEXT RUNS are stale. Same accumulation rule.
  const staleTextPagesRef = useRef<StalePages>(null);
  const textRunSourcesRef = useRef<PdfTextRunSource[]>([]);
  const extractedPageCountRef = useRef(0);
  const bytesRef = useRef<Uint8Array | null>(null);
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const savedBytesRef = useRef<Uint8Array | null>(null);
  const historyRef = useRef<Uint8Array[]>([]);
  const futureRef = useRef<Uint8Array[]>([]);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  // Every async edit/history/save job belongs to the PDF path that started it.
  // PdfView is reused when the user switches directly from PDF A to PDF B, so
  // an old transform must never publish bytes into the new document's state.
  const documentGenerationRef = useRef(0);
  const operationPathRef = useRef<string | null>(null);
  const canvasRefCallbacks = useRef<
    Map<number, (el: HTMLCanvasElement | null) => void>
  >(new Map());
  const canvasVersionRaf = useRef<number | null>(null);

  const resetDocumentState = useCallback(() => {
    bytesRef.current = null;
    savedBytesRef.current = null;
    historyRef.current = [];
    futureRef.current = [];
    queueRef.current = Promise.resolve();
    docRef.current?.destroy();
    docRef.current = null;
    setDoc(null);
    setBytes(null);
    setRenderError(false);
    setLoadFailed(false);
    setHistory([]);
    setFuture([]);
    setTextRunSources([]);
    setDirty(false);
    setStatus("");
    setPageCount(0);
    setFields([]);
    renderedPagesRef.current.clear();
    setFirstPagePainted(false);
    lastRenderedDocRef.current = null;
    stalePaintPagesRef.current = null;
    staleTextPagesRef.current = null;
    textRunSourcesRef.current = [];
    extractedPageCountRef.current = 0;
    viewports.current.clear();
    canvasRefs.current.clear();
    canvasRefCallbacks.current.clear();
    if (canvasVersionRaf.current !== null) {
      cancelAnimationFrame(canvasVersionRaf.current);
      canvasVersionRaf.current = null;
    }
  }, []);

  const captureDocumentGeneration = useCallback(
    () => ({
      generation: documentGenerationRef.current,
      path: operationPathRef.current,
    }),
    []
  );

  const isCurrentDocumentGeneration = useCallback(
    (captured: { generation: number; path: string | null }) =>
      captured.generation === documentGenerationRef.current &&
      captured.path === operationPathRef.current,
    []
  );

  /** Bytes held outside the stack being trimmed: the opposite stack plus the
   *  current and saved copies the hook always keeps. */
  const retainedBytesOutside = useCallback((other: Uint8Array[]) => {
    return (
      pdfHistoryBytes(other) +
      (bytesRef.current?.byteLength ?? 0) +
      (savedBytesRef.current?.byteLength ?? 0)
    );
  }, []);

  // Every entry is a full copy of the document, so both stacks are bounded by
  // total retained bytes — otherwise editing a large PDF grows without limit
  // until the webview dies.
  const setHistorySnapshots = useCallback(
    (next: Uint8Array[]) => {
      const bounded = trimPdfHistory(next, retainedBytesOutside(futureRef.current));
      historyRef.current = bounded;
      setHistory(bounded);
    },
    [retainedBytesOutside]
  );

  const setFutureSnapshots = useCallback(
    (next: Uint8Array[]) => {
      const bounded = trimPdfHistory(next, retainedBytesOutside(historyRef.current));
      futureRef.current = bounded;
      setFuture(bounded);
    },
    [retainedBytesOutside]
  );

  const setCurrentBytes = useCallback((next: Uint8Array) => {
    const snapshot = copyPdfBytes(next);
    bytesRef.current = snapshot;
    setBytes(snapshot);
    setDirty(
      savedBytesRef.current ? !pdfBytesEqual(snapshot, savedBytesRef.current) : false
    );
  }, []);

  const setSavedBytes = useCallback((next: Uint8Array) => {
    const snapshot = copyPdfBytes(next);
    savedBytesRef.current = snapshot;
    bytesRef.current = snapshot;
    setBytes(snapshot);
    setDirty(false);
  }, []);

  const enqueue = useCallback((operation: () => Promise<void>): Promise<void> => {
    const job = queueRef.current.then(operation);
    queueRef.current = job.catch(() => undefined);
    return job;
  }, []);

  /** Mark pages stale for BOTH the repaint and the text-run passes. They always
   *  go stale together — an edit that changes a page's pixels changes its glyph
   *  runs — so recording them separately is what let the two drift apart. */
  const markStale = useCallback((next: ReadonlySet<number> | "all") => {
    stalePaintPagesRef.current = addStalePages(stalePaintPagesRef.current, next);
    staleTextPagesRef.current = addStalePages(staleTextPagesRef.current, next);
  }, []);

  const bumpCanvasVersionSoon = useCallback(() => {
    if (canvasVersionRaf.current !== null) return;
    canvasVersionRaf.current = requestAnimationFrame(() => {
      canvasVersionRaf.current = null;
      setCanvasVersion((v) => v + 1);
    });
  }, []);

  const bindCanvas = useCallback(
    (pageIdx: number) => {
      let cb = canvasRefCallbacks.current.get(pageIdx);
      if (!cb) {
        cb = (el: HTMLCanvasElement | null) => {
          if (!el) {
            canvasRefs.current.delete(pageIdx);
            return;
          }
          const prev = canvasRefs.current.get(pageIdx);
          canvasRefs.current.set(pageIdx, el);
          if (prev !== el) bumpCanvasVersionSoon();
        };
        canvasRefCallbacks.current.set(pageIdx, cb);
      }
      return cb;
    },
    [bumpCanvasVersionSoon]
  );

  useEffect(() => {
    const id = window.setTimeout(() => {
      setRenderScale(scale);
    }, 140);
    return () => window.clearTimeout(id);
  }, [scale]);

  // Release the shared pdf.js document (worker memory) on unmount. Replacement
  // during the document's life is handled by the parse effect below.
  useEffect(() => {
    return () => {
      documentGenerationRef.current++;
      operationPathRef.current = null;
      docRef.current?.destroy();
      docRef.current = null;
    };
  }, []);

  // load bytes from disk (or fetch in the browser/demo); re-runs when the
  // reloadToken says the file changed on disk underneath us
  const loadedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !file) {
      if (operationPathRef.current !== null) {
        documentGenerationRef.current++;
        operationPathRef.current = null;
      }
      loadedPathRef.current = null;
      resetDocumentState();
      return;
    }
    const isNewDocument = loadedPathRef.current !== file.path;
    if (operationPathRef.current !== file.path) {
      documentGenerationRef.current++;
      operationPathRef.current = file.path;
    }
    loadedPathRef.current = file.path;
    let cancelled = false;
    if (isNewDocument) {
      resetDocumentState();
      setStatus("Loading PDF...");
    }
    (async () => {
      try {
        // readFile/arrayBuffer both hand us a fresh buffer nothing else holds,
        // so setSavedBytes' defensive snapshot is the only copy on the open path.
        let data: Uint8Array;
        if (IN_TAURI && file) data = await readFile(file.path);
        else {
          const r = await fetch(urlForPath(file!.path));
          data = new Uint8Array(await r.arrayBuffer());
        }
        if (cancelled) return;
        if (!isNewDocument) {
          // Same document, changed on disk. Serialize through the byte queue so
          // an in-flight edit transform cannot interleave with the reload.
          await enqueue(async () => {
            if (cancelled) return;
            const saved = savedBytesRef.current;
            if (!saved) {
              // No baseline yet: the document's FIRST load is still in flight and
              // a reload tick (a watcher mtime update, or React's double-invoked
              // mount effect) beat it here. This is still the initial open, not an
              // external rewrite, so adopt the bytes without announcing a reload.
              setSavedBytes(data);
              return;
            }
            if (pdfBytesEqual(data, saved)) return; // our own save echo
            const current = bytesRef.current;
            const hasEdits = !!(current && saved && !pdfBytesEqual(current, saved));
            if (hasEdits) {
              // Never discard the user's unsaved edits; save() refuses to
              // clobber the newer on-disk version, so nothing is lost either way.
              setStatus(
                "This PDF changed on disk. Showing your unsaved edits; saving is blocked until it is reopened."
              );
              return;
            }
            // Clean document → adopt the new bytes. The undo history belonged
            // to the previous on-disk version, so it is cleared.
            markStale("all");
            setHistorySnapshots([]);
            setFutureSnapshots([]);
            setSavedBytes(data);
            setStatus("Reloaded — this PDF changed on disk.");
          });
          return;
        }
        // Form fields are extracted lazily (edit mode only) by the effect
        // below — pdf-lib's full main-thread parse has no place on the open path.
        setSavedBytes(data);
      } catch (e) {
        if (!cancelled && isNewDocument) {
          setStatus(`Could not open PDF: ${String(e)}`);
          setLoadFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    file?.path,
    reloadToken,
    enqueue,
    resetDocumentState,
    setHistorySnapshots,
    setFutureSnapshots,
    setSavedBytes,
  ]);

  // Parse the document once per byte-state. Rendering, zooming, and text
  // extraction all reuse this proxy — previously every zoom settle and canvas
  // remount re-copied the full bytes and re-parsed the entire document.
  useEffect(() => {
    if (!enabled || !bytes) {
      docRef.current?.destroy();
      docRef.current = null;
      setDoc(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // pdf.js transfers this buffer to its worker, so it gets its own copy.
        const next = await pdfjs.getDocument({
          data: sanitizePdfBytes(bytes).slice(0),
        }).promise;
        if (cancelled) {
          void next.destroy();
          return;
        }
        docRef.current?.destroy();
        docRef.current = next;
        setPageCount(next.numPages);
        setDoc(next);
      } catch (err) {
        if (!cancelled && !isPdfjsCancellation(err)) {
          console.error("[mesa] PDF parse failed:", err);
          setRenderError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, bytes]);

  // Fillable form fields — pdf-lib parses the whole document on the main
  // thread, so this only runs when the caller actually wants fields (edit mode).
  useEffect(() => {
    if (!enabled || !formFields || !bytes) {
      setFields([]);
      return;
    }
    let cancelled = false;
    void getFormFields(bytes).then(
      (next) => {
        if (!cancelled) setFields(next);
      },
      () => {
        if (!cancelled) setFields([]);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, formFields, bytes]);

  // Render pages into their canvases whenever the parsed document, settled
  // zoom, or the mounted canvas set changes. No parsing happens here anymore.
  useEffect(() => {
    if (!enabled || !doc) return;
    // A page-scoped override belongs to the document change that produced it.
    // This effect also re-runs for zoom settles and canvas remounts, and those
    // passes must repaint EVERYTHING: a zoom landing between the edit and its
    // reparse would otherwise consume the override, repaint one page at the new
    // scale, and leave every other page sized for the old one. Non-document
    // passes leave the override for the reparse that follows.
    const isDocumentChange = lastRenderedDocRef.current !== doc;
    lastRenderedDocRef.current = doc;
    const stalePages = isDocumentChange ? stalePaintPagesRef.current : "all";
    if (isDocumentChange) stalePaintPagesRef.current = null;
    let cancelled = false;
    let activeTask: pdfjs.RenderTask | null = null;
    (async () => {
      try {
        // Paint through one effect-local scratch canvas. The visible page
        // canvases retain their previous pixels until each replacement is
        // complete, so zoom/edit rerenders still never flash white. Keeping a
        // second full-resolution canvas for every page doubled sustained pixel
        // backing on large PDFs; one scratch bounds that duplicate allocation
        // to the largest page in this render pass. A new effect gets a new
        // scratch, so a cancelled render can never race its successor on the
        // same canvas.
        const renderCanvas = document.createElement("canvas");
        const pageNumbers =
          stalePageNumbers(stalePages, doc.numPages) ??
          Array.from({ length: doc.numPages }, (_, pageIdx) => pageIdx + 1);
        for (const i of pageNumbers) {
          const page = await doc.getPage(i);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: renderScale });
          viewports.current.set(i - 1, viewport);
          const canvas = canvasRefs.current.get(i - 1);
          if (!canvas) continue;
          renderCanvas.width = viewport.width;
          renderCanvas.height = viewport.height;
          const renderCtx = renderCanvas.getContext("2d");
          if (!renderCtx) continue;
          activeTask = page.render({ canvasContext: renderCtx, viewport });
          await activeTask.promise;
          activeTask = null;
          if (cancelled) return;
          if (i === 1 && (await paintedBlankUnexpectedly(renderCtx, renderCanvas, page))) {
            if (cancelled) return;
            throw new Error("pdf.js rendered a blank first page");
          }
          if (cancelled) return;
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          ctx.drawImage(renderCanvas, 0, 0);
          renderedPagesRef.current.add(i - 1);
          if (i === 1) {
            setFirstPagePainted(true);
            setStatus("");
          } else if (doc.numPages > 8) {
            await nextFrame();
          }
        }
        setRenderError(false);
      } catch (err) {
        if (!cancelled && !isPdfjsCancellation(err)) {
          console.error("[mesa] PDF render failed:", err);
          setRenderError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      activeTask?.cancel();
    };
  }, [enabled, doc, renderScale, canvasVersion]);

  // Extract at scale 1 only. pdf.js extraction is the expensive half (81.3 ms
  // for a 40-page document), and it does not depend on zoom — only the
  // screen-space projection below does, which is pure arithmetic.
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
            const matrix = pdfjs.Util.transform(viewport.transform, raw.transform);
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
  }, [enabled, extractText, doc]);

  const textRuns: PdfTextRun[] = useMemo(
    () => projectPdfTextRuns(textRunSources, renderScale),
    [textRunSources, renderScale]
  );

  /** Run a byte transform, pushing the previous bytes onto the undo stack. */
  const apply = (transform: PdfTransform, options: PdfApplyOptions = {}) => {
    const document = captureDocumentGeneration();
    return enqueue(async () => {
      if (!isCurrentDocumentGeneration(document)) return;
      const before = bytesRef.current;
      if (!before) return;
      try {
        const beforeSnapshot = copyPdfBytes(before);
        const result = copyPdfBytes(await transform(beforeSnapshot));
        if (!isCurrentDocumentGeneration(document)) return;
        await assertValidPdfBytes(result);
        if (!isCurrentDocumentGeneration(document)) return;
        if (pdfBytesEqual(beforeSnapshot, result)) {
          return;
        }
        // A scoped edit invalidates only its own pages; a structural one (or an
        // edit that never said which pages it touched) invalidates everything.
        // Merged, never replaced: two quick annotations on different pages must
        // both be redone even if only one reparse lands for the pair.
        markStale(
          options.structural || !options.pages?.length
            ? "all"
            : new Set(options.pages.map((page) => Math.trunc(page)))
        );
        if (options.structural) {
          renderedPagesRef.current.clear();
          setFirstPagePainted(false);
        }
        setHistorySnapshots([...historyRef.current, beforeSnapshot]);
        setFutureSnapshots([]);
        setCurrentBytes(result);
      } catch (e) {
        if (!isCurrentDocumentGeneration(document)) return;
        setStatus(`Edit failed: ${String(e)}`);
      }
    });
  };

  const undo = () => {
    const document = captureDocumentGeneration();
    return enqueue(async () => {
      if (!isCurrentDocumentGeneration(document)) return;
      const current = bytesRef.current;
      const history = historyRef.current;
      if (!history.length || !current) return;
      const previous = copyPdfBytes(history[history.length - 1]);
      try {
        await assertValidPdfBytes(previous);
        if (!isCurrentDocumentGeneration(document)) return;
        markStale("all");
        renderedPagesRef.current.clear();
        setFirstPagePainted(false);
        setHistorySnapshots(history.slice(0, -1));
        setFutureSnapshots([...futureRef.current, copyPdfBytes(current)]);
        setCurrentBytes(previous);
      } catch (e) {
        if (!isCurrentDocumentGeneration(document)) return;
        setStatus(`Undo failed: ${String(e)}`);
      }
    });
  };
  const redo = () => {
    const document = captureDocumentGeneration();
    return enqueue(async () => {
      if (!isCurrentDocumentGeneration(document)) return;
      const current = bytesRef.current;
      const future = futureRef.current;
      if (!future.length || !current) return;
      const next = copyPdfBytes(future[future.length - 1]);
      try {
        await assertValidPdfBytes(next);
        if (!isCurrentDocumentGeneration(document)) return;
        markStale("all");
        renderedPagesRef.current.clear();
        setFirstPagePainted(false);
        setFutureSnapshots(future.slice(0, -1));
        setHistorySnapshots([...historyRef.current, copyPdfBytes(current)]);
        setCurrentBytes(next);
      } catch (e) {
        if (!isCurrentDocumentGeneration(document)) return;
        setStatus(`Redo failed: ${String(e)}`);
      }
    });
  };

  const save = async () => {
    const document = captureDocumentGeneration();
    const targetFile = file;
    if (!targetFile) return;
    return enqueue(async () => {
      if (!isCurrentDocumentGeneration(document)) return;
      // Capture bytes only after earlier queued edits have settled. The
      // document identity and path were captured before enqueueing, so this
      // cannot combine a later PDF's bytes with the original target path.
      const current = bytesRef.current;
      const baseline = savedBytesRef.current;
      if (!current || !baseline) return;
      const snapshot = copyPdfBytes(current);
      const expectedCurrentBytes = copyPdfBytes(baseline);
      try {
        await assertValidPdfBytes(snapshot);
        if (!isCurrentDocumentGeneration(document)) return;
        if (IN_TAURI) {
          // The expected bytes are enforced inside the verified-write
          // transaction (and checked again immediately before commit), so an
          // external rewrite cannot slip between a UI pre-check and the save.
          await persistPdfBytes(
            targetFile.path,
            snapshot,
            {
              readFile,
              writeFile,
              remove,
              exists,
              rename,
            },
            { expectedCurrentBytes }
          );
          if (!isCurrentDocumentGeneration(document)) return;
          savedBytesRef.current = copyPdfBytes(snapshot);
          setDirty(false);
          setStatus("Saved.");
        } else {
          setStatus("Editing is read-only in the browser demo.");
        }
      } catch (e) {
        if (!isCurrentDocumentGeneration(document)) return;
        if (/changed before the verified write/i.test(String(e))) {
          setStatus(
            "Save blocked: this PDF changed on disk after it was opened. Your edits are still here — reopen the file to load the newer version, or duplicate it to keep both."
          );
        } else {
          setStatus(`Save failed: ${String(e)}`);
        }
      }
    });
  };

  return {
    bytes,
    pageCount,
    scale,
    renderScale,
    setScale,
    dirty,
    status,
    renderError,
    loadFailed,
    fields,
    textRuns,
    canUndo: history.length > 0,
    canRedo: future.length > 0,
    viewports,
    canvasRefs,
    renderedPages: renderedPagesRef.current,
    firstPagePainted,
    bindCanvas,
    apply,
    undo,
    redo,
    save,
  };
}
