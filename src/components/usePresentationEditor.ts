import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { markMesaPerf } from "../lib/mesaPerf";
import { getStore } from "../store";
import { confirmAction } from "../lib/confirmAction";
import { DocumentChangedOnDiskError } from "../lib/documentBytesSave";
import { useOfficeByteSource } from "./officeByteSource";
import { duplicateRelPath } from "../lib/fsnames";
import { pdfBytesEqual } from "../lib/pdfBytes";
import { writeVaultBinaryFile } from "../lib/vault";
import { loadDeck, overlayView, type Deck, type PartView } from "../lib/pptx/pptxDeck";
import { buildPresentationSave, openPresentation, type OpenedPresentation } from "../lib/pptx/pptxSession";
import type { PartChanges } from "../lib/pptx/pptxStructure";
import type { VaultFile } from "../types";
import { SAVE_WAIT, useSaveLock } from "./useSaveLock";

const HISTORY_LIMIT = 50;

export type PresentationLoad =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; opened: OpenedPresentation };

export type PresentationEdit = (view: PartView, deck: Deck) => PartChanges;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Drops changes whose bytes equal the opened part, so editing back is clean. */
function normalize(opened: OpenedPresentation, changes: PartChanges): PartChanges {
  const out: PartChanges = new Map();
  for (const [name, bytes] of changes) {
    // A removal needs no read: parts decode on first read, and a deleted picture may be large.
    if (bytes === null) { if (opened.pkg.parts.has(name)) out.set(name, null); continue; }
    const original = opened.pkg.parts.get(name);
    if (original && pdfBytesEqual(bytes, original)) continue;
    out.set(name, bytes);
  }
  return out;
}

/**
 * Load, edit and verified save for one presentation. Edits are part changes
 * over the opened package; undo restores earlier change sets. Save writes
 * only when the opened bytes are still on disk.
 */
