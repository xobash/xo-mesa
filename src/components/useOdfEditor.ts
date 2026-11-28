import { useCallback, useEffect, useRef, useState } from "react";
import { getStore } from "../store";
import { confirmAction } from "../lib/confirmAction";
import { DocumentChangedOnDiskError, readDocumentBytes, saveDocumentBytes } from "../lib/documentBytesSave";
import { duplicateRelPath } from "../lib/fsnames";
import { pdfBytesEqual } from "../lib/pdfBytes";
import { writeVaultBinaryFile } from "../lib/vault";
import { buildOdfSave, openSavedOdfPackage, type OdfPackage } from "../lib/odf/odfPackage";
import type { VaultFile } from "../types";
import { SAVE_WAIT, useSaveLock } from "./useSaveLock";

const HISTORY_LIMIT = 50;

export type OdfLoad =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; pkg: OdfPackage };

/** How one OpenDocument kind turns its draft into content.xml text. */
export interface OdfDraftSpec<D> {
  initial(pkg: OdfPackage): D;
  /** Content text for the draft (the opened text when nothing changed). */
  content(pkg: OdfPackage, draft: D): string;
  /** Cheap check that the draft holds no edit. */
  isClean(pkg: OdfPackage, draft: D): boolean;
  /** Kind-specific read-back of the re-opened candidate; throws to stop the save. */
  check?(saved: OdfPackage, draft: D): void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Load, edit and verified save for one OpenDocument file. Drafts are
 * immutable values; undo restores earlier drafts. Save writes only when the
 * opened bytes are still on disk, after the candidate re-opens and checks.
 */
export function useOdfEditor<D>(file: VaultFile, spec: OdfDraftSpec<D>, onDirtyChange?: (dirty: boolean) => void) {
  const [load, setLoad] = useState<OdfLoad>({ state: "loading" });
  const [draft, setDraft] = useState<D | null>(null);
  const [undo, setUndo] = useState<D[]>([]);
  const [redo, setRedo] = useState<D[]>([]);
  const [status, setStatus] = useState("");
  const [diskChanged, setDiskChanged] = useState(false);
  const [saving, savingRef, setSaving] = useSaveLock();
  const [editing, setEditing] = useState(false);
  const coalesceRef = useRef<string | null>(null);
  const pkgRef = useRef<OdfPackage | null>(null);
  const pkg = load.state === "ready" ? load.pkg : null;
  const dirty = !!pkg && draft !== null && !spec.isClean(pkg, draft);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const adopt = useCallback((bytes: Uint8Array) => {
    // After a save, `bytes` is the checked candidate and its package is at hand.
    const opened = openSavedOdfPackage(bytes);
    pkgRef.current = opened;
    setLoad({ state: "ready", pkg: opened });
    setDraft(spec.initial(opened));
    setUndo([]);
    setRedo([]);
    setDiskChanged(false);
    coalesceRef.current = null;
  }, [spec]);

  const openedPath = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const first = openedPath.current !== file.path;
    openedPath.current = file.path;
    if (first) { setLoad({ state: "loading" }); setStatus(""); setEditing(false); }
    void readDocumentBytes(file.path).then((bytes) => {
      if (cancelled) return;
      const current = pkgRef.current;
      if (!first && current) {
        if (pdfBytesEqual(bytes, current.original)) return; // our own save echo
        if (dirtyRef.current) {
          setDiskChanged(true);
          setStatus("This file changed on disk. Your edits are still here; Save is blocked, but Save as copy works.");
          return;
        }
        setStatus("Reloaded: this file changed on disk.");
      }
      try {
        adopt(bytes);
      } catch (error) {
        if (first || !current) setLoad({ state: "failed", message: `Mesa cannot open this file: ${message(error)}` });
        else setStatus(`The newer version on disk cannot be opened: ${message(error)}`);
      }
    }, (error) => {
      if (!cancelled && first) setLoad({ state: "failed", message: `Could not read this file: ${message(error)}` });
    });
    return () => { cancelled = true; };
  }, [file.path, file.mtime, adopt]);

  /** Replaces the draft; `coalesce` merges consecutive edits with the same key into one undo step. */
  const apply = useCallback((edit: (current: D) => D, coalesce: string | null = null): boolean => {
    if (!pkg || draft === null) return false;
    if (savingRef.current) { setStatus(SAVE_WAIT); return false; }
    let next: D;
    try { next = edit(draft); } catch (error) { setStatus(message(error)); return false; }
    if (next === draft) return true;
    if (coalesce === null || coalesceRef.current !== coalesce) {
      setUndo((list) => [...list.slice(1 - HISTORY_LIMIT), draft]);
      setRedo([]);
    }
    coalesceRef.current = coalesce;
    setDraft(next);
    setStatus("");
    return true;
  }, [pkg, draft, savingRef]);

  const step = useCallback((from: "undo" | "redo") => {
    const source = from === "undo" ? undo : redo;
    const target = source[source.length - 1];
    if (target === undefined || draft === null || savingRef.current) return;
    (from === "undo" ? setUndo : setRedo)(source.slice(0, -1));
    (from === "undo" ? setRedo : setUndo)((list) => [...list, draft]);
    coalesceRef.current = null;
    setDraft(target);
  }, [undo, redo, draft, savingRef]);

  const build = useCallback((): Uint8Array | null => {
    if (!pkg || draft === null) return null;
    return buildOdfSave(pkg, spec.content(pkg, draft), spec.check ? (saved) => spec.check!(saved, draft) : undefined);
  }, [pkg, draft, spec]);

  const save = useCallback(async () => {
    if (!pkg || saving) return;
    if (diskChanged) { setStatus("This file changed on disk, so Save is blocked. Use Save as copy, or Discard to load the newer version."); return; }
    let bytes: Uint8Array | null;
    try { bytes = build(); } catch (error) { setStatus(message(error)); return; }
    if (!bytes) { setDraft(spec.initial(pkg)); setStatus("No changes to save."); return; }
    if (pkg.policy.warnings.length && !(await confirmAction(`Mesa will save only your edits and copy everything else unchanged.\n\n${pkg.policy.warnings.join("\n")}`, {
      title: "Save document?", okLabel: "Save", cancelLabel: "Cancel",
    }))) return;
    const candidate = bytes;
    setSaving(true);
    try {
      await saveDocumentBytes({
        path: file.path, bytes: candidate, expected: pkg.original, kind: "document",
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
  }, [pkg, saving, diskChanged, build, spec, file.path, adopt, setSaving]);

  const saveCopy = useCallback(async () => {
    const root = getStore().vaultPath;
    if (!pkg || saving || !root) return;
    let bytes: Uint8Array | null;
    try { bytes = build(); } catch (error) { setStatus(message(error)); return; }
    if (!bytes) { setStatus("No changes to save."); return; }
    setSaving(true);
    try {
      const rel = duplicateRelPath(getStore().files.map((f) => f.relPath), file.relPath);
      await writeVaultBinaryFile(root, rel, bytes, { expectedMissing: true });
      if (getStore().vaultPath !== root) return;
      await getStore().registerVaultFile(rel);
      setStatus(`Saved a copy as ${rel}. Your edits are still open here.`);
    } catch (error) {
      setStatus(`Save as copy failed: ${message(error)}`);
    } finally {
      setSaving(false);
    }
  }, [pkg, saving, build, file.relPath, setSaving]);

  /** Drops unsaved edits after confirmation and reloads from disk. Returns false when kept. */
  const discard = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    const ok = await confirmAction(`Discard your unsaved edits to ${file.name} and load the file from disk?`, {
      title: "Discard edits?", okLabel: "Discard edits", cancelLabel: "Keep editing", kind: "warning",
    });
    if (!ok) return false;
    try {
      adopt(await readDocumentBytes(file.path));
      setStatus("Edits discarded.");
      return true;
    } catch (error) {
      setStatus(`Could not reload this file: ${message(error)}`);
      return false;
    }
  }, [file.name, file.path, adopt]);

  const finish = useCallback(async () => {
    if (await discard()) setEditing(false);
  }, [discard]);

  return {
    load, pkg, draft, dirty, status, setStatus, saving, diskChanged, editing,
    startEditing: () => { if (pkg?.policy.canEdit) setEditing(true); }, finish,
    canUndo: undo.length > 0, canRedo: redo.length > 0,
    apply, undo: () => step("undo"), redo: () => step("redo"), save, saveCopy, discard,
    endCoalesce: () => { coalesceRef.current = null; },
  };
}

export type OdfEditor<D> = ReturnType<typeof useOdfEditor<D>>;
