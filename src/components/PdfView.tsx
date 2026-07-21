import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useAppStore } from "../store";
import {
  claimKeyboardShortcut,
  isTextEntryTarget,
  undoRedoShortcutAction,
} from "../lib/shortcuts";
import { urlForPath, restoreLatestAgentSnapshot } from "../lib/vault";
import { usePdfEditor } from "./usePdfEditor";
import {
  rotatePage,
  deletePage,
  movePage,
  addText,
  replaceText,
  addHighlight,
  addInkStroke,
  addBlankPage,
  setFormField,
  sniffFileType,
  sanitizePdfBytes,
  type InkPoint,
  type RGB,
} from "../lib/pdf";
import type { PdfTextRun } from "./usePdfEditor";

type Tool = "select" | "edit" | "text" | "highlight" | "ink";

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

export function PdfView({ rel }: { rel: string }) {
  const fileFor = useAppStore((s) => s.fileFor);
  const file = fileFor(rel);
  // Subscribe to the file's mtime (updated by the vault watcher) so the viewer
  // re-checks the disk bytes when another tool rewrites this PDF. The store
  // mutates the VaultFile in place, so the primitive mtime is the reliable
  // subscription target — object identity does not change.
  const fileMtime = useAppStore(
    (s) => s.files.find((f) => f.relPath === rel)?.mtime
  );
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
    renderedPages,
    canUndo,
    canRedo,
    viewports,
    canvasRefs,
    bindCanvas,
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

  const [color, setColor] = useState<RGB>(COLORS[0].rgb);
  const [size, setSize] = useState(14);
  const [showForm, setShowForm] = useState(false);
  const [pending, setPending] = useState<PendingText | null>(null);
  const [pendingValue, setPendingValue] = useState("");
  const [replacePending, setReplacePending] = useState<PendingReplace | null>(null);
  const [replaceValue, setReplaceValue] = useState("");
  const drag = useRef<{ page: number; x0: number; y0: number } | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const pagesInnerRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(scale);
  const zoomAnchorRef = useRef<{
    x: number;
    y: number;
    prevRect: DOMRect;
  } | null>(null);
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
  // When pdf.js cannot render, fall back to the native embed fed from the
  // bytes already verified in memory — not a fresh disk path load — so the
  // fallback always shows exactly the document Mesa has open (including
  // unsaved edits) and cannot diverge from it.
  const renderFallbackUrl = useMemo(() => {
    if (!renderError || !bytes) return null;
    const data = new Uint8Array(bytes).buffer;
    return URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
  }, [bytes, renderError]);
  const invalidPdfType = useMemo(() => {
    if (!bytes) return null;
    try {
      sanitizePdfBytes(bytes);
      return null;
    } catch {
      return sniffFileType(bytes);
    }
  }, [bytes]);
  // Recovery from a corrupting write made outside Mesa's own save path — most
  // commonly the embedded Pi agent's own read/write/edit tools, which touch
  // disk directly and bypass persistVerifiedBytes entirely (see
  // src/lib/agentBackup.ts). Mesa takes a defensive snapshot before every Pi
  // write/edit tool call; this offers to restore the newest one whenever the
  // file Mesa has open turns out not to be a valid PDF.
  const [snapshotStatus, setSnapshotStatus] = useState<string | null>(null);
  const restoreSnapshot = async () => {
    if (!file) return;
    setSnapshotStatus("Looking for a Pi-write safety snapshot…");
    try {
      const restored = await restoreLatestAgentSnapshot(file.path);
      setSnapshotStatus(
        restored
          ? "Restored the version from before the last Pi agent write. Reloading…"
          : "No safety snapshot found for this file."
      );
    } catch (e) {
      setSnapshotStatus(`Restore failed: ${String(e)}`);
    }
  };
  const zoomFactor = renderScale > 0 ? scale / renderScale : 1;
  const firstPagePainted = renderedPages.has(0);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);
  // The webview's native PDF renderer streams straight from disk via the asset
  // protocol, so it can show the real document immediately — it must not wait
  // for the editor's full byte read to finish.
  const showNativeFirstPaint = !loadFailed && !renderError && !firstPagePainted;

  useEffect(() => {
    return () => {
      if (renderFallbackUrl) URL.revokeObjectURL(renderFallbackUrl);
    };
  }, [renderFallbackUrl]);

  const bodyRef = useRef<HTMLDivElement | null>(null);

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

  const zoomTo = useCallback(
    (nextScale: number, anchor?: { x: number; y: number }) => {
      const clamped = Math.min(3, Math.max(0.5, nextScale));
      const pagesEl = pagesRef.current;
      const innerEl = pagesInnerRef.current;
      const viewport = pagesEl?.getBoundingClientRect();
      const focus =
        anchor && viewport &&
        anchor.x >= viewport.left &&
        anchor.x <= viewport.right &&
        anchor.y >= viewport.top &&
        anchor.y <= viewport.bottom
          ? anchor
          : viewport
          ? { x: viewport.left + viewport.width / 2, y: viewport.top + viewport.height / 2 }
          : null;
      if (pagesEl && innerEl && focus) {
        const prevRect = innerEl.getBoundingClientRect();
        if (prevRect.width > 0 && prevRect.height > 0) {
          zoomAnchorRef.current = { x: focus.x, y: focus.y, prevRect };
        } else {
          zoomAnchorRef.current = null;
        }
      } else {
        zoomAnchorRef.current = null;
      }
      scaleRef.current = clamped;
      setScale(clamped);
    },
    [setScale]
  );

  useLayoutEffect(() => {
    const pending = zoomAnchorRef.current;
    if (!pending) return;
    const pagesEl = pagesRef.current;
    const innerEl = pagesInnerRef.current;
    if (!pagesEl || !innerEl) {
      zoomAnchorRef.current = null;
      return;
    }
    const nextRect = innerEl.getBoundingClientRect();
    if (nextRect.width <= 0 || nextRect.height <= 0) {
      zoomAnchorRef.current = null;
      return;
    }
    const fx = (pending.x - pending.prevRect.left) / pending.prevRect.width;
    const fy = (pending.y - pending.prevRect.top) / pending.prevRect.height;
    const targetX = nextRect.left + fx * nextRect.width;
    const targetY = nextRect.top + fy * nextRect.height;
    pagesEl.scrollLeft += targetX - pending.x;
    pagesEl.scrollTop += targetY - pending.y;
    zoomAnchorRef.current = null;
  }, [scale]);

  // Trackpad pinch-to-zoom: a pinch gesture arrives as a wheel event with
  // ctrlKey set. Handle it non-passively so we can preventDefault (otherwise the
  // browser zooms the whole page) and drive the PDF scale instead.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // ordinary scroll → let it through
      e.preventDefault();
      zoomTo(scaleRef.current - e.deltaY * 0.01, { x: e.clientX, y: e.clientY });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo]);

  if (!file) return <div className="editor-empty">File not found.</div>;

  // map a pointer event on a page canvas to that page's PDF coordinates
  const toPdf = (pageIdx: number, e: React.PointerEvent | React.MouseEvent) => {
    const canvas = canvasRefs.current.get(pageIdx);
    const vp = viewports.current.get(pageIdx);
    if (!canvas || !vp) return null;
    const rect = canvas.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) * canvas.width) / rect.width;
    const vy = ((e.clientY - rect.top) * canvas.height) / rect.height;
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
      (current) => addText(current, {
        page: pending.page,
        x: pending.pdfX,
        y: pending.pdfY,
        text: pendingValue,
        size,
        color,
      }),
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
      (current) => replaceText(current, {
        page: run.page,
        x: run.pdfX,
        y: run.pdfY,
        width: run.pdfWidth,
        height: run.pdfHeight,
        text: next,
        size: Math.max(8, Math.min(64, run.pdfHeight * 0.82)),
        color,
      }),
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
      setInkDraft({ page: pageIdx, points: [...ink.current.cssPoints] });
      return;
    }
    if (!drag.current || drag.current.page !== pageIdx) return;
    const canvas = canvasRefs.current.get(pageIdx);
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    setDragBox((b) =>
      b
        ? {
            ...b,
            w: ((e.clientX - rect.left) * canvas.width) / rect.width - b.left,
            h: ((e.clientY - rect.top) * canvas.height) / rect.height - b.top,
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
      setInkDraft(null);
      if (stroke.points.length < 1) return;
      void apply(
        (current) => addInkStroke(current, {
          page: pageIdx,
          points: stroke.points,
          thickness: strokeWidth,
          color,
        }),
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
      (current) => addHighlight(current, { page: pageIdx, x, y, width: w, height: h, color }),
      { pages: [pageIdx] }
    );
  };

  return (
    <div
      className="pdf-editor"
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
              onClick={() => void apply((current) => addBlankPage(current), { structural: true })}
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
          ref={pagesRef}
        >
          {loadFailed ? (
            <div className="pdf-error">
              <div className="pdf-error-title">Couldn't open this PDF</div>
              <div className="pdf-error-msg">
                {bytes
                  ? `This file looks like ${sniffFileType(bytes)} — not a PDF. It may be corrupted, mislabeled with a .pdf name, or an error page that was saved instead of the real document. Try re-downloading the original.`
                  : status || "It doesn't look like a valid PDF file."}
              </div>
              <div className="pdf-error-actions">
                <button className="btn ghost" onClick={() => void restoreSnapshot()}>
                  Restore previous version
                </button>
              </div>
              {snapshotStatus && <div className="pdf-error-msg">{snapshotStatus}</div>}
            </div>
          ) : renderError && bytes && invalidPdfType ? (
            <div className="pdf-error">
              <div className="pdf-error-title">Couldn't render this PDF</div>
              <div className="pdf-error-msg">
                {`This file looks like ${invalidPdfType} — not a valid PDF. It may be corrupted, empty, mislabeled with a .pdf name, or an error page that was saved instead of the real document.`}
              </div>
              <div className="pdf-error-actions">
                <button className="btn ghost" onClick={() => void restoreSnapshot()}>
                  Restore previous version
                </button>
              </div>
              {snapshotStatus && <div className="pdf-error-msg">{snapshotStatus}</div>}
            </div>
          ) : renderError && bytes ? (
            <iframe
              className="media-pdf"
              src={renderFallbackUrl ?? urlForPath(file.path)}
              title={file.name}
            />
          ) : (
            <>
              {showNativeFirstPaint && (
                <iframe
                  className="media-pdf pdf-native-first-paint"
                  src={urlForPath(file.path)}
                  title={file.name}
                />
              )}
              <div
                className={
                  "pdf-pages-inner" + (showNativeFirstPaint ? " warming" : "")
                }
                ref={pagesInnerRef}
                style={{ "--pdf-zoom": zoomFactor } as CSSProperties}
                aria-hidden={showNativeFirstPaint ? true : undefined}
              >
                {Array.from({ length: pageCount }, (_, i) => (
                  <div className="pdf-page-wrap" key={i}>
                    <div className="pdf-page-tools">
                      {mode === "edit" && (
                        <>
                          <button className="icon-btn" title="Rotate left" onClick={() => void apply((current) => rotatePage(current, i, -90), { structural: true })}>↺</button>
                          <button className="icon-btn" title="Rotate right" onClick={() => void apply((current) => rotatePage(current, i, 90), { structural: true })}>↻</button>
                          <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => void apply((current) => movePage(current, i, i - 1), { structural: true })}>↑</button>
                          <button className="icon-btn" title="Move down" disabled={i === pageCount - 1} onClick={() => void apply((current) => movePage(current, i, i + 1), { structural: true })}>↓</button>
                          <button className="icon-btn danger" title="Delete page" disabled={pageCount <= 1} onClick={() => void apply((current) => deletePage(current, i), { structural: true })}>×</button>
                        </>
                      )}
                      <span className="pdf-page-no">{i + 1}</span>
                    </div>
                    <div className="pdf-canvas-host">
                      <canvas
                        ref={bindCanvas(i)}
                        className="pdf-canvas"
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
                        textRuns
                          .filter((run) => run.page === i)
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
                        (current) =>
                          setFormField(
                            current,
                            f.name,
                            e.target.checked ? "true" : "false"
                          )
                      )
                    }
                  />
                ) : f.options ? (
                  <select
                    className="text-input"
                    value={f.value}
                    onChange={(e) =>
                      void apply((current) => setFormField(current, f.name, e.target.value))
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
                        void apply((current) =>
                          setFormField(current, f.name, e.target.value)
                        );
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
