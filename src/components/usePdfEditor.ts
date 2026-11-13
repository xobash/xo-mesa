import { useCallback, useEffect, useRef, useState } from "react";
// The legacy display build supplies the runtime compatibility shims required
// by Mesa's supported Safari 16.4 / WebView2 111 floor (notably
// Promise.withResolvers). Keep the worker from the same distribution: mixing
// modern display code with a legacy worker is an unsupported PDF.js pairing.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { readFile } from "@tauri-apps/plugin-fs";
import { IN_TAURI, urlForPath } from "../lib/vault";
import type { VaultFile } from "../types";
import {
  copyPdfBytes,
  isNotAPdf,
  pdfBytesEqual,
  sanitizePdfBytes,
} from "../lib/pdfBytes";
import type { FormField } from "../lib/pdf";
import { loadPdfEditModule } from "../lib/pdfEditModule";
import { pdfHistoryBytes, trimPdfHistory } from "../lib/pdfHistory";
import type { PdfTextRunSource } from "../lib/pdfTextRuns";
import { addStalePages, type StalePages } from "../lib/pdfStalePages";
import {
  primePdfWorker,
  releaseUnusedPdfWorker,
  takePdfWorker,
} from "../lib/pdfWorkerPool";
import { markPdfPerf, startPdfPerfRun } from "./pdfPerf";
import { useDevicePixelRatio } from "./useDevicePixelRatio";
import { isPdfjsCancellation } from "./pdfjsTasks";
import { usePdfPagePaint } from "./usePdfPagePaint";
import { usePdfTextRunExtraction } from "./usePdfTextRunExtraction";
import { savePdfEditorBytes } from "./pdfEditorSave";
import { type PdfEditorOptions, type PdfApplyOptions, type PdfTransform } from "./pdfEditorTypes";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PdfTextRun } from "../lib/pdfTextRuns";

