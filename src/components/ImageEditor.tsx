import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { getStore } from "../store";
import { confirmAction } from "../lib/confirmAction";
import { DocumentChangedOnDiskError, readDocumentBytes, saveDocumentBytes } from "../lib/documentBytesSave";
import { duplicateRelPath, safeBaseName, splitRelPath } from "../lib/fsnames";
import { planImageOps, proportionalSize, type ImageOp, type ImagePlan } from "../lib/imageEditOps";
import {
  formatForExt, imageEditRefusal, imageOverwriteWarning, inspectImage, mimeForFormat,
  type EditableImageFormat, type ImageInfo,
} from "../lib/imageInspect";
import { pdfBytesEqual } from "../lib/pdfBytes";
import { writeVaultBinaryFile } from "../lib/vault";
import type { VaultFile } from "../types";
import { decodeImage, drawImagePlan, encodeCanvas } from "./imageCanvas";
import { SAVE_WAIT, useSaveLock } from "./useSaveLock";

const PREVIEW_MAX_SIDE = 1600;

interface Loaded {
  bytes: Uint8Array;
  info: ImageInfo;
  format: EditableImageFormat;
  image: HTMLImageElement;
}
type Rect = { x: number; y: number; width: number; height: number };

/** Rotate, flip, crop and resize PNG, JPEG and WebP images. Edits are an
 *  operation list over the original pixels until a confirmed Save
 *  (verified, against the opened bytes) or Save as copy (new file only). */
