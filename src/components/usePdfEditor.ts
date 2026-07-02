import { useCallback, useEffect, useRef, useState } from "react";
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

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfTextRun {
  page: number;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  pdfX: number;
  pdfY: number;
  pdfWidth: number;
  pdfHeight: number;
}

interface PdfEditorOptions {
  enabled?: boolean;
  extractText?: boolean;
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
export function usePdfEditor(
  file: VaultFile | undefined,
  { enabled = true, extractText = false, reloadToken }: PdfEditorOptions = {}
) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [renderScale, setRenderScale] = useState(1.2);
  const [canvasVersion, setCanvasVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [renderError, setRenderError] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [fields, setFields] = useState<FormField[]>([]);
  const [textRuns, setTextRuns] = useState<PdfTextRun[]>([]);
  const [renderedPages, setRenderedPages] = useState<Set<number>>(() => new Set());
  const [history, setHistory] = useState<Uint8Array[]>([]);
  const [future, setFuture] = useState<Uint8Array[]>([]);
  const viewports = useRef<Map<number, pdfjs.PageViewport>>(new Map());
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const renderCanvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const renderPageOverrideRef = useRef<Set<number> | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const savedBytesRef = useRef<Uint8Array | null>(null);
  const historyRef = useRef<Uint8Array[]>([]);
  const futureRef = useRef<Uint8Array[]>([]);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
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
    setBytes(null);
    setRenderError(false);
    setLoadFailed(false);
    setHistory([]);
    setFuture([]);
    setTextRuns([]);
    setDirty(false);
    setStatus("");
    setPageCount(0);
    setFields([]);
    setRenderedPages(new Set());
    viewports.current.clear();
    canvasRefs.current.clear();
    renderCanvasRefs.current.clear();
    canvasRefCallbacks.current.clear();
    if (canvasVersionRaf.current !== null) {
      cancelAnimationFrame(canvasVersionRaf.current);
      canvasVersionRaf.current = null;
    }
  }, []);

  const setHistorySnapshots = useCallback((next: Uint8Array[]) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  const setFutureSnapshots = useCallback((next: Uint8Array[]) => {
    futureRef.current = next;
    setFuture(next);
  }, []);

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

  const refreshFormFields = useCallback(async (next: Uint8Array) => {
    setFields(await getFormFields(next).catch(() => []));
  }, []);

  const enqueue = useCallback((operation: () => Promise<void>): Promise<void> => {
    const job = queueRef.current.then(operation);
    queueRef.current = job.catch(() => undefined);
    return job;
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

  // load bytes from disk (or fetch in the browser/demo); re-runs when the
  // reloadToken says the file changed on disk underneath us
  const loadedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !file) {
      loadedPathRef.current = null;
      resetDocumentState();
      return;
    }
    const isNewDocument = loadedPathRef.current !== file.path;
    loadedPathRef.current = file.path;
    let cancelled = false;
    let raf = 0;
    if (isNewDocument) {
      resetDocumentState();
      setStatus("Loading PDF...");
    }
    (async () => {
      try {
        let data: Uint8Array;
        if (IN_TAURI && file) data = await readFile(file.path);
        else {
          const r = await fetch(urlForPath(file!.path));
          data = new Uint8Array(await r.arrayBuffer());
        }
        if (cancelled) return;
        data = copyPdfBytes(data);
        if (!isNewDocument) {
          // Same document, changed on disk. Serialize through the byte queue so
          // an in-flight edit transform cannot interleave with the reload.
          await enqueue(async () => {
            if (cancelled) return;
            const saved = savedBytesRef.current;
            if (saved && pdfBytesEqual(data, saved)) return; // our own save echo
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
            renderPageOverrideRef.current = null;
            setHistorySnapshots([]);
            setFutureSnapshots([]);
            setSavedBytes(data);
            await refreshFormFields(data);
            setStatus("Reloaded — this PDF changed on disk.");
          });
          return;
        }
        setSavedBytes(data);
        // Let the editor paint page 1 immediately, then fill in the full page
        // count and form metadata after the first render has a chance to land.
        setPageCount(1);
        raf = requestAnimationFrame(async () => {
          if (cancelled) return;
          try {
            setFields(await getFormFields(data).catch(() => []));
          } catch {
            if (!cancelled) setFields([]);
          }
        });
      } catch (e) {
        if (!cancelled && isNewDocument) {
          setStatus(`Could not open PDF: ${String(e)}`);
          setLoadFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [
    enabled,
    file?.path,
    reloadToken,
    enqueue,
    refreshFormFields,
    resetDocumentState,
    setHistorySnapshots,
    setFutureSnapshots,
    setSavedBytes,
  ]);

  // render every page with pdf.js whenever the bytes or settled zoom change
  useEffect(() => {
    if (!enabled || !bytes) return;
    let cancelled = false;
    let doc: pdfjs.PDFDocumentProxy | null = null;
    let activeTask: pdfjs.RenderTask | null = null;
    (async () => {
      try {
        doc = await pdfjs.getDocument({ data: sanitizePdfBytes(bytes).slice(0) })
          .promise;
        if (cancelled) return;
        setPageCount(doc.numPages);
        const pageOverride = renderPageOverrideRef.current;
        renderPageOverrideRef.current = null;
        const pageNumbers = pageOverride
          ? [...pageOverride]
              .filter((pageIdx) => pageIdx >= 0 && pageIdx < doc!.numPages)
              .sort((a, b) => a - b)
              .map((pageIdx) => pageIdx + 1)
          : Array.from({ length: doc.numPages }, (_, pageIdx) => pageIdx + 1);
        for (const i of pageNumbers) {
          const page = await doc.getPage(i);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: renderScale });
          viewports.current.set(i - 1, viewport);
          const canvas = canvasRefs.current.get(i - 1);
          if (!canvas) continue;
          let renderCanvas = renderCanvasRefs.current.get(i - 1);
          if (!renderCanvas) {
            renderCanvas = document.createElement("canvas");
            renderCanvasRefs.current.set(i - 1, renderCanvas);
          }
          renderCanvas.width = viewport.width;
          renderCanvas.height = viewport.height;
          const renderCtx = renderCanvas.getContext("2d");
          if (!renderCtx) continue;
          activeTask = page.render({ canvasContext: renderCtx, viewport });
          await activeTask.promise;
          activeTask = null;
          if (cancelled) return;
          if (i === 1) {
            try {
              const pixels = renderCtx.getImageData(
                0,
                0,
                renderCanvas.width,
                renderCanvas.height
              );
              if (
                isLikelyBlankPdfPaint(
                  pixels.data,
                  renderCanvas.width,
                  renderCanvas.height
                )
              ) {
                throw new Error("pdf.js rendered a blank first page");
              }
            } catch (err) {
              if (err instanceof Error && /blank first page/i.test(err.message)) {
                throw err;
              }
            }
          }
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          ctx.drawImage(renderCanvas, 0, 0);
          setRenderedPages((prev) => {
            if (prev.has(i - 1)) return prev;
            const next = new Set(prev);
            next.add(i - 1);
            return next;
          });
          if (i === 1) {
            setStatus("");
            setPageCount(doc.numPages);
          } else if (doc.numPages > 8) {
            await nextFrame();
          }
        }
        setRenderError(false);
      } catch {
        if (!cancelled) setRenderError(true);
      }
    })();
    return () => {
      cancelled = true;
      activeTask?.cancel();
      doc?.destroy();
    };
  }, [enabled, bytes, renderScale, canvasVersion]);

  useEffect(() => {
    if (!enabled || !extractText || !bytes) {
      setTextRuns([]);
      return;
    }
    let cancelled = false;
    let doc: pdfjs.PDFDocumentProxy | null = null;
    (async () => {
      try {
        doc = await pdfjs.getDocument({ data: sanitizePdfBytes(bytes).slice(0) })
          .promise;
        const nextTextRuns: PdfTextRun[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: renderScale });
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
            const cssHeight =
              Math.hypot(matrix[2], matrix[3]) ||
              Math.max(8, (raw.height ?? 10) * renderScale);
            const cssWidth = Math.max(8, (raw.width ?? value.length * 6) * renderScale);
            const pdfHeight = Math.max(6, raw.height ?? cssHeight / renderScale);
            const pdfWidth = Math.max(6, raw.width ?? cssWidth / renderScale);
            nextTextRuns.push({
              page: i - 1,
              text: raw.str ?? "",
              left: matrix[4],
              top: matrix[5] - cssHeight,
              width: cssWidth,
              height: cssHeight,
              pdfX: raw.transform[4],
              pdfY: raw.transform[5] - pdfHeight * 0.22,
              pdfWidth,
              pdfHeight: pdfHeight * 1.15,
            });
          }
          if (i % 4 === 0) await nextFrame();
        }
        if (!cancelled) setTextRuns(nextTextRuns);
      } catch {
        if (!cancelled) setTextRuns([]);
      }
    })();
    return () => {
      cancelled = true;
      doc?.destroy();
    };
  }, [enabled, extractText, bytes, renderScale]);

  /** Run a byte transform, pushing the previous bytes onto the undo stack. */
  const apply = (transform: PdfTransform, options: PdfApplyOptions = {}) => {
    return enqueue(async () => {
      const before = bytesRef.current;
      if (!before) return;
      try {
        const beforeSnapshot = copyPdfBytes(before);
        const result = copyPdfBytes(await transform(beforeSnapshot));
        await assertValidPdfBytes(result);
        if (pdfBytesEqual(beforeSnapshot, result)) {
          return;
        }
        renderPageOverrideRef.current =
          options.structural || !options.pages?.length
            ? null
            : new Set(options.pages.map((page) => Math.trunc(page)));
        if (options.structural) {
          setRenderedPages(new Set());
        }
        setHistorySnapshots([...historyRef.current, beforeSnapshot]);
        setFutureSnapshots([]);
        setCurrentBytes(result);
        await refreshFormFields(result);
      } catch (e) {
        setStatus(`Edit failed: ${String(e)}`);
      }
    });
  };

  const undo = () => {
    return enqueue(async () => {
      const current = bytesRef.current;
      const history = historyRef.current;
      if (!history.length || !current) return;
      const previous = copyPdfBytes(history[history.length - 1]);
      try {
        await assertValidPdfBytes(previous);
        renderPageOverrideRef.current = null;
        setRenderedPages(new Set());
        setHistorySnapshots(history.slice(0, -1));
        setFutureSnapshots([...futureRef.current, copyPdfBytes(current)]);
        setCurrentBytes(previous);
        await refreshFormFields(previous);
      } catch (e) {
        setStatus(`Undo failed: ${String(e)}`);
      }
    });
  };
  const redo = () => {
    return enqueue(async () => {
      const current = bytesRef.current;
      const future = futureRef.current;
      if (!future.length || !current) return;
      const next = copyPdfBytes(future[future.length - 1]);
      try {
        await assertValidPdfBytes(next);
        renderPageOverrideRef.current = null;
        setRenderedPages(new Set());
        setFutureSnapshots(future.slice(0, -1));
        setHistorySnapshots([...historyRef.current, copyPdfBytes(current)]);
        setCurrentBytes(next);
        await refreshFormFields(next);
      } catch (e) {
        setStatus(`Redo failed: ${String(e)}`);
      }
    });
  };

  const save = async () => {
    return enqueue(async () => {
      const current = bytesRef.current;
      if (!current || !file) return;
      const snapshot = copyPdfBytes(current);
      try {
        await assertValidPdfBytes(snapshot);
        if (IN_TAURI) {
          // Stale-overwrite guard: if the file on disk no longer matches the
          // bytes this editing session started from, another tool changed it.
          // Overwriting would silently destroy that newer version — refuse.
          const baseline = savedBytesRef.current;
          const disk = await readFile(file.path).catch(() => null);
          if (disk && baseline && !pdfBytesEqual(copyPdfBytes(disk), baseline)) {
            setStatus(
              "Save blocked: this PDF changed on disk after it was opened. Your edits are still here — reopen the file to load the newer version, or duplicate it to keep both."
            );
            return;
          }
          await persistPdfBytes(file.path, snapshot, {
            readFile,
            writeFile,
            remove,
            exists,
            rename,
          });
          savedBytesRef.current = copyPdfBytes(snapshot);
          setDirty(false);
          setStatus("Saved.");
        } else {
          setStatus("Editing is read-only in the browser demo.");
        }
      } catch (e) {
        setStatus(`Save failed: ${String(e)}`);
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
    renderedPages,
    bindCanvas,
    renderCanvasRefs,
    apply,
    undo,
    redo,
    save,
  };
}
