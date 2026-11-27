import { useCallback, useEffect, useRef, useState } from "react";
import { markMesaPerf } from "../lib/mesaPerf";
import { getStore } from "../store";
import { confirmAction } from "../lib/confirmAction";
import { DocumentChangedOnDiskError } from "../lib/documentBytesSave";
import { useOfficeByteSource } from "./officeByteSource";
import { duplicateRelPath } from "../lib/fsnames";
import { pdfBytesEqual } from "../lib/pdfBytes";
import { writeVaultBinaryFile } from "../lib/vault";
import {
  addSheet, createDraft, isDraftClean, renameSheet, setCellText, XlsxEditRefusal, type XlsxDraft,
} from "../lib/ooxml/xlsxDraft";
import { applyRowShift, prepareRowShift } from "../lib/ooxml/xlsxRowShift";
import type { OpenedXlsx } from "../lib/ooxml/xlsxOpen";
import { planXlsxSave } from "../lib/ooxml/xlsxSave";
import { createXlsxWorkerClient, type XlsxWorkerClient } from "../lib/ooxml/xlsxWorkerClient";
import type { VaultFile } from "../types";
import { SAVE_WAIT, useSaveLock } from "./useSaveLock";

/** Larger workbooks open in the file details view instead. */
const XLSX_OPEN_LIMIT_BYTES = 64 * 1024 * 1024;
const HISTORY_LIMIT = 100;

type XlsxLoad =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; opened: OpenedXlsx };

interface History { past: XlsxDraft[]; future: XlsxDraft[] }

/** A row insert or delete running in the worker; other edits wait for it. */
interface RowJob { readonly insert: boolean; readonly row: number }