/**
 * All of the PDF *document* logic — loading bytes, rendering pages with pdf.js,
 * the undo/redo history, and saving — extracted from the view so the component
 * is just annotation UI. Returns the canvas/viewport refs the view binds to.
 * Page painting, text-run extraction and saving live in their own modules.
 */
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
  // Track painted scale per page in a ref. Invalidate on edits, canvas replacement, or release;
  // only first-page completion requires a UI publication.
  const paintedPagesRef = useRef<Map<number, number>>(new Map());
  const allPagesPaintedRef = useRef(false);
  const devicePixelRatio = useDevicePixelRatio();
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
  // Reuse one worker per viewer; discard it after parse failure.
  // Viewer scope keeps a failed document isolated from other windows.
  const pdfWorkerRef = useRef<pdfjs.PDFWorker | null>(null);
  // Whether the worker currently held has been handed a document. Only a worker
  // that never has may go back to the shared spare slot.
  const pdfWorkerUsedRef = useRef(false);

  const pdfWorker = useCallback((): pdfjs.PDFWorker => {
    if (!pdfWorkerRef.current) {
      // A spare has never been given a document, so adopting one is exactly
      // equivalent to constructing one here — and it is already booted.
      const warm = takePdfWorker();
      if (warm) {
        pdfWorkerRef.current = warm;
        markPdfPerf(pdfPerfRunRef.current, "worker-adopted-warm");
        return warm;
      }
      // Time worker boot separately from document parsing.
      markPdfPerf(pdfPerfRunRef.current, "worker-boot-start");
      const worker = new pdfjs.PDFWorker();
      pdfWorkerRef.current = worker;
      void worker.promise.then(
        () => markPdfPerf(pdfPerfRunRef.current, "worker-boot-ready"),
        () => undefined
      );
    }
    return pdfWorkerRef.current;
  }, []);

  /** Drop the worker after anything that leaves its state in doubt. */
  const discardPdfWorker = useCallback(() => {
    const worker = pdfWorkerRef.current;
    pdfWorkerRef.current = null;
    pdfWorkerUsedRef.current = false;
    worker?.destroy();
  }, []);
  // Zero-based on-screen pages. Until the viewer reports, paint page 1 only.
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

  // Every caller already owns an isolated snapshot: apply copies the transform
  // result, and undo/redo copy the history entry before validation. Adopt that
  // snapshot here; another full-document copy adds peak memory, not isolation.
  const setCurrentBytes = useCallback((snapshot: Uint8Array) => {
    bytesRef.current = snapshot;
    setBytes(snapshot);
    setDirty(
      savedBytesRef.current ? !pdfBytesEqual(snapshot, savedBytesRef.current) : false
    );
  }, []);

  /** Adopt exclusively owned bytes without copying. The caller must not mutate them after adoption. */
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
            // Release the default bitmap; CSS determines the unpainted page box.
            el.width = 0;
            el.height = 0;
            markPdfPerf(pdfPerfRunRef.current, "canvas-mounted", {
              page: pageIdx + 1,
              mountedCanvases: canvasRefs.current.size,
            });
            // A newly parsed document already schedules a render through the
            // `doc` dependency, and refs are committed before passive effects,
            // so that pass sees this canvas. Bumping canvasVersion as well used
            // to cancel page 1 moments after it started and launch it again.
            // Later shell/remount publications still need their own pass.
            const currentDoc = docRef.current;
            if (currentDoc && lastRenderedDocRef.current === currentDoc) {
              bumpCanvasVersionSoon();
            }
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
    const generationRef = documentGenerationRef;
    return () => {
      generationRef.current++;
      operationPathRef.current = null;
      const doc = docRef.current;
      docRef.current = null;
      const worker = pdfWorkerRef.current;
      const used = pdfWorkerUsedRef.current;
      pdfWorkerRef.current = null;
      pdfWorkerUsedRef.current = false;
      if (worker && !used && !doc) {
        // Mounted and left without ever parsing anything (rapid tab switching,
        // React's development double-mount). Nothing is waiting on this worker,
        // so hand it straight back — synchronously, because the remount that
        // follows a fast switch asks for a spare before any microtask would
        // have run. Still virgin, so the next open can have it.
        releaseUnusedPdfWorker(worker);
        return;
      }
      // The document's teardown talks to the worker ("Terminate"), so the worker
      // has to outlive it. Destroying the worker first strands that exchange and
      // leaks the thread. `used` is set before the document is ever requested,
      // so an unused worker cannot have one — but the teardown runs either way
      // rather than trusting that ordering to hold forever.
      void Promise.resolve(doc?.destroy())
        .catch(() => undefined)
        .finally(() => {
          if (!worker) return;
          if (!used) {
            // Mounted and left without ever parsing anything (rapid tab
            // switching, the development double-mount). Still virgin, so the
            // next open can have it instead of booting another.
            releaseUnusedPdfWorker(worker);
            return;
          }
          worker.destroy();
          // Prime a fresh spare for the next open; this used worker is destroyed
          // with its viewer and cannot be recycled.
          primePdfWorker(() => new pdfjs.PDFWorker());
        });
    };
  }, []);

  // load bytes from disk (or fetch in the browser/demo); re-runs when the
  // reloadToken says the file changed on disk underneath us
  const loadedPathRef = useRef<string | null>(null);
  const selectedFileRef = useRef(file);
  selectedFileRef.current = file;
  useEffect(() => {
    const selectedFile = selectedFileRef.current;
    if (!enabled || !selectedFile) {
      if (operationPathRef.current !== null) {
        documentGenerationRef.current++;
        operationPathRef.current = null;
      }
      loadedPathRef.current = null;
      resetDocumentState();
      return;
    }
    const isNewDocument = loadedPathRef.current !== selectedFile.path;
    if (operationPathRef.current !== selectedFile.path) {
      documentGenerationRef.current++;
      operationPathRef.current = selectedFile.path;
    }
    loadedPathRef.current = selectedFile.path;
    let cancelled = false;
    if (isNewDocument) {
      pdfPerfRunRef.current = startPdfPerfRun(selectedFile);
      resetDocumentState();
      markPdfPerf(pdfPerfRunRef.current, "state-reset");
      setStatus("Loading PDF...");
    }
    // Claim the worker now rather than in the parse effect below. With a warm
    // spare this is free; without one, the boot at least overlaps the byte read
    // instead of starting only after every byte has landed.
    pdfWorker();
    (async () => {
      try {
        // readFile/arrayBuffer both hand us a fresh buffer nothing else holds,
        // so it is adopted rather than copied — see adoptSavedBytes.
        let data: Uint8Array;
        markPdfPerf(pdfPerfRunRef.current, "bytes-read-start", {
          source: IN_TAURI ? "tauri-fs" : "fetch",
        });
        if (IN_TAURI) data = await readFile(selectedFile.path);
        else {
          const r = await fetch(urlForPath(selectedFile.path));
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
    pdfWorker,
    resetDocumentState,
    setHistorySnapshots,
    setFutureSnapshots,
    adoptSavedBytes,
    markStale,
  ]);

  // Parse the document once per byte-state. Rendering, zooming, and text
  // extraction all reuse this proxy without reparsing at each zoom settle.
  useEffect(() => {
    if (!enabled || !bytes) {
      docRef.current?.destroy();
      docRef.current = null;
      setDoc(null);
      return;
    }
    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;
    let loadingActive = false;
    (async () => {
      try {
        // pdf.js transfers this buffer to its worker, so it gets its own copy.
        markPdfPerf(pdfPerfRunRef.current, "pdfjs-parse-start", {
          bytes: bytes.byteLength,
        });
        // Reject non-PDF bytes before engaging the worker; retain a worker that has not parsed a document.
        const clean = sanitizePdfBytes(bytes).slice(0);
        // Passing our own worker also changes who owns it: pdf.js only destroys
        // the worker it created itself, so `doc.destroy()` below tears down the
        // document and leaves this worker warm for the next one.
        const worker = pdfWorker();
        // This worker now owns document state and cannot return to the shared
        // spare slot.
        pdfWorkerUsedRef.current = true;
        loadingTask = pdfjs.getDocument({ data: clean, worker, isEvalSupported: false });
        loadingActive = true;
        const next = await loadingTask.promise;
        loadingActive = false;
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
          if (!isNotAPdf(err)) {
            console.error("[mesa] PDF parse failed:", err);
            // Discard workers after pdf.js failure. Mesa header rejection leaves an untouched worker reusable.
            discardPdfWorker();
          }
          // The load is over; leaving "Loading PDF..." above the fallback would
          // claim work is still in flight when nothing is.
          setStatus("");
          setRenderError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (loadingActive) {
        loadingActive = false;
        const task = loadingTask;
        loadingTask = null;
        // A parse can retain both the sanitized bytes and pdf.js's transferred
        // copy. Destroy the loading task when this document is replaced or
        // unmounted so stale large-PDF work stops instead of waiting for the
        // worker to finish. Expected cancellation failures are ignored by the
        // existing cancelled guard above.
        void task?.destroy().catch(() => undefined);
      }
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
    void loadPdfEditModule().then(({ getFormFields }) => getFormFields(bytes)).then(
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

  usePdfPagePaint({
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
  });

  const textRuns = usePdfTextRunExtraction({
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
  });

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
        const { assertValidPdfBytes } = await loadPdfEditModule();
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
        const { assertValidPdfBytes } = await loadPdfEditModule();
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
        const { assertValidPdfBytes } = await loadPdfEditModule();
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
      await savePdfEditorBytes({
        path: targetFile.path,
        current,
        baseline,
        isCurrent: () => isCurrentDocumentGeneration(document),
        onSaved: (snapshot) => {
          savedBytesRef.current = snapshot;
          setDirty(false);
        },
        setStatus,
      });
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
