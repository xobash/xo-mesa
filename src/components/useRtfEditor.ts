import { useCallback, useEffect, useRef, useState } from "react";
import { DocumentChangedOnDiskError, readDocumentBytes, saveDocumentBytes } from "../lib/documentBytesSave";
import { pdfBytesEqual } from "../lib/pdfBytes";
import { confirmAction } from "../lib/confirmAction";
import { parseRtfDocument, rtfBytesFromSource, rtfSourceFromBytes, sameFormat, type RtfDocument, type RtfFormat } from "../lib/rtfDocument";
import { buildRtfEdit, rtfContentChanged } from "../lib/rtfEdit";
import { applyRtfFormat, insertPlainText, paragraphsOf, readRtf, renderRtf, selectedFormats, unitsOf, type RtfParagraph } from "./rtfDom";
import { formatBytes } from "../lib/formatBytes";
import { SAVE_WAIT, useSaveLock } from "./useSaveLock";

/** Larger files open as text only; the editor renders every paragraph. */
const RTF_EDIT_LIMIT_BYTES = 8 * 1024 * 1024;
const HISTORY_LIMIT = 100;
const SNAPSHOT_DELAY_MS = 400;

export type RtfLoad =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; doc: RtfDocument };

export interface RtfEditorFile {
  path: string;
  mtime?: number;
}

