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
import { pdfPageWindow } from "../lib/pdfPageWindow";
import { countPdfPerf, markPdfPerf, startPdfPerfRun } from "./pdfPerf";

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

/** Pages kept painted on either side of the ones the viewer says are on screen,
 *  so ordinary scrolling always lands on pixels that are already there. */
const PAINT_AHEAD_PAGES = 3;
/** Painted pages are only released once they fall outside this wider band. The
 *  gap between the two bounds is hysteresis: scrolling back and forth across a
 *  page boundary must not thrash a page between painted and released. */
const RELEASE_AFTER_PAGES = 8;

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
  //
  // Keyed by the scale the pixels were painted at, which is what makes a render
  // pass idempotent: re-running one repaints nothing, so mounting more page
  // canvases (or any other reason the effect re-runs) costs only the pages that
  // are actually missing. A page leaves this map the moment its pixels stop
  // being trustworthy — an edit marks it stale, or React hands us a different
  // canvas element, whose bitmap starts blank.
  const paintedPagesRef = useRef<Map<number, number>>(new Map());
  const allPagesPaintedRef = useRef(false);
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
  const pdfPerfRunRef = useRef<number | null>(null);
  // One pdf.js worker per viewer, reused across the documents that viewer opens.
  // Booting a worker measured 44-75 ms and was the ENTIRE cost of the "parse"
  // phase for small documents (reusing one drops it to 1-5 ms). It is scoped to
  // the viewer, not shared globally, on purpose: a document that wedges its
  // worker must not be able to wedge a PDF open in another window, and this hook
  // shows one document at a time anyway. A failed parse throws the worker away
  // so the next document still starts from a clean one.
  const pdfWorkerRef = useRef<pdfjs.PDFWorker | null>(null);

  const pdfWorker = useCallback((): pdfjs.PDFWorker => {
    if (!pdfWorkerRef.current) {
      pdfWorkerRef.current = new pdfjs.PDFWorker();
    }
    return pdfWorkerRef.current;
  }, []);

  /** Drop the worker after anything that leaves its state in doubt. */
  const discardPdfWorker = useCallback(() => {
    const worker = pdfWorkerRef.current;
    pdfWorkerRef.current = null;
    worker?.destroy();
  }, []);
  // Pages the viewer currently has on (or near) screen, 0-based. Null until the
  // viewer reports — meaning "no information yet", which is treated as "page 1",
  // never as "every page": a 748-page document must not rasterize itself just
  // because the observer has not fired.
  const onscreenPagesRef = useRef<ReadonlySet<number> | null>(null);
  const [onscreenVersion, setOnscreenVersion] = useState(0);
  const onscreenRaf = useRef<number | null>(null);
  // Intrinsic page sizes at scale 1, so the viewer can reserve correct layout
  // for pages it has not painted yet and geometry stops depending on paint.
  const pageSizesRef = useRef<Map<number, { width: number; height: number }>>(
    new Map()
  );
  const [pageSizeVersion, setPageSizeVersion] = useState(0);

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
    paintedPagesRef.current.clear();
    allPagesPaintedRef.current = false;
    setFirstPagePainted(false);
    lastRenderedDocRef.current = null;
    stalePaintPagesRef.current = null;
    staleTextPagesRef.current = null;
    textRunSourcesRef.current = [];
    extractedPageCountRef.current = 0;
    viewports.current.clear();
    canvasRefs.current.clear();
    canvasRefCallbacks.current.clear();
    onscreenPagesRef.current = null;
    pageSizesRef.current.clear();
    if (onscreenRaf.current !== null) {
      cancelAnimationFrame(onscreenRaf.current);
      onscreenRaf.current = null;
    }
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

  /**
   * Take ownership of bytes the caller holds exclusively, without copying them.
   *
   * Opening an N-byte PDF used to allocate 3N: the read itself, a defensive
   * snapshot, and the copy pdf.js transfers into its worker. The snapshot buys
   * nothing when the buffer came straight from `readFile`/`arrayBuffer` and no
   * one else holds a reference — and on a machine that is already swapping, a
   * spare 20 MB of short-lived allocation per open is paid for in page faults.
   *
   * The caller must own `next` outright and never mutate it afterwards. Every
   * other producer keeps making its own copy explicitly: edit transforms go
   * through `setCurrentBytes`, and the save path snapshots before it publishes.
   */
  const adoptSavedBytes = useCallback((next: Uint8Array) => {
    savedBytesRef.current = next;
    bytesRef.current = next;
    setBytes(next);
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
    // Stale pixels are not paint credit. Dropping the entries here is what lets
    // the render pass skip by "already painted" without ever skipping a page an
    // edit just invalidated.
    if (next === "all") {
      paintedPagesRef.current.clear();
      allPagesPaintedRef.current = false;
      return;
    }
    for (const page of next) paintedPagesRef.current.delete(page);
    allPagesPaintedRef.current = false;
  }, []);

  /** Tell the hook which pages are on screen. Coalesced to one frame: a scroll
   *  fires this continuously, and each distinct value would otherwise cancel and
   *  restart the render pass. */
  const setOnscreenPages = useCallback((pages: ReadonlySet<number>) => {
    const prev = onscreenPagesRef.current;
    if (prev && prev.size === pages.size) {
      let same = true;
      for (const page of pages) {
        if (!prev.has(page)) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    onscreenPagesRef.current = pages;
    if (onscreenRaf.current !== null) return;
    onscreenRaf.current = requestAnimationFrame(() => {
      onscreenRaf.current = null;
      setOnscreenVersion((v) => v + 1);
    });
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
            // No canvas, no painted pixels to credit this page with.
            paintedPagesRef.current.delete(pageIdx);
            allPagesPaintedRef.current = false;
            return;
          }
          const prev = canvasRefs.current.get(pageIdx);
          canvasRefs.current.set(pageIdx, el);
          if (prev !== el) {
            // A different canvas element starts blank however painted the old
            // one was, so this page owes a repaint.
            paintedPagesRef.current.delete(pageIdx);
            allPagesPaintedRef.current = false;
            // Drop the 300x150 bitmap every canvas is born with. Unpainted, it
            // is 180 kB of nothing — 135 MB across a 748-page document — and the
            // page's box comes from CSS now, not from the bitmap.
            el.width = 0;
            el.height = 0;
            markPdfPerf(pdfPerfRunRef.current, "canvas-mounted", {
              page: pageIdx + 1,
              mountedCanvases: canvasRefs.current.size,
            });
            bumpCanvasVersionSoon();
          }
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
      const doc = docRef.current;
      docRef.current = null;
      const worker = pdfWorkerRef.current;
      pdfWorkerRef.current = null;
      // The document's teardown talks to the worker ("Terminate"), so the worker
      // has to outlive it. Destroying the worker first strands that exchange and
      // leaks the thread.
      void Promise.resolve(doc?.destroy())
        .catch(() => undefined)
        .finally(() => worker?.destroy());
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
      pdfPerfRunRef.current = startPdfPerfRun(file);
      resetDocumentState();
      markPdfPerf(pdfPerfRunRef.current, "state-reset");
      setStatus("Loading PDF...");
    }
    (async () => {
      try {
        // readFile/arrayBuffer both hand us a fresh buffer nothing else holds,
        // so it is adopted rather than copied — see adoptSavedBytes.
        let data: Uint8Array;
        markPdfPerf(pdfPerfRunRef.current, "bytes-read-start", {
          source: IN_TAURI ? "tauri-fs" : "fetch",
        });
        if (IN_TAURI && file) data = await readFile(file.path);
        else {
          const r = await fetch(urlForPath(file!.path));
          data = new Uint8Array(await r.arrayBuffer());
        }
        markPdfPerf(pdfPerfRunRef.current, "bytes-read-end", {
          bytes: data.byteLength,
        });
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
              adoptSavedBytes(data);
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
            adoptSavedBytes(data);
            setStatus("Reloaded — this PDF changed on disk.");
          });
          return;
        }
        // Form fields are extracted lazily (edit mode only) by the effect
        // below — pdf-lib's full main-thread parse has no place on the open path.
        adoptSavedBytes(data);
        markPdfPerf(pdfPerfRunRef.current, "bytes-adopted");
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
    adoptSavedBytes,
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
        markPdfPerf(pdfPerfRunRef.current, "pdfjs-parse-start", {
          bytes: bytes.byteLength,
        });
        // Passing our own worker also changes who owns it: pdf.js only destroys
        // the worker it created itself, so `doc.destroy()` below tears down the
        // document and leaves this worker warm for the next one.
        const next = await pdfjs.getDocument({
          data: sanitizePdfBytes(bytes).slice(0),
          worker: pdfWorker(),
        }).promise;
        if (cancelled) {
          void next.destroy();
          return;
        }
        docRef.current?.destroy();
        docRef.current = next;
        setPageCount(next.numPages);
        setDoc(next);
        markPdfPerf(pdfPerfRunRef.current, "pdfjs-parse-end", {
          pages: next.numPages,
        });
      } catch (err) {
        if (!cancelled && !isPdfjsCancellation(err)) {
          console.error("[mesa] PDF parse failed:", err);
          // Whatever this document did to the worker, the next one starts fresh.
          discardPdfWorker();
          setRenderError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, bytes, pdfWorker, discardPdfWorker]);

  // Fillable form fields — pdf-lib parses the whole document on the main
  // thread, so this only runs when the caller actually wants fields (edit mode).
  useEffect(() => {
    if (!enabled || !formFields || !bytes) {
      setFields([]);
      return;
    }
    let cancelled = false;
    markPdfPerf(pdfPerfRunRef.current, "form-fields-start");
    void getFormFields(bytes).then(
      (next) => {
        if (!cancelled) {
          setFields(next);
          markPdfPerf(pdfPerfRunRef.current, "form-fields-end", {
            fields: next.length,
          });
        }
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
        const mountedPageNumbers = Array.from(canvasRefs.current.keys())
          .map((pageIdx) => pageIdx + 1)
          .filter((pageNumber) => pageNumber >= 1 && pageNumber <= doc.numPages)
          .sort((a, b) => a - b);
        const targetPageNumbers =
          stalePageNumbers(stalePages, doc.numPages) ??
          Array.from({ length: doc.numPages }, (_, pageIdx) => pageIdx + 1);
        const mountedPages = new Set(mountedPageNumbers);
        const window = pdfPageWindow(onscreenPagesRef.current, doc.numPages, {
          ahead: PAINT_AHEAD_PAGES,
          keep: RELEASE_AFTER_PAGES,
        });
        // Hand back the pixel memory of pages that have scrolled well out of
        // reach before painting new ones, so the peak is the window and not the
        // document. Their paint credit goes with them: the canvas is genuinely
        // blank afterwards, so scrolling back must repaint rather than trust it.
        for (const [pageIdx] of paintedPagesRef.current) {
          if (window.keep.has(pageIdx + 1)) continue;
          const canvas = canvasRefs.current.get(pageIdx);
          if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
          }
          paintedPagesRef.current.delete(pageIdx);
          allPagesPaintedRef.current = false;
          countPdfPerf(pdfPerfRunRef.current, "pagesReleased");
        }
        // Three filters, all load-bearing. A page with no canvas cannot be
        // painted at all; a page outside the window is not worth painting; and a
        // page already holding this scale's pixels has nothing to gain from
        // being painted again — that last one keeps the pass idempotent, so the
        // mount of page 200 costs one page instead of re-rasterizing the 199 in
        // front of it.
        const pageNumbers = targetPageNumbers.filter(
          (pageNumber) =>
            mountedPages.has(pageNumber) &&
            window.paint.has(pageNumber) &&
            paintedPagesRef.current.get(pageNumber - 1) !== renderScale
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
          renderCanvas.width = viewport.width;
          renderCanvas.height = viewport.height;
          const renderCtx = renderCanvas.getContext("2d");
          if (!renderCtx) continue;
          activeTask = page.render({ canvasContext: renderCtx, viewport });
          await activeTask.promise;
          activeTask = null;
          countPdfPerf(pdfPerfRunRef.current, "pageRasters");
          if (i === 1) markPdfPerf(pdfPerfRunRef.current, "page-1-raster-end");
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
          setRenderError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      activeTask?.cancel();
    };
  }, [enabled, doc, renderScale, canvasVersion, onscreenVersion]);

  // Measure every page once, at scale 1, without painting anything. The viewer
  // needs each page's box to reserve correct layout for pages it has not painted
  // (otherwise the scroll height is a lie and the observer reporting which pages
  // are on screen has nothing sound to report), and pointer mapping needs the
  // viewport of any page the user can reach. Measuring is metadata only — no
  // rasterization, no pixel memory — and it runs after first paint, in chunks,
  // yielding between them so it never competes with the page being read.
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
  }, [enabled, doc, firstPagePainted]);

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
          paintedPagesRef.current.clear();
          allPagesPaintedRef.current = false;
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
        paintedPagesRef.current.clear();
        allPagesPaintedRef.current = false;
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
        paintedPagesRef.current.clear();
        allPagesPaintedRef.current = false;
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
    /** Pages holding painted pixels, mapped to the scale they were painted at. */
    paintedPages: paintedPagesRef.current,
    /** Intrinsic page boxes at scale 1, for reserving layout before paint. */
    pageSizes: pageSizesRef.current,
    pageSizeVersion,
    setOnscreenPages,
    firstPagePainted,
    perfRunId: pdfPerfRunRef.current,
    bindCanvas,
    apply,
    undo,
    redo,
    save,
  };
}