export function usePresentationEditor(file: VaultFile, onDirtyChange?: (dirty: boolean) => void) {
  const source = useOfficeByteSource();
  const [load, setLoad] = useState<PresentationLoad>({ state: "loading" });
  const [changes, setChanges] = useState<PartChanges>(new Map());
  const [undo, setUndo] = useState<PartChanges[]>([]);
  const [redo, setRedo] = useState<PartChanges[]>([]);
  const [status, setStatus] = useState("");
  const [diskChanged, setDiskChanged] = useState(false);
  const [saving, savingRef, setSaving] = useSaveLock();
  const coalesceRef = useRef<string | null>(null);
  const openedRef = useRef<OpenedPresentation | null>(null);
  const dirty = changes.size > 0;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const adopt = useCallback((bytes: Uint8Array) => {
    const started = performance.now();
    const opened = openPresentation(bytes, file.ext);
    // Native acceptance: interface-thread cost of opening a deck (Diagnostics).
    markMesaPerf("office-open", { kind: "pptx", ms: Math.round(performance.now() - started), bytes: bytes.length, slides: opened.deck.slides.length });
    openedRef.current = opened;
    setLoad({ state: "ready", opened });
    setChanges(new Map());
    setUndo([]);
    setRedo([]);
    setDiskChanged(false);
    coalesceRef.current = null;
  }, [file.ext]);

  const openedPath = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const first = openedPath.current !== file.path;
    openedPath.current = file.path;
    if (first) { setLoad({ state: "loading" }); setStatus(""); }
    void source.read(file.path).then((bytes) => {
      if (cancelled) return;
      const current = openedRef.current;
      if (!first && current) {
        if (pdfBytesEqual(bytes, current.pkg.original)) return; // our own save echo
        if (dirtyRef.current) {
          setDiskChanged(true);
          setStatus("This presentation changed on disk. Your edits are still here; Save is blocked, but Save as copy works.");
          return;
        }
        setStatus("Reloaded: this presentation changed on disk.");
      }
      try {
        adopt(bytes);
      } catch (error) {
        if (first || !current) setLoad({ state: "failed", message: `Mesa cannot open this presentation: ${message(error)}` });
        else setStatus(`The newer version on disk cannot be opened: ${message(error)}`);
      }
    }, (error) => {
      if (!cancelled && first) setLoad({ state: "failed", message: `Could not read this presentation: ${message(error)}` });
    });
    return () => { cancelled = true; };
  }, [file.path, file.mtime, adopt, source]);

  const opened = load.state === "ready" ? load.opened : null;
  const view = useMemo(() => (opened ? overlayView(opened.pkg, changes) : null), [opened, changes]);
  const deck = useMemo(() => {
    if (!opened || !view) return null;
    try { return loadDeck(view, opened.deck.presentationPart); } catch { return opened.deck; }
  }, [opened, view]);

  /** Applies an edit; `coalesce` merges consecutive edits of one text box into one undo step. */
  const apply = useCallback((edit: PresentationEdit, coalesce: string | null = null): boolean => {
    if (!opened || !view || !deck) return false;
    if (savingRef.current) { setStatus(SAVE_WAIT); return false; }
    let next: PartChanges;
    try {
      next = normalize(opened, new Map([...changes, ...edit(view, deck)]));
    } catch (error) {
      setStatus(message(error));
      return false;
    }
    if (coalesce === null || coalesceRef.current !== coalesce) {
      setUndo((list) => [...list.slice(1 - HISTORY_LIMIT), changes]);
      setRedo([]);
    }
    coalesceRef.current = coalesce;
    setChanges(next);
    setStatus("");
    return true;
  }, [opened, view, deck, changes, savingRef]);

  const step = useCallback((from: "undo" | "redo") => {
    const source = from === "undo" ? undo : redo;
    const target = source[source.length - 1];
    if (!target || savingRef.current) return;
    (from === "undo" ? setUndo : setRedo)(source.slice(0, -1));
    (from === "undo" ? setRedo : setUndo)((list) => [...list, changes]);
    coalesceRef.current = null;
    setChanges(target);
  }, [undo, redo, changes, savingRef]);

  const build = useCallback((): Uint8Array | null => {
    if (!opened) return null;
    return buildPresentationSave(opened.pkg, changes);
  }, [opened, changes]);

  const save = useCallback(async () => {
    if (!opened || saving) return;
    if (diskChanged) { setStatus("This presentation changed on disk, so Save is blocked. Use Save as copy, or Discard to load the newer version."); return; }
    let bytes: Uint8Array | null;
    try { bytes = build(); } catch (error) { setStatus(message(error)); return; }
    if (!bytes) { setChanges(new Map()); setStatus("No changes to save."); return; }
    const candidate = bytes;
    setSaving(true);
    try {
      await source.save({
        path: file.path, bytes: candidate, expected: opened.pkg.original, kind: "presentation",
        validate: (written) => { if (!pdfBytesEqual(written, candidate)) throw new Error("The written bytes differ from the checked save."); },
      });
      adopt(candidate);
      setStatus("Saved.");
    } catch (error) {
      if (error instanceof DocumentChangedOnDiskError) setDiskChanged(true);
      setStatus(error instanceof DocumentChangedOnDiskError ? error.message : `Save failed: ${message(error)}`);
    } finally {
      setSaving(false);
    }
  }, [opened, saving, diskChanged, build, file.path, adopt, source, setSaving]);

  const saveCopy = useCallback(async () => {
    const root = getStore().vaultPath;
    if (!opened || saving || !root) return;
    let bytes: Uint8Array | null;
    try { bytes = build(); } catch (error) { setStatus(message(error)); return; }
    if (!bytes) { setStatus("No changes to save."); return; }
    setSaving(true);
    try {
      const rel = duplicateRelPath(getStore().files.map((f) => f.relPath), file.relPath);
      await writeVaultBinaryFile(root, rel, await source.copyBytes(bytes), { expectedMissing: true });
      if (getStore().vaultPath !== root) return;
      await getStore().registerVaultFile(rel);
      setStatus(`Saved a copy as ${rel}. Your edits are still open here.`);
    } catch (error) {
      setStatus(`Save as copy failed: ${message(error)}`);
    } finally {
      setSaving(false);
    }
  }, [opened, saving, build, file.relPath, source, setSaving]);

  const discard = useCallback(async () => {
    if (!dirtyRef.current) return;
    const ok = await confirmAction(`Discard your unsaved edits to ${file.name} and load the file from disk?`, {
      title: "Discard presentation edits?", okLabel: "Discard edits", cancelLabel: "Keep editing", kind: "warning",
    });
    if (!ok) return false;
    try {
      adopt(await source.read(file.path));
      setStatus("Edits discarded.");
      return true;
    } catch (error) {
      setStatus(`Could not reload this presentation: ${message(error)}`);
      return false;
    }
  }, [file.name, file.path, adopt, source]);

  return {
    readOnlyReason: source.readOnlyReason, load, view, deck, dirty, status, setStatus, saving, diskChanged,
    canUndo: undo.length > 0, canRedo: redo.length > 0,
    apply, undo: () => step("undo"), redo: () => step("redo"), save, saveCopy, discard,
    endCoalesce: () => { coalesceRef.current = null; },
  };
}