export function ImageEditor({ file, onDirtyChange, onDone }: {
  file: VaultFile;
  onDirtyChange: (dirty: boolean) => void;
  onDone: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [ops, setOps] = useState<ImageOp[]>([]);
  const [redo, setRedo] = useState<ImageOp[]>([]);
  const [copiedOps, setCopiedOps] = useState<ImageOp[] | null>(null);
  const [status, setStatus] = useState("");
  const [busy, busyRef, setBusy] = useSaveLock();
  const [crop, setCrop] = useState<Rect | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0, keep: true });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const loadedRef = useRef<Loaded | null>(null);
  const dirty = ops.length > 0 && ops !== copiedOps;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const adopt = useCallback(async (bytes: Uint8Array) => {
    const info = inspectImage(bytes);
    const reason = imageEditRefusal(file.ext, info);
    const format = formatForExt(file.ext);
    if (reason || !format) {
      setRefusal(reason ?? "This image cannot be edited.");
      return;
    }
    const image = await decodeImage(bytes, mimeForFormat(format));
    const next = { bytes, info, format, image };
    loadedRef.current = next;
    setLoaded(next);
    setOps([]);
    setRedo([]);
    setCopiedOps(null);
    setCrop(null);
  }, [file.ext]);

  // Load on open; later mtime changes reload only a clean editor.
  const openedPathRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const first = openedPathRef.current !== file.path;
    openedPathRef.current = file.path;
    void readDocumentBytes(file.path).then(async (bytes) => {
      if (cancelled) return;
      const current = loadedRef.current;
      if (!first && current) {
        if (pdfBytesEqual(bytes, current.bytes)) return;
        if (dirtyRef.current) {
          setStatus("This image changed on disk. Your edits are still here; Save is blocked, but Save as copy works.");
          return;
        }
        setStatus("Reloaded: this image changed on disk.");
      }
      await adopt(bytes);
    }).catch((error) => {
      if (cancelled) return;
      // Only a first open refuses; a failed reload keeps the editor and its edits.
      if (!first && loadedRef.current) setStatus(`Could not reload this image: ${String(error)}. Your edits are still here.`);
      else setRefusal(`Could not open this image: ${String(error)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [file.path, file.mtime, adopt]);

  const plan: ImagePlan | null = useMemo(() => {
    if (!loaded) return null;
    return planImageOps(loaded.image.naturalWidth, loaded.image.naturalHeight, ops);
  }, [loaded, ops]);
  const previewScale = plan ? Math.min(1, PREVIEW_MAX_SIDE / Math.max(plan.width, plan.height)) : 1;

  useEffect(() => {
    if (!plan || !loaded || !canvasRef.current) return;
    drawImagePlan(canvasRef.current, loaded.image, plan, previewScale);
    setSize((s) => ({ ...s, width: plan.width, height: plan.height }));
  }, [plan, loaded, previewScale]);

  const push = (op: ImageOp) => {
    if (!plan) return;
    if (busyRef.current) { setStatus(SAVE_WAIT); return; }
    try {
      planImageOps(plan.width, plan.height, [op]);
    } catch (error) {
      setStatus(String(error instanceof Error ? error.message : error));
      return;
    }
    setOps((list) => [...list, op]);
    setRedo([]);
    setCrop(null);
    setStatus("");
  };
  const undo = () => {
    if (!ops.length || busyRef.current) return;
    setRedo((r) => [...r, ops[ops.length - 1]]);
    setOps(ops.slice(0, -1));
    setCrop(null);
  };
  const redoOne = () => {
    if (!redo.length || busyRef.current) return;
    setOps([...ops, redo[redo.length - 1]]);
    setRedo(redo.slice(0, -1));
  };

  const render = (format: EditableImageFormat): Promise<Uint8Array> => {
    if (!loaded || !plan) return Promise.reject(new Error("The image is not loaded."));
    const canvas = document.createElement("canvas");
    drawImagePlan(canvas, loaded.image, plan);
    return encodeCanvas(canvas, format);
  };

  const save = async () => {
    if (!loaded || !dirty || busy) return;
    const ok = await confirmAction(imageOverwriteWarning(file.name, loaded.info), {
      title: "Save over the original?", okLabel: "Save over original", cancelLabel: "Cancel", kind: "warning",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const bytes = await render(loaded.format);
      await saveDocumentBytes({ path: file.path, bytes, expected: loaded.bytes, kind: "image",
        validate: (candidate) => { if (inspectImage(candidate).format !== loaded.format) throw new Error("wrong format"); } });
      await adopt(bytes);
      setStatus("Saved.");
    } catch (error) {
      setStatus(error instanceof DocumentChangedOnDiskError ? error.message : `Save failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveCopy = async () => {
    if (!loaded || !ops.length || busy) return;
    const root = getStore().vaultPath;
    if (!root) return;
    setBusy(true);
    try {
      let format = loaded.format;
      let bytes: Uint8Array;
      try {
        bytes = await render(format);
      } catch (error) {
        if (format === "png") throw error;
        format = "png";
        bytes = await render(format);
      }
      const { dir, base } = splitRelPath(file.relPath);
      const name = safeBaseName(base) || "image";
      const ext = format === loaded.format ? file.ext : "png";
      const wanted = `${dir}${name}.${ext}`;
      const rel = duplicateRelPath(getStore().files.map((f) => f.relPath), wanted);
      await writeVaultBinaryFile(root, rel, bytes, { expectedMissing: true });
      if (getStore().vaultPath !== root) return;
      await getStore().registerVaultFile(rel);
      setCopiedOps(ops);
      setStatus(`Saved a copy as ${rel}${format !== loaded.format ? " (PNG: this system cannot write the original format)" : ""}.`);
    } catch (error) {
      setStatus(error instanceof DocumentChangedOnDiskError ? error.message : `Save as copy failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const done = async () => {
    if (dirty && !(await confirmAction(`${file.name} has unsaved image edits. Closing the editor discards them.`, {
      title: "Discard image edits?", okLabel: "Discard edits", cancelLabel: "Keep editing", kind: "warning",
    }))) return;
    onDone();
  };

  const toImage = (event: PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const scale = plan && box.width ? plan.width / box.width : 1;
    const clampX = (v: number) => Math.max(0, Math.min(plan?.width ?? 0, Math.round(v)));
    const clampY = (v: number) => Math.max(0, Math.min(plan?.height ?? 0, Math.round(v)));
    return { x: clampX((event.clientX - box.left) * scale), y: clampY((event.clientY - box.top) * scale) };
  };
  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = toImage(event);
    setCrop(null);
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const start = dragRef.current;
    if (!start) return;
    const end = toImage(event);
    const rect = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
    setCrop(rect.width && rect.height ? rect : null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z" && event.key.toLowerCase() !== "y") return;
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    event.preventDefault();
    if (event.shiftKey || event.key.toLowerCase() === "y") redoOne();
    else undo();
  };

  if (refusal) {
    return (
      <div className="image-editor" data-testid="image-editor">
        <div className="pdf-toolbar"><span className="spacer" /><button className="btn" onClick={onDone}>Done</button></div>
        <div className="editor-empty" role="alert">{refusal}</div>
      </div>
    );
  }
  const setNumber = (key: keyof Rect, value: string) => {
    if (!plan) return;
    const base = crop ?? { x: 0, y: 0, width: plan.width, height: plan.height };
    setCrop({ ...base, [key]: Math.max(0, Math.round(Number(value) || 0)) });
  };
  const setWidth = (value: string) => {
    const width = Math.max(1, Math.round(Number(value) || 1));
    setSize((s) => ({ ...s, width, height: s.keep && plan ? proportionalSize(plan.width, plan.height, width) : s.height }));
  };
  const scaleCss = plan ? 100 / plan.width : 0;

  return (
    <div className="image-editor" data-testid="image-editor" onKeyDown={onKeyDown}>
      <div className="pdf-toolbar" role="toolbar" aria-label="Image editing">
        <button className="btn ghost" disabled={!plan || busy} onClick={() => push({ kind: "rotate", turns: -1 })}>Rotate left</button>
        <button className="btn ghost" disabled={!plan || busy} onClick={() => push({ kind: "rotate", turns: 1 })}>Rotate right</button>
        <button className="btn ghost" disabled={!plan || busy} onClick={() => push({ kind: "flip", axis: "h" })}>Flip horizontal</button>
        <button className="btn ghost" disabled={!plan || busy} onClick={() => push({ kind: "flip", axis: "v" })}>Flip vertical</button>
        <button className="btn ghost" disabled={!ops.length || busy} onClick={undo}>Undo</button>
        <button className="btn ghost" disabled={!redo.length || busy} onClick={redoOne}>Redo</button>
        <span className="spacer" />
        <button className="btn" disabled={!ops.length || busy} onClick={() => void saveCopy()}>Save as copy</button>
        <button className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>Save</button>
        <button className="btn" onClick={() => void done()}>Done</button>
      </div>
      {plan && (
        <div className="pdf-toolbar image-editor-fields">
          <fieldset className="image-editor-group">
            <legend>Crop (drag on the image)</legend>
            {(["x", "y", "width", "height"] as const).map((key) => (
              <label key={key}>{key === "width" ? "W" : key === "height" ? "H" : key.toUpperCase()}
                <input type="number" min={key === "x" || key === "y" ? 0 : 1} value={crop ? crop[key] : key === "width" ? plan.width : key === "height" ? plan.height : 0}
                  onChange={(e) => setNumber(key, e.target.value)} />
              </label>
            ))}
            <button className="btn ghost" disabled={!crop || busy} onClick={() => crop && push({ kind: "crop", ...crop })}>Apply crop</button>
          </fieldset>
          <fieldset className="image-editor-group">
            <legend>Resize</legend>
            <label>W<input type="number" min={1} value={size.width} onChange={(e) => setWidth(e.target.value)} /></label>
            <label>H<input type="number" min={1} value={size.height} disabled={size.keep} onChange={(e) => setSize((s) => ({ ...s, height: Math.max(1, Math.round(Number(e.target.value) || 1)) }))} /></label>
            <label><input type="checkbox" checked={size.keep} onChange={(e) => setSize((s) => ({ ...s, keep: e.target.checked }))} />Keep ratio</label>
            <button className="btn ghost" disabled={busy || (size.width === plan.width && size.height === plan.height)} onClick={() => push({ kind: "resize", width: size.width, height: size.height })}>Apply resize</button>
          </fieldset>
          <span className="image-editor-size">{plan.width} × {plan.height} px</span>
        </div>
      )}
      {status && <div className="pdf-status" role="status">{status}</div>}
      <div className="image-editor-stage">
        {!plan && <div className="editor-empty">Loading image…</div>}
        <div className="image-editor-frame" hidden={!plan}>
          <canvas ref={canvasRef} className="image-editor-canvas" aria-label={`${file.name}, edited preview`}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { dragRef.current = null; }} />
          {crop && plan && (
            <div className="image-editor-crop" style={{ left: `${crop.x * scaleCss}%`, top: `${(crop.y * 100) / plan.height}%`, width: `${crop.width * scaleCss}%`, height: `${(crop.height * 100) / plan.height}%` }} />
          )}
        </div>
      </div>
    </div>
  );
}