const ROW_JOB_WAIT = "Mesa is still moving rows. Edit again when it finishes.";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Open, explicit edit mode, undo, verified save and save-as-copy for one workbook. */
export function useXlsxEditor(file: VaultFile | undefined, onDirtyChange?: (dirty: boolean) => void) {
  const source = useOfficeByteSource();
  const [load, setLoad] = useState<XlsxLoad>({ state: "loading" });
  const [draft, setDraft] = useState<XlsxDraft | null>(null);
  const [history, setHistory] = useState<History>({ past: [], future: [] });
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, busyRef, setBusy] = useSaveLock();
  const [rowJob, setRowJob] = useState<RowJob | null>(null);
  const rowJobRef = useRef<RowJob | null>(null);
  const [diskChanged, setDiskChanged] = useState(false);
  const clientRef = useRef<XlsxWorkerClient | null>(null);
  const baselineRef = useRef<Uint8Array | null>(null);
  const openedRef = useRef<OpenedXlsx | null>(null);
  const pathRef = useRef<string | null>(null);
  const opened = load.state === "ready" ? load.opened : null;
  const dirty = !!opened && !!draft && !isDraftClean(opened.session, draft);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    const client = createXlsxWorkerClient();
    clientRef.current = client;
    return () => { client.dispose(); clientRef.current = null; };
  }, []);

  const adopt = useCallback(async (bytes: Uint8Array) => {
    const client = clientRef.current;
    if (!client) return;
    const started = performance.now();
    const next = await client.open(bytes);
    // Native acceptance: open time including the worker round trip (Diagnostics).
    markMesaPerf("office-open", { kind: "xlsx", ms: Math.round(performance.now() - started), bytes: bytes.length });
    baselineRef.current = bytes;
    openedRef.current = next;
    setLoad({ state: "ready", opened: next });
    setDraft(createDraft(next.session));
    setHistory({ past: [], future: [] });
    setDiskChanged(false);
  }, []);

  const path = file?.path;
  const mtime = file?.mtime;
  useEffect(() => {
    if (!path) return;
    // No baseline means nothing is open yet (first open, a failed open, or a
    // StrictMode re-run), so this read is an open, not a reload.
    const first = pathRef.current !== path || baselineRef.current === null;
    pathRef.current = path;
    let cancelled = false;
    if (first) { setLoad({ state: "loading" }); setStatus(""); setEditing(false); }
    void source.read(path).then(async (bytes) => {
      if (cancelled || pathRef.current !== path) return;
      if (!first && baselineRef.current) {
        if (pdfBytesEqual(bytes, baselineRef.current)) return; // our own save echo
        if (dirtyRef.current) {
          setDiskChanged(true);
          setStatus("This workbook changed on disk. Your edits are still here; Save is blocked, but Save as copy works.");
          return;
        }
      }
      if (bytes.length > XLSX_OPEN_LIMIT_BYTES) throw new Error(`it is larger than ${XLSX_OPEN_LIMIT_BYTES / 1024 / 1024} MiB`);
      await adopt(bytes);
      if (!first) setStatus("Reloaded: this workbook changed on disk.");
    }).catch((error: unknown) => {
      if (!cancelled && first) setLoad({ state: "failed", message: `Mesa cannot open this workbook: ${message(error)}` });
    });
    return () => { cancelled = true; };
  }, [path, mtime, adopt, source]);

  /** Applies a draft change with undo; a refusal becomes the status line. */
  const change = useCallback((make: (current: XlsxDraft, session: OpenedXlsx["session"]) => XlsxDraft) => {
    const current = openedRef.current;
    if (!current || !draft || !editing) return false;
    if (rowJobRef.current) { setStatus(ROW_JOB_WAIT); return false; }
    if (busyRef.current) { setStatus(SAVE_WAIT); return false; }
    try {
      const next = make(draft, current.session);
      if (next === draft) return true;
      setHistory((h) => ({ past: [...h.past.slice(1 - HISTORY_LIMIT), draft], future: [] }));
      setDraft(next);
      setStatus("");
      return true;
    } catch (error) {
      setStatus(error instanceof XlsxEditRefusal ? error.message : `That change failed: ${message(error)}`);
      return false;
    }
  }, [draft, editing, busyRef]);

  const undo = useCallback(() => {
    const previous = history.past[history.past.length - 1];
    if (!previous || !draft || rowJobRef.current || busyRef.current) return;
    setHistory({ past: history.past.slice(0, -1), future: [...history.future, draft] });
    setDraft(previous);
  }, [draft, history, busyRef]);

  const redo = useCallback(() => {
    const next = history.future[history.future.length - 1];
    if (!next || !draft || rowJobRef.current || busyRef.current) return;
    setHistory({ past: [...history.past, draft], future: history.future.slice(0, -1) });
    setDraft(next);
  }, [draft, history, busyRef]);

  const startEditing = useCallback(async () => {
    const current = openedRef.current;
    if (!current || current.refusals.length || source.readOnlyReason) return;
    if (current.warnings.length) {
      const ok = await confirmAction(`${current.warnings.join("\n")}\n\nMesa changes only the cells you edit and keeps every other part of the file as it is.`, {
        title: "Edit this workbook?", okLabel: "Edit", cancelLabel: "Keep read-only", kind: "warning",
      });
      if (!ok) return;
    }
    setEditing(true);
  }, [source]);

  /** Bytes for the current draft, written and verified off the interface thread; `null` for no change. */
  const buildBytes = useCallback(async (): Promise<{ bytes: Uint8Array; recalc: boolean } | null> => {
    const current = openedRef.current;
    const client = clientRef.current;
    if (!current || !client || !draft) return null;
    const plan = planXlsxSave(current.session, draft);
    if (!plan.changes.size) return null;
    return { bytes: await client.write(plan), recalc: plan.recalc };
  }, [draft]);

  const save = useCallback(async () => {
    const savePath = pathRef.current;
    const baseline = baselineRef.current;
    if (!savePath || !baseline || busy || diskChanged || rowJobRef.current) return;
    setBusy(true);
    try {
      const built = await buildBytes();
      if (!built) {
        if (openedRef.current) setDraft(createDraft(openedRef.current.session));
        setStatus("No changes to save. Nothing was written.");
        return;
      }
      await source.save({
        path: savePath, bytes: built.bytes, expected: baseline, kind: "Excel workbook",
        validate: (candidate) => { if (!pdfBytesEqual(candidate, built.bytes)) throw new Error("The bytes to write are not the verified workbook."); },
      });
      if (pathRef.current !== savePath) return;
      await adopt(built.bytes);
      setStatus(built.recalc ? "Saved. Formula results update when Excel opens the file." : "Saved.");
    } catch (error) {
      if (pathRef.current !== savePath) return;
      if (error instanceof DocumentChangedOnDiskError) setDiskChanged(true);
      setStatus(error instanceof DocumentChangedOnDiskError ? error.message : `Save failed, nothing was overwritten: ${message(error)}`);
    } finally {
      setBusy(false);
    }
  }, [adopt, buildBytes, busy, diskChanged, source, setBusy]);

  const saveCopy = useCallback(async () => {
    const root = getStore().vaultPath;
    if (!file || !root || busy || rowJobRef.current) return;
    setBusy(true);
    try {
      const built = await buildBytes();
      if (!built) { setStatus("No changes to save. Nothing was written."); return; }
      const rel = duplicateRelPath(getStore().files.map((f) => f.relPath), file.relPath);
      await writeVaultBinaryFile(root, rel, await source.copyBytes(built.bytes), { expectedMissing: true });
      if (getStore().vaultPath !== root) return;
      await getStore().registerVaultFile(rel);
      setStatus(`Saved a copy as ${rel}. This file is unchanged.`);
    } catch (error) {
      setStatus(`Save as copy failed: ${message(error)}`);
    } finally {
      setBusy(false);
    }
  }, [buildBytes, busy, file, source, setBusy]);

  const discard = useCallback(async () => {
    const discardPath = pathRef.current;
    if (!discardPath) return;
    if (dirtyRef.current && !(await confirmAction("Discard your unsaved workbook edits and load the file from disk?", {
      title: "Discard edits?", okLabel: "Discard edits", cancelLabel: "Keep editing", kind: "warning",
    }))) return;
    try {
      const bytes = await source.read(discardPath);
      if (pathRef.current !== discardPath) return;
      await adopt(bytes);
      setEditing(false);
      setStatus("Edits discarded.");
    } catch (error) {
      setStatus(`Could not reload this workbook: ${message(error)}`);
    }
  }, [adopt, source]);

  /**
   * Inserts or deletes a row: the reference proof runs here, the sheet rewrite
   * in the worker. Edits, undo and saves wait until it finishes; a result for
   * a draft that changed meanwhile (reload, discard) is dropped.
   */
  const shiftRow = useCallback(async (part: string, row: number, insert: boolean) => {
    const current = openedRef.current;
    const client = clientRef.current;
    const start = draftRef.current;
    if (!current || !client || !start || !editing) return false;
    if (rowJobRef.current) { setStatus(ROW_JOB_WAIT); return false; }
    let job;
    try {
      job = prepareRowShift(current.session, start, part, row, insert);
    } catch (error) {
      setStatus(error instanceof XlsxEditRefusal ? error.message : `That change failed: ${message(error)}`);
      return false;
    }
    const running = { insert, row };
    rowJobRef.current = running;
    setRowJob(running);
    setStatus("");
    try {
      const result = await client.shiftRows(job);
      if (openedRef.current !== current || draftRef.current !== start) {
        setStatus("The row change was dropped because the workbook changed while it ran.");
        return false;
      }
      const next = applyRowShift(start, job, result);
      draftRef.current = next;
      setHistory((h) => ({ past: [...h.past.slice(1 - HISTORY_LIMIT), start], future: [] }));
      setDraft(next);
      return true;
    } catch (error) {
      setStatus(`That change failed: ${message(error)}`);
      return false;
    } finally {
      rowJobRef.current = null;
      setRowJob(null);
    }
  }, [editing]);

  const ensureIndex = useCallback(async (part: string) => {
    const current = openedRef.current;
    const client = clientRef.current;
    if (!current || !client || current.session.hasIndex(part) || draft?.sheetDrafts.has(part)) return;
    const index = await client.index(current.session.workbook.partText(part));
    if (openedRef.current === current) current.session.adoptIndex(part, index);
  }, [draft]);

  return {
    readOnlyReason: source.readOnlyReason, load, draft, dirty, editing, status, setStatus, busy, diskChanged, rowJob,
    canUndo: history.past.length > 0, canRedo: history.future.length > 0,
    startEditing, undo, redo, save, saveCopy, discard, ensureIndex,
    setCell: (part: string, row: number, col: number, text: string) => change((d, s) => setCellText(s, d, part, row, col, text)),
    shiftRow,
    rename: (position: number, name: string) => change((d, s) => renameSheet(s, d, position, name)),
    addSheet: (name: string) => change((d, s) => addSheet(s, d, name)),
  };
}