/** Load, edit, undo and verified save for one RTF file. */
export function useRtfEditor(file: RtfEditorFile | undefined, onDirtyChange?: (dirty: boolean) => void, onSaved?: (bytes: Uint8Array, path: string) => void) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [load, setLoad] = useState<RtfLoad>({ state: "loading" });
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [saving, savingRef, setSaving] = useSaveLock();
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const docRef = useRef<RtfDocument | null>(null);
  const baselineRef = useRef<Uint8Array | null>(null);
  const pathRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const currentRef = useRef<RtfParagraph[] | null>(null);
  const undoRef = useRef<RtfParagraph[][]>([]);
  const redoRef = useRef<RtfParagraph[][]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const path = file?.path;
  const mtime = file?.mtime;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const markDirty = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirty(next);
  }, []);

  const syncHistory = useCallback(() => setHistory({ undo: undoRef.current.length, redo: redoRef.current.length }), []);

  /** Show a document and reset its edit state. */
  const adopt = useCallback((bytes: Uint8Array) => {
    const doc = parseRtfDocument(rtfSourceFromBytes(bytes));
    docRef.current = doc;
    baselineRef.current = bytes;
    currentRef.current = paragraphsOf(doc);
    undoRef.current = [];
    redoRef.current = [];
    syncHistory();
    markDirty(false);
    setLoad({ state: "ready", doc });
  }, [markDirty, syncHistory]);

  // Paint the document whenever a new one is adopted.
  useEffect(() => {
    const root = rootRef.current;
    if (load.state !== "ready" || !root || !currentRef.current) return;
    renderRtf(root, load.doc, currentRef.current);
  }, [load]);

  const loadedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!path) return;
    const isNew = loadedPathRef.current !== path;
    loadedPathRef.current = path;
    pathRef.current = path;
    let cancelled = false;
    if (isNew) {
      setLoad({ state: "loading" });
      setStatus("");
      markDirty(false);
    }
    void readDocumentBytes(path).then((bytes) => {
      if (cancelled || pathRef.current !== path) return;
      if (isNew || !baselineRef.current) {
        if (bytes.length > RTF_EDIT_LIMIT_BYTES) {
          setLoad({ state: "failed", message: `This RTF file is larger than ${formatBytes(RTF_EDIT_LIMIT_BYTES)}, so Mesa does not open it in the editor.` });
          return;
        }
        adopt(bytes);
        return;
      }
      if (pdfBytesEqual(bytes, baselineRef.current)) return; // our own save echo
      if (dirtyRef.current) {
        setStatus("This RTF file changed on disk. Your unsaved edits are still here; Save is blocked until you discard them to load the newer version.");
        return;
      }
      if (bytes.length > RTF_EDIT_LIMIT_BYTES) return;
      adopt(bytes);
      setStatus("Reloaded: this RTF file changed on disk.");
    }, (error) => {
      if (cancelled || !isNew) return;
      setLoad({ state: "failed", message: `Could not open this RTF file: ${String(error)}` });
    });
    return () => {
      cancelled = true;
    };
  }, [path, mtime, adopt, markDirty]);

  /** Record the DOM as the current snapshot; the previous one becomes undoable. */
  const snapshot = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const root = rootRef.current;
    const doc = docRef.current;
    if (!root || !doc || doc.readOnlyReason) return;
    const next = readRtf(root, doc);
    const previous = currentRef.current;
    if (previous && sameParagraphs(previous, next)) return;
    if (previous) undoRef.current = [...undoRef.current.slice(1 - HISTORY_LIMIT), previous];
    redoRef.current = [];
    currentRef.current = next;
    syncHistory();
    markDirty(rtfContentChanged(doc, unitsOf(next)));
  }, [markDirty, syncHistory]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const onInput = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!dirtyRef.current) markDirty(true);
    timerRef.current = setTimeout(snapshot, SNAPSHOT_DELAY_MS);
  }, [markDirty, snapshot]);

  const restore = useCallback((from: "undo" | "redo") => {
    if (savingRef.current) return;
    snapshot();
    const root = rootRef.current;
    const doc = docRef.current;
    const source = from === "undo" ? undoRef : redoRef;
    const target = from === "undo" ? redoRef : undoRef;
    const next = source.current[source.current.length - 1];
    if (!root || !doc || !next || !currentRef.current) return;
    source.current = source.current.slice(0, -1);
    target.current = [...target.current, currentRef.current];
    currentRef.current = next;
    renderRtf(root, doc, next);
    syncHistory();
    markDirty(rtfContentChanged(doc, unitsOf(next)));
  }, [markDirty, snapshot, syncHistory, savingRef]);

  const format = useCallback((change: (f: RtfFormat, all: RtfFormat[]) => RtfFormat) => {
    const root = rootRef.current;
    const doc = docRef.current;
    const range = root?.ownerDocument.getSelection()?.rangeCount ? root.ownerDocument.getSelection()!.getRangeAt(0) : null;
    if (!root || !doc || doc.readOnlyReason || !range || !root.contains(range.commonAncestorContainer)) return;
    if (savingRef.current) { setStatus(SAVE_WAIT); return; }
    snapshot();
    const all = selectedFormats(root, range, doc);
    if (applyRtfFormat(root, range, doc, (f) => change(f, all))) snapshot();
    else setStatus("Select text to format it.");
  }, [snapshot, savingRef]);

  const paste = useCallback((text: string) => {
    const root = rootRef.current;
    if (!root || docRef.current?.readOnlyReason || savingRef.current) return;
    insertPlainText(root, text);
    onInput();
  }, [onInput, savingRef]);

  const save = useCallback(async () => {
    const root = rootRef.current;
    const doc = docRef.current;
    const baseline = baselineRef.current;
    const savePath = pathRef.current;
    if (!root || !doc || !baseline || !savePath || saving) return;
    snapshot();
    let source: string | null;
    try {
      source = buildRtfEdit(doc, unitsOf(readRtf(root, doc)));
    } catch (error) {
      setStatus(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (source === null) {
      markDirty(false);
      setStatus("No changes to save.");
      return;
    }
    const bytes = rtfBytesFromSource(source);
    setSaving(true);
    try {
      await saveDocumentBytes({
        path: savePath,
        bytes,
        expected: baseline,
        kind: "RTF file",
        validate: (candidate) => {
          if (rtfSourceFromBytes(candidate) !== source) throw new Error("RTF bytes do not match the edit.");
        },
      });
      onSaved?.(bytes, savePath);
      if (pathRef.current !== savePath) return;
      adopt(bytes);
      setStatus("Saved.");
    } catch (error) {
      if (pathRef.current !== savePath) return;
      const message = error instanceof DocumentChangedOnDiskError ? error.message : `Save failed: ${String(error)}`;
      setStatus(message);
    } finally {
      setSaving(false);
    }
  }, [adopt, markDirty, onSaved, saving, snapshot, setSaving]);

  /** Confirmed: drop the edits and load the file as it is on disk now. */
  const discard = useCallback(async () => {
    const discardPath = pathRef.current;
    if (!discardPath || !dirtyRef.current) return;
    const ok = await confirmAction("Discard your unsaved RTF edits and load the file from disk?", {
      title: "Discard RTF edits?", okLabel: "Discard edits", cancelLabel: "Keep editing", kind: "warning",
    });
    if (!ok || pathRef.current !== discardPath) return;
    try {
      const bytes = await readDocumentBytes(discardPath);
      if (pathRef.current !== discardPath) return;
      adopt(bytes);
      setStatus("Edits discarded.");
    } catch (error) {
      setStatus(`Could not reload this RTF file: ${String(error)}`);
    }
  }, [adopt]);

  return { rootRef, load, dirty, status, saving, history, onInput, format, paste, save, discard, undo: () => restore("undo"), redo: () => restore("redo") };
}

function sameParagraphs(a: readonly RtfParagraph[], b: readonly RtfParagraph[]): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    const x = a[k].items;
    const y = b[k].items;
    if (x.length !== y.length) return false;
    for (let j = 0; j < x.length; j++) {
      const p = x[j];
      const q = y[j];
      if (p.kind !== q.kind) return false;
      if (p.kind === "atom" && q.kind === "atom" && p.id !== q.id) return false;
      if (p.kind === "char" && q.kind === "char" && (p.ch !== q.ch || !sameFormat(p.fmt, q.fmt))) return false;
    }
  }
  return true;
}
