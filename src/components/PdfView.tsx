import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppStore } from "../store";
import {
  claimKeyboardShortcut,
  isTextEntryTarget,
  undoRedoShortcutAction,
} from "../lib/shortcuts";
import { invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "../lib/vault";
import { groupPdfTextRunsByPage } from "../lib/pdfTextRuns";
import { usePdfEditor } from "./usePdfEditor";
import { usePdfZoom } from "./usePdfZoom";
import { findPdfHeader, sniffFileType, sanitizePdfBytes } from "../lib/pdfBytes";
import type { InkPoint, RGB } from "../lib/pdf";
import { loadPdfEditModule } from "../lib/pdfEditModule";
import type { VaultFile } from "../types";
import type { PdfTextRun } from "./usePdfEditor";
import { markPdfPerf } from "./pdfPerf";
import { createFramePublisher } from "../lib/framePublisher";

type Tool = "select" | "edit" | "text" | "highlight" | "ink";

/** Delay before showing the native read-only fallback while page 1 is loading. */
const NATIVE_WARM_START_DELAY_MS = 120;

const COLORS: { label: string; rgb: RGB }[] = [
  { label: "Black", rgb: { r: 0, g: 0, b: 0 } },
  { label: "Red", rgb: { r: 0.85, g: 0.12, b: 0.12 } },
  { label: "Blue", rgb: { r: 0.1, g: 0.45, b: 0.95 } },
  { label: "Yellow", rgb: { r: 1, g: 0.85, b: 0.15 } },
];

interface PendingText {
  page: number;
  // page-local PDF coords (bottom-left origin)
  pdfX: number;
  pdfY: number;
  // screen position for the input overlay
  left: number;
  top: number;
}

interface PendingReplace {
  run: PdfTextRun;
  left: number;
  top: number;
}

export function PdfView({
  rel,
  file: explicitFile,
  onDirtyChange,
}: {
  rel: string;
  /** Standalone document windows pass the selected file explicitly. */
  file?: VaultFile;
  /** Lets a native document window refuse to close while PDF edits remain. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const storeFile = useAppStore((s) => s.fileFor(rel));
  const file = explicitFile ?? storeFile;
  // Subscribe to the file's mtime (updated by the vault watcher) so the viewer
  // re-checks the disk bytes when another tool rewrites this PDF. The store
  // mutates the VaultFile in place, so the primitive mtime is the reliable
  // subscription target — object identity does not change.
  const storeFileMtime = useAppStore((s) => s.fileFor(rel)?.mtime);
  const fileMtime = explicitFile?.mtime ?? storeFileMtime;
  // PDFs open in the native read-only viewer first. pdf.js/pdf-lib work starts
  // only after the user enters edit mode so large PDFs do not slow browsing.
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [tool, setTool] = useState<Tool>("select");

  // All document/IO/history logic lives in the hook; this component is UI.
  const {
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
    firstPagePainted,
    canUndo,
    canRedo,
    viewports,
    canvasRefs,
    bindCanvas,
    pageSizes,
    pageSizeVersion,
    setOnscreenPages,
    perfRunId,
    apply,
    undo,
    redo,
    save,
  } = usePdfEditor(file, {
    enabled: true,
    extractText: mode === "edit" && tool === "edit",
    // pdf-lib's whole-document parse for form fields only runs once the user
    // is actually editing — never on the open path.
    formFields: mode === "edit",
    reloadToken: fileMtime,
  });

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const [color, setColor] = useState<RGB>(COLORS[0].rgb);
  const [size, setSize] = useState(14);
  const [showForm, setShowForm] = useState(false);
  const [mountedPageCount, setMountedPageCount] = useState(0);
  const [mountedForPath, setMountedForPath] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingText | null>(null);
  const [pendingValue, setPendingValue] = useState("");
  const [replacePending, setReplacePending] = useState<PendingReplace | null>(null);
  const [replaceValue, setReplaceValue] = useState("");
  const drag = useRef<{ page: number; x0: number; y0: number } | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const {
    bodyRef,
    scaleRef,
    manualZoomRef,
    pagesEl,
    pagesInnerEl,
    bindPages,
    bindPagesInner,
    zoomTo,
  } = usePdfZoom(scale, renderScale, setScale);
  const [dragBox, setDragBox] = useState<{
    page: number;
    left: number;
    top: number;
    w: number;
    h: number;
  } | null>(null);
  const ink = useRef<{
    page: number;
    points: InkPoint[];
    cssPoints: { x: number; y: number }[];
  } | null>(null);
  const [inkDraft, setInkDraft] = useState<{
    page: number;
    points: { x: number; y: number }[];
  } | null>(null);
  const inkDraftPublisherRef = useRef<ReturnType<
    typeof createFramePublisher<NonNullable<typeof ink.current>>
  > | null>(null);
  if (!inkDraftPublisherRef.current) {
    inkDraftPublisherRef.current = createFramePublisher(
      requestAnimationFrame,
      cancelAnimationFrame,
      (stroke) => {
        // Snapshot once per frame, not once per pointer event. `stroke` itself
        // remains the lossless mutable capture used for the final PDF edit.
        setInkDraft({ page: stroke.page, points: [...stroke.cssPoints] });
      }
    );
  }
  useEffect(() => () => inkDraftPublisherRef.current?.cancel(), []);
  const invalidPdfType = useMemo(() => {
    if (!bytes) return null;
    try {
      sanitizePdfBytes(bytes);
      return null;
    } catch {
      return sniffFileType(bytes);
    }
  }, [bytes]);
  const textRunsByPage = useMemo(
    () => groupPdfTextRunsByPage(textRuns),
    [textRuns]
  );
  // Start the native cover only if Mesa has not painted page 1 before the delay expires.
  const [warmStartDue, setWarmStartDue] = useState(false);
  useEffect(() => {
    if (firstPagePainted || loadFailed || renderError) {
      setWarmStartDue(false);
      return;
    }
    setWarmStartDue(false);
    const id = window.setTimeout(
      () => setWarmStartDue(true),
      NATIVE_WARM_START_DELAY_MS
    );
    return () => window.clearTimeout(id);
  }, [file?.path, firstPagePainted, loadFailed, renderError]);
  // The native cover opens only bytes that start with "%PDF-".
  const nativeFirstPaintSafe = !!bytes && findPdfHeader(bytes, 0) === 0;
  const showNativeFirstPaint =
    !loadFailed && !renderError && !firstPagePainted && warmStartDue && nativeFirstPaintSafe;
  // Both native frames (render fallback and first-paint cover) are fed from the
  // bytes already verified in memory — never a fresh disk path load — so they
  // always show exactly the document Mesa has open (including unsaved edits).
  const nativeFrameWanted = !!renderError || showNativeFirstPaint;
  const nativePdfUrl = useMemo(() => {
    if (!nativeFrameWanted || !bytes) return null;
    // The Blob copies exactly the view's bytes; an extra full copy first would
    // double the transient memory for a large document.
    return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
  }, [bytes, nativeFrameWanted]);
  const [nativeAdmission, setNativeAdmission] = useState<{ url: string; error?: string } | null>(null);
  useEffect(() => {
    if (!nativePdfUrl) return;
    let alive = true;
    const approve = IN_TAURI
      ? invoke("navigation_pdf_preview", { url: nativePdfUrl, allow: true })
      : Promise.resolve();
    void approve.then(() => {
      if (alive) setNativeAdmission({ url: nativePdfUrl });
    }).catch(reason => {
      if (alive) setNativeAdmission({ url: nativePdfUrl, error: `PDF fallback unavailable: ${String(reason)}` });
    });
    return () => {
      alive = false;
      void approve.then(() => {
        if (IN_TAURI) return invoke("navigation_pdf_preview", { url: nativePdfUrl, allow: false });
      }).catch(() => { /* Window destruction also revokes grants. */ });
    };
  }, [nativePdfUrl]);
  const nativeFrameReady = !!nativePdfUrl && nativeAdmission?.url === nativePdfUrl && !nativeAdmission.error;
  const nativeCoverVisible = showNativeFirstPaint && nativeFrameReady;

  // Mount page 1 in the commit that receives page count. Reset shells by path, not page count.
  if (mountedForPath !== (file?.path ?? null)) {
    setMountedForPath(file?.path ?? null);
    setMountedPageCount(0);
  }
  const shellCount =
    pageCount > 0 ? Math.min(pageCount, Math.max(mountedPageCount, 1)) : 0;

  // The rest of the shells follow once page 1 is up. Batches grow geometrically
  // so a 748-page document costs ~15 admissions rather than 93, while each
  // individual commit stays small enough not to stall the frame the user is
  // reading. Admitting a batch only ever costs the pages in it: the render pass
  // skips everything already painted at this scale.
  useEffect(() => {
    if (!firstPagePainted || shellCount >= pageCount) return;
    let cancelled = false;
    const id = window.setTimeout(() => {
      if (cancelled) return;
      setMountedPageCount((prev) => {
        const from = Math.max(prev, 1);
        const next = Math.min(pageCount, from + Math.min(64, Math.max(7, from)));
        if (next !== prev) {
          markPdfPerf(perfRunId, "page-shell-batch-mounted", {
            mountedPages: next,
            totalPages: pageCount,
          });
        }
        return next;
      });
    }, 16);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [firstPagePainted, shellCount, pageCount, perfRunId]);

  useEffect(() => {
    return () => {
      if (nativePdfUrl) URL.revokeObjectURL(nativePdfUrl);
    };
  }, [nativePdfUrl]);

  // Fit to width once per document until the user zooms manually.
  const fittedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pagesEl || !pageCount || !pageSizes.size) return;
    if (fittedPathRef.current !== file?.path) {
      fittedPathRef.current = file?.path ?? null;
      manualZoomRef.current = false;
    }
    const fit = () => {
      if (manualZoomRef.current) return;
      const width = pagesEl.clientWidth - 36;
      const first = pageSizes.get(0);
      if (!first || width <= 0) return;
      const second = pageSizes.get(1) ?? first;
      const spreadWidth = first.width + second.width;
      const twoPages = pageCount > 1 && width >= spreadWidth * 0.9 + 18;
      const fitScale = twoPages
        ? Math.min(1.4, (width - 18) / spreadWidth)
        : Math.min(1.6, width / first.width);
      const next = Math.max(0.5, Math.floor(fitScale * 100) / 100);
      if (Math.abs(next - scaleRef.current) > 0.01) {
        scaleRef.current = next;
        setScale(next);
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(pagesEl);
    return () => observer.disconnect();
  }, [pagesEl, pageCount, pageSizes, pageSizeVersion, file?.path, setScale, manualZoomRef, scaleRef]);
  useEffect(() => {
    const scroller = pagesEl;
    const inner = pagesInnerEl;
    // Start viewport publications after first paint so they cannot cancel the initial page-1 render.
    if (!firstPagePainted || !scroller || !inner || shellCount === 0) return;
    if (typeof IntersectionObserver === "undefined") {
      // Without an observer, fall back to "everything mounted is on screen".
      // That restores the previous whole-document behaviour rather than leaving
      // pages permanently blank.
      setOnscreenPages(new Set(Array.from({ length: shellCount }, (_, i) => i)));
      return;
    }
    const onscreen = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number(
            (entry.target as HTMLElement).dataset.pageIndex ?? "-1"
          );
          if (page < 0) continue;
          if (entry.isIntersecting) onscreen.add(page);
          else onscreen.delete(page);
        }
        setOnscreenPages(new Set(onscreen));
      },
      { root: scroller, rootMargin: "150% 0px" }
    );
    for (const wrap of inner.querySelectorAll<HTMLElement>(".pdf-page-wrap")) {
      observer.observe(wrap);
    }
    return () => observer.disconnect();
    // The containers participate so the observer is rebuilt when the scroll
    // container itself is (re)mounted, not just when the shell count changes.
  }, [firstPagePainted, shellCount, setOnscreenPages, pagesEl, pagesInnerEl]);

  /** Reserved CSS box for a page, at the current render scale. Pages that have
   *  not been measured yet borrow the nearest known page's box so the scroll
   *  height is approximately right immediately and exact once measured. */
  const pageBox = useCallback(
    (pageIdx: number): { width: number; height: number } | null => {
      void pageSizeVersion;
      const own = pageSizes.get(pageIdx);
      const fallback = own ?? pageSizes.get(0);
      if (!fallback) return null;
      return {
        width: Math.round(fallback.width * renderScale),
        height: Math.round(fallback.height * renderScale),
      };
    },
    [pageSizes, pageSizeVersion, renderScale]
  );

  const focusEditor = () => {
    editorRef.current?.focus({ preventScroll: true });
  };

  const handleUndoRedoShortcut = useCallback((
    e: React.KeyboardEvent | KeyboardEvent
  ): boolean => {
    if (mode !== "edit") return false;
    const action = undoRedoShortcutAction(e);
    if (!action) return false;
    const target = e.target instanceof Element ? e.target : null;
    if (isTextEntryTarget(target)) return false;
    claimKeyboardShortcut(e);
    if (action === "redo") {
      redo();
    } else {
      undo();
    }
    return true;
  }, [mode, redo, undo]);

  useEffect(() => {
    if (mode !== "edit") return;
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const ownsFocus =
        !active ||
        active === document.body ||
        active === editorRef.current ||
        !!editorRef.current?.contains(active);
      if (ownsFocus) handleUndoRedoShortcut(e);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [mode, handleUndoRedoShortcut]);

  // back to the read-only viewer whenever the open file changes
  useEffect(() => {
    setMode("view");
    setShowForm(false);
  }, [file?.path]);

  if (!file) return <div className="editor-empty">File not found.</div>;

  // map a pointer event on a page canvas to that page's PDF coordinates
  const toPdf = (pageIdx: number, e: React.PointerEvent | React.MouseEvent) => {
    const canvas = canvasRefs.current.get(pageIdx);
    const vp = viewports.current.get(pageIdx);
    if (!canvas || !vp) return null;
    // Skip pointer mapping until the page has a nonzero painted bitmap.
    if (canvas.width <= 0 || canvas.height <= 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    // Map through the CSS-pixel viewport, never the bitmap: the bitmap is
    // larger than the box by the device pixel ratio.
    const vx = ((e.clientX - rect.left) * vp.width) / rect.width;
    const vy = ((e.clientY - rect.top) * vp.height) / rect.height;
    const [pdfX, pdfY] = vp.convertToPdfPoint(vx, vy);
    return { pdfX, pdfY, cssX: vx, cssY: vy, rect };
  };

  const onPageClick = (pageIdx: number, e: React.MouseEvent) => {
    focusEditor();
    if (tool !== "text" || renderError) return;
    const p = toPdf(pageIdx, e);
    if (!p) return;
    setPending({
      page: pageIdx,
      pdfX: p.pdfX,
      pdfY: p.pdfY,
      left: p.cssX,
      top: p.cssY,
    });
    setPendingValue("");
  };

  const commitText = () => {
    if (!pending || !pendingValue.trim()) {
      setPending(null);
      return;
    }
    void apply(
      async (current) => {
        const { addText } = await loadPdfEditModule();
        return addText(current, {
          page: pending.page,
          x: pending.pdfX,
          y: pending.pdfY,
          text: pendingValue,
          size,
          color,
        });
      },
      { pages: [pending.page] }
    );
    setPending(null);
  };

  const startReplace = (run: PdfTextRun) => {
    setReplacePending({ run, left: run.left, top: run.top });
    setReplaceValue(run.text);
  };

  const commitReplace = () => {
    if (!replacePending) return;
    const next = replaceValue.trim();
    if (!next) {
      setReplacePending(null);
      return;
    }
    const { run } = replacePending;
    void apply(
      async (current) => {
        const { replaceText } = await loadPdfEditModule();
        return replaceText(current, {
          page: run.page,
          x: run.pdfX,
          y: run.pdfY,
          width: run.pdfWidth,
          height: run.pdfHeight,
          text: next,
          size: Math.max(8, Math.min(64, run.pdfHeight * 0.82)),
          color,
        });
      },
      { pages: [run.page] }
    );
    setReplacePending(null);
  };

  const strokeWidth = Math.max(1.5, Math.min(10, size / 4));

  // highlight + pencil drag
  const onDown = (pageIdx: number, e: React.PointerEvent) => {
    focusEditor();
    if ((tool !== "highlight" && tool !== "ink") || renderError) return;
    const p = toPdf(pageIdx, e);
    if (!p) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (tool === "ink") {
      const start = {
        page: pageIdx,
        points: [{ x: p.pdfX, y: p.pdfY }],
        cssPoints: [{ x: p.cssX, y: p.cssY }],
      };
      ink.current = start;
      setInkDraft({ page: pageIdx, points: start.cssPoints });
      return;
    }
    drag.current = { page: pageIdx, x0: p.pdfX, y0: p.pdfY };
    setDragBox({ page: pageIdx, left: p.cssX, top: p.cssY, w: 0, h: 0 });
  };
  const onMove = (pageIdx: number, e: React.PointerEvent) => {
    if (ink.current && ink.current.page === pageIdx) {
      const p = toPdf(pageIdx, e);
      if (!p) return;
      const last = ink.current.cssPoints[ink.current.cssPoints.length - 1];
      const dist = Math.hypot(p.cssX - last.x, p.cssY - last.y);
      if (dist < 1.5) return;
      ink.current.points.push({ x: p.pdfX, y: p.pdfY });
      ink.current.cssPoints.push({ x: p.cssX, y: p.cssY });
      inkDraftPublisherRef.current?.schedule(ink.current);
      return;
    }
    if (!drag.current || drag.current.page !== pageIdx) return;
    const canvas = canvasRefs.current.get(pageIdx);
    const vp = viewports.current.get(pageIdx);
    if (!canvas || !vp) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    setDragBox((b) =>
      b
        ? {
            ...b,
            w: ((e.clientX - rect.left) * vp.width) / rect.width - b.left,
            h: ((e.clientY - rect.top) * vp.height) / rect.height - b.top,
          }
        : b
    );
  };
  const onUp = (pageIdx: number, e: React.PointerEvent) => {
    if (ink.current && ink.current.page === pageIdx) {
      const p = toPdf(pageIdx, e);
      if (p) {
        const last = ink.current.cssPoints[ink.current.cssPoints.length - 1];
        if (Math.hypot(p.cssX - last.x, p.cssY - last.y) >= 0.5) {
          ink.current.points.push({ x: p.pdfX, y: p.pdfY });
          ink.current.cssPoints.push({ x: p.cssX, y: p.cssY });
        }
      }
      const stroke = ink.current;
      ink.current = null;
      inkDraftPublisherRef.current?.cancel();
      setInkDraft(null);
      if (stroke.points.length < 1) return;
      void apply(
        async (current) => {
          const { addInkStroke } = await loadPdfEditModule();
          return addInkStroke(current, {
            page: pageIdx,
            points: stroke.points,
            thickness: strokeWidth,
            color,
          });
        },
        { pages: [pageIdx] }
      );
      return;
    }
    if (!drag.current || drag.current.page !== pageIdx) return;
    const p = toPdf(pageIdx, e);
    const start = drag.current;
    drag.current = null;
    setDragBox(null);
    if (!p) return;
    const x = Math.min(start.x0, p.pdfX);
    const y = Math.min(start.y0, p.pdfY);
    const w = Math.abs(p.pdfX - start.x0);
    const h = Math.abs(p.pdfY - start.y0);
    if (w < 3 || h < 3) return;
    void apply(
      async (current) => {
        const { addHighlight } = await loadPdfEditModule();
        return addHighlight(current, { page: pageIdx, x, y, width: w, height: h, color });
      },
      { pages: [pageIdx] }
    );
  };

  return (
    <div
      className="pdf-editor"
      data-testid="pdf-editor"
      ref={editorRef}
      tabIndex={-1}
      onKeyDown={handleUndoRedoShortcut}
    >
      <div className="pdf-toolbar">
        {mode === "edit" && (
          <>
            <div className="seg">
              {(["select", "edit", "text", "highlight", "ink"] as Tool[]).map((t) => (
                <button
                  key={t}
                  className={"seg-btn" + (tool === t ? " on" : "")}
                  aria-pressed={tool === t}
                  aria-label={
                    t === "select"
                      ? "Select and scroll"
                      : t === "edit"
                      ? "Edit existing text"
                      : t === "ink"
                      ? "Draw with pencil"
                      : t === "highlight"
                      ? "Highlight area"
                      : "Add text"
                  }
                  onClick={() => setTool(t)}
                  title={
                    t === "select"
                      ? "Select / scroll"
                      : t === "edit"
                      ? "Edit existing text"
                      : t === "ink"
                      ? "Pencil"
                      : `Add ${t}`
                  }
                >
                  {t === "select"
                    ? "↕"
                    : t === "edit"
                    ? "✎"
                    : t === "text"
                    ? "T"
                    : t === "highlight"
                    ? "▒"
                    : "⌇"}
                </button>
              ))}
            </div>
            <div className="swatches">
              {COLORS.map((c) => (
                <button
                  key={c.label}
                  className={"swatch" + (color === c.rgb ? " on" : "")}
                  style={{
                    background: `rgb(${c.rgb.r * 255},${c.rgb.g * 255},${c.rgb.b * 255})`,
                  }}
                  title={c.label}
                  aria-label={`Set ${c.label} annotation color`}
                  onClick={() => setColor(c.rgb)}
                />
              ))}
              <select
                className="pdf-size"
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
                title="Text size"
              >
                {[8, 10, 12, 14, 18, 24, 32].map((s) => (
                  <option key={s} value={s}>
                    {s}px
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <div className="spacer" />
        <button className="icon-btn" onClick={() => zoomTo(scaleRef.current - 0.2)} title="Zoom out">
          −
        </button>
        <span className="pdf-zoom">{Math.round(scale * 100)}%</span>
        <button className="icon-btn" onClick={() => zoomTo(scaleRef.current + 0.2)} title="Zoom in">
          +
        </button>
        {mode === "edit" ? (
          <>
            <button className="icon-btn" onClick={undo} disabled={!canUndo} title="Undo">
              ↶
            </button>
            <button className="icon-btn" onClick={redo} disabled={!canRedo} title="Redo">
              ↷
            </button>
            <button
              className="btn ghost"
              onClick={() =>
                void apply(
                  async (current) => {
                    const { addBlankPage } = await loadPdfEditModule();
                    return addBlankPage(current);
                  },
                  { structural: true }
                )
              }
              disabled={!bytes}
              title="Append a blank US-Letter page"
            >
              + Page
            </button>
            {fields.length > 0 && (
              <button className="btn ghost" onClick={() => setShowForm((v) => !v)}>
                Form ({fields.length})
              </button>
            )}
            <button className="btn primary" onClick={() => void save()} disabled={!dirty}>
              {dirty ? "Save" : "Saved"}
            </button>
            <button
              className="btn"
              onClick={() => {
                setTool("select");
                setShowForm(false);
                setMode("view");
              }}
              title="Back to read-only viewing"
            >
              Done
            </button>
          </>
        ) : (
          !loadFailed && (
            <button
              className="btn primary"
              onClick={() => setMode("edit")}
              title="Annotate, highlight, fill forms, reorder pages"
            >
              Edit PDF
            </button>
          )
        )}
      </div>

      {status && !loadFailed && <div className="pdf-status">{status}</div>}

      <div className="pdf-body" ref={bodyRef}>
        <div
          className={"pdf-pages tool-" + tool + (mode === "view" ? " native-view" : "")}
          ref={bindPages}
        >
          {loadFailed ? (
            <div className="pdf-error">
              <div className="pdf-error-title">Couldn't open this PDF</div>
              <div className="pdf-error-msg">
                {bytes
                  ? `This file looks like ${sniffFileType(bytes)} — not a PDF. It may be corrupted, mislabeled with a .pdf name, or an error page that was saved instead of the real document. Try re-downloading the original.`
                  : status || "It doesn't look like a valid PDF file."}
              </div>
            </div>
          ) : renderError && bytes && invalidPdfType ? (
            <div className="pdf-error">
              <div className="pdf-error-title">Couldn't render this PDF</div>
              <div className="pdf-error-msg">
                {`This file looks like ${invalidPdfType} — not a valid PDF. It may be corrupted, empty, mislabeled with a .pdf name, or an error page that was saved instead of the real document.`}
              </div>
            </div>
          ) : renderError && bytes ? (
            nativeFrameReady ? (
              <iframe className="media-pdf" src={nativePdfUrl ?? undefined} title={file.name} />
            ) : (
              <div className="pdf-error" role={nativeAdmission?.error ? "alert" : "status"}>
                {nativeAdmission?.url === nativePdfUrl && nativeAdmission.error
                  ? nativeAdmission.error : "Preparing PDF fallback…"}
              </div>
            )
          ) : (
            <>
              {nativeCoverVisible && (
                <iframe
                  className="media-pdf pdf-native-first-paint"
                  data-testid="pdf-native-first-paint"
                  src={nativePdfUrl ?? undefined}
                  title={file.name}
                  onLoad={() => markPdfPerf(perfRunId, "native-iframe-loaded")}
                />
              )}
              <div
                className={
                  "pdf-pages-inner" + (nativeCoverVisible ? " warming" : "")
                }
                data-testid="pdf-pages"
                ref={bindPagesInner}
                aria-hidden={nativeCoverVisible ? true : undefined}
              >
                {Array.from({ length: shellCount }, (_, i) => (
                  <div className="pdf-page-wrap" key={i} data-page-index={i}>
                    <div className="pdf-page-tools">
                      {mode === "edit" && (
                        <>
                          <button className="icon-btn" title="Rotate left" onClick={() => void apply(async (current) => {
                            const { rotatePage } = await loadPdfEditModule();
                            return rotatePage(current, i, -90);
                          }, { structural: true })}>↺</button>
                          <button className="icon-btn" title="Rotate right" onClick={() => void apply(async (current) => {
                            const { rotatePage } = await loadPdfEditModule();
                            return rotatePage(current, i, 90);
                          }, { structural: true })}>↻</button>
                          <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => void apply(async (current) => {
                            const { movePage } = await loadPdfEditModule();
                            return movePage(current, i, i - 1);
                          }, { structural: true })}>↑</button>
                          <button className="icon-btn" title="Move down" disabled={i === pageCount - 1} onClick={() => void apply(async (current) => {
                            const { movePage } = await loadPdfEditModule();
                            return movePage(current, i, i + 1);
                          }, { structural: true })}>↓</button>
                          <button className="icon-btn danger" title="Delete page" disabled={pageCount <= 1} onClick={() => void apply(async (current) => {
                            const { deletePage } = await loadPdfEditModule();
                            return deletePage(current, i);
                          }, { structural: true })}>×</button>
                        </>
                      )}
                      <span className="pdf-page-no">{i + 1}</span>
                    </div>
                    <div className="pdf-canvas-host">
                      <canvas
                        ref={bindCanvas(i)}
                        className="pdf-canvas"
                        data-testid="pdf-page-canvas"
                        data-page-number={i + 1}
                        // The CSS box comes from the page's measured size, not
                        // from its bitmap, so a page that has not been painted
                        // (or whose pixels were released) still occupies exactly
                        // the space it will occupy once painted. Without this the
                        // scroll height changes under the reader as pages paint.
                        style={pageBox(i) ?? undefined}
                        onClick={(e) => onPageClick(i, e)}
                        onPointerDown={(e) => onDown(i, e)}
                        onPointerMove={(e) => onMove(i, e)}
                        onPointerUp={(e) => onUp(i, e)}
                        onPointerCancel={(e) => onUp(i, e)}
                      />
                      {inkDraft && inkDraft.page === i && inkDraft.points.length > 1 && (
                        <svg className="pdf-ink-draft">
                          <polyline
                            points={inkDraft.points
                              .map((point) => `${point.x},${point.y}`)
                              .join(" ")}
                            style={{
                              stroke: `rgb(${color.r * 255},${color.g * 255},${color.b * 255})`,
                              strokeWidth,
                            }}
                          />
                        </svg>
                      )}
                      {dragBox && dragBox.page === i && (
                        <div
                          className="pdf-dragbox"
                          style={{
                            left: Math.min(dragBox.left, dragBox.left + dragBox.w),
                            top: Math.min(dragBox.top, dragBox.top + dragBox.h),
                            width: Math.abs(dragBox.w),
                            height: Math.abs(dragBox.h),
                          }}
                        />
                      )}
                      {pending && pending.page === i && (
                        <input
                          autoFocus
                          className="pdf-text-input"
                          style={{ left: pending.left, top: pending.top }}
                          value={pendingValue}
                          placeholder="type, Enter to place"
                          onChange={(e) => setPendingValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitText();
                            if (e.key === "Escape") setPending(null);
                          }}
                          onBlur={commitText}
                        />
                      )}
                      {mode === "edit" &&
                        tool === "edit" &&
                        (textRunsByPage.get(i) ?? [])
                          .map((run, idx) => (
                            <button
                              key={`${run.left}:${run.top}:${idx}`}
                              className="pdf-text-hit"
                              style={{
                                left: run.left,
                                top: run.top,
                                width: run.width,
                                height: run.height,
                              }}
                              title={`Edit "${run.text.trim()}"`}
                              onClick={(e) => {
                                e.stopPropagation();
                                startReplace(run);
                              }}
                            />
                          ))}
                      {replacePending && replacePending.run.page === i && (
                        <input
                          autoFocus
                          className="pdf-replace-input"
                          style={{
                            left: replacePending.left,
                            top: replacePending.top,
                            width: Math.max(140, replacePending.run.width),
                          }}
                          value={replaceValue}
                          onChange={(e) => setReplaceValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitReplace();
                            if (e.key === "Escape") setReplacePending(null);
                          }}
                          onBlur={commitReplace}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {showForm && fields.length > 0 && (
          <div className="pdf-form-panel">
            <div className="pdf-form-title">Form fields</div>
            {fields.map((f) => (
              <label className="pdf-form-row" key={f.name}>
                <span className="pdf-form-name">{f.name}</span>
                {f.type === "checkbox" ? (
                  <input
                    type="checkbox"
                    checked={f.value === "true"}
                    onChange={(e) =>
                      void apply(
                        async (current) => {
                          const { setFormField } = await loadPdfEditModule();
                          return setFormField(
                            current,
                            f.name,
                            e.target.checked ? "true" : "false"
                          );
                        }
                      )
                    }
                  />
                ) : f.options ? (
                  <select
                    className="text-input"
                    value={f.value}
                    onChange={(e) =>
                      void apply(async (current) => {
                        const { setFormField } = await loadPdfEditModule();
                        return setFormField(current, f.name, e.target.value);
                      })
                    }
                  >
                    {f.options.map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="text-input"
                    defaultValue={f.value}
                    onBlur={(e) => {
                      if (e.target.value !== f.value)
                        void apply(async (current) => {
                          const { setFormField } = await loadPdfEditModule();
                          return setFormField(current, f.name, e.target.value);
                        });
                    }}
                  />
                )}
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
