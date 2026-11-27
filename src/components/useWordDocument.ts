import { useCallback, useEffect, useRef, useState } from "react";
import { confirmAction } from "../lib/confirmAction";
import { DocumentChangedOnDiskError } from "../lib/documentBytesSave";
import { useOfficeByteSource } from "./officeByteSource";
import { pdfBytesEqual } from "../lib/pdfBytes";
import { openOoxmlPackage, type OoxmlPackage } from "../lib/ooxml/ooxmlPackage";
import { describeWordPolicy, wordEditPolicy, type WordPolicyNotice } from "../lib/ooxml/wordCompose";
import { OoxmlPackageError } from "../lib/ooxml/zipContainer";
import type { WordCommand, WordFormatting, WordImageMime, WordSurface } from "./wordEngine";
import { saveWordCopy, saveWordInPlace, type WordSaveOutcome } from "./wordDocumentSave";

/** Larger files open in the details view only; the engine lays out every page in memory. */
const WORD_OPEN_LIMIT_BYTES = 64 * 1024 * 1024;

type WordLoad =
  | { state: "loading" }
  | { state: "unsupported"; message: string }
  | { state: "ready"; pkg: OoxmlPackage; notice: WordPolicyNotice; generation: number };

type WordMode = "viewing" | "preparing" | "editing";

interface WordFile { path: string; relPath: string; mtime?: number }

/** Mounts the engine; injectable so component tests need not load it. */
export type WordSurfaceFactory = (
  host: HTMLElement,
  bytes: Uint8Array,
  events: { onChange(): void; onSelection(): void },
) => Promise<WordSurface>;

const loadWordSurface: WordSurfaceFactory = async (host, bytes, events) =>
  (await import("./wordEngine")).mountWordSurface(host, bytes, events);

const EMPTY_FORMAT: WordFormatting = { bold: false, italic: false, underline: false, strike: false, alignment: null, inTable: false, canUndo: false, canRedo: false };

function openWord(bytes: Uint8Array, generation: number): WordLoad {
  if (bytes.length > WORD_OPEN_LIMIT_BYTES) return { state: "unsupported", message: `This Word file is larger than ${WORD_OPEN_LIMIT_BYTES / 1024 / 1024} MiB, so Mesa shows its details only.` };
  try {
    const pkg = openOoxmlPackage(bytes);
    if (pkg.kind !== "wordprocessing") return { state: "unsupported", message: "This file is not a Word document inside, so Mesa shows its details only." };
    return { state: "ready", pkg, notice: describeWordPolicy(wordEditPolicy(pkg)), generation };
  } catch (error) {
    if (error instanceof OoxmlPackageError) return { state: "unsupported", message: error.message };
    throw error;
  }
}

/** Load, view, edit and verified save for one Word file. */
export function useWordDocument(file: WordFile | undefined, onDirtyChange: ((dirty: boolean) => void) | undefined, mount: WordSurfaceFactory = loadWordSurface) {
  const source = useOfficeByteSource();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [load, setLoad] = useState<WordLoad>({ state: "loading" });
  const [mode, setMode] = useState<WordMode>("viewing");
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [surfaceReady, setSurfaceReady] = useState(false);
  const [format, setFormat] = useState<WordFormatting>(EMPTY_FORMAT);
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  const surfaceRef = useRef<WordSurface | null>(null);
  const pkgRef = useRef<OoxmlPackage | null>(null);
  const baselineRef = useRef<Uint8Array | null>(null);
  const modeRef = useRef<WordMode>("viewing");
  const dirtyRef = useRef(false);
  const editCountRef = useRef(0);
  const generationRef = useRef(0);
  const pathRef = useRef<string | undefined>(undefined);
  const path = file?.path;
  const mtime = file?.mtime;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const markDirty = useCallback((next: boolean) => { dirtyRef.current = next; setDirty(next); }, []);
  const switchMode = useCallback((next: WordMode) => { modeRef.current = next; setMode(next); }, []);

  /** Shows `bytes` as the opened document, in viewing mode. */
  const adopt = useCallback((bytes: Uint8Array) => {
    const next = openWord(bytes, ++generationRef.current);
    pkgRef.current = next.state === "ready" ? next.pkg : null;
    baselineRef.current = null;
    markDirty(false);
    switchMode("viewing");
    setChangedOnDisk(false);
    setLoad(next);
  }, [markDirty, switchMode]);

  // Open on path change; a later mtime change reloads only a clean viewer.
  useEffect(() => {
    if (!path) return;
    const isNew = pathRef.current !== path;
    pathRef.current = path;
    let cancelled = false;
    if (isNew) { setLoad({ state: "loading" }); setStatus(""); }
    source.read(path).then((bytes) => {
      if (cancelled || pathRef.current !== path) return;
      const opened = pkgRef.current?.original;
      if (isNew || !opened) { adopt(bytes); return; }
      if (pdfBytesEqual(bytes, opened)) return; // Mesa's own save echo
      if (dirtyRef.current || modeRef.current !== "viewing") {
        setChangedOnDisk(true);
        setStatus("This Word file changed on disk. Your edits are still here; Save is blocked, but Save as copy works. Discard loads the newer version.");
        return;
      }
      adopt(bytes);
      setStatus("Reloaded: this Word file changed on disk.");
    }, (error: unknown) => {
      if (!cancelled && isNew) setLoad({ state: "unsupported", message: `Could not read this Word file: ${String(error)}` });
    });
    return () => { cancelled = true; };
  }, [path, mtime, adopt, source]);

  const generation = load.state === "ready" ? load.generation : 0;
  const readyBytes = load.state === "ready" ? load.pkg.original : null;
  // Mount the engine for each adopted document; unmount on replacement or close.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !readyBytes) return;
    let alive = true;
    let mounted: WordSurface | null = null;
    setSurfaceReady(false);
    const refresh = () => { if (alive && mounted) setFormat(mounted.formatting()); };
    mount(host, readyBytes, {
      onChange: () => {
        if (modeRef.current !== "editing") return;
        editCountRef.current++;
        markDirty(true);
        refresh();
      },
      onSelection: refresh,
    }).then((surface) => {
      if (!alive) { surface.destroy(); return; }
      mounted = surface;
      surfaceRef.current = surface;
      setSurfaceReady(true);
      refresh();
    }, (error: unknown) => {
      if (alive) setStatus(`Could not show this Word file: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      alive = false;
      mounted?.destroy();
      if (surfaceRef.current === mounted) surfaceRef.current = null;
    };
  }, [generation, readyBytes, mount, markDirty]);

  /** Records the editor's no-edit output, then unlocks editing. */
  const startEditing = useCallback(async () => {
    const surface = surfaceRef.current;
    if (!surface || modeRef.current !== "viewing") return;
    switchMode("preparing");
    try {
      baselineRef.current = await surface.save();
    } catch (error) {
      switchMode("viewing");
      setStatus(`Editing is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (surfaceRef.current !== surface) return;
    const refusal = surface.setEditing(true);
    if (refusal) { switchMode("viewing"); setStatus(`Editing is unavailable: ${refusal}`); return; }
    switchMode("editing");
    setStatus("");
  }, [switchMode]);

  const stopEditing = useCallback(() => {
    if (dirtyRef.current || modeRef.current !== "editing") return;
    surfaceRef.current?.setEditing(false);
    switchMode("viewing");
  }, [switchMode]);

  const run = useCallback((command: WordCommand) => {
    const surface = surfaceRef.current;
    if (!surface || modeRef.current !== "editing") return;
    const refusal = surface.run(command);
    if (refusal) setStatus(refusal);
    setFormat(surface.formatting());
  }, []);

  const insertImage = useCallback(async (bytes: Uint8Array, mime: WordImageMime, widthPoints: number, heightPoints: number) => {
    const surface = surfaceRef.current;
    if (!surface || modeRef.current !== "editing") return;
    const refusal = await surface.insertImage(bytes, mime, widthPoints, heightPoints);
    if (refusal) setStatus(`The picture was not inserted: ${refusal}`);
  }, []);

  const reloadFromDisk = useCallback(async (message: string) => {
    if (!path) return;
    try {
      const bytes = await source.read(path);
      if (pathRef.current !== path) return;
      adopt(bytes);
      setStatus(message);
    } catch (error) {
      setStatus(`Could not reload this Word file: ${String(error)}`);
    }
  }, [adopt, path, source]);

  const finishSave = useCallback(async (outcome: WordSaveOutcome, startedAt: number, edited: Uint8Array, inPlace: boolean) => {
    if (outcome.kind === "unchanged") { markDirty(false); setStatus("No changes to save."); return; }
    if (outcome.kind !== "saved") { setStatus(outcome.message); return; }
    if (!inPlace) { await reloadFromDisk(outcome.message); return; }
    pkgRef.current = outcome.package;
    baselineRef.current = edited;
    // The save's precondition proved the disk held the opened bytes, so a
    // "changed on disk" raised meanwhile was this write's own watcher echo.
    // A later outside change is caught again by the next save's precondition.
    setChangedOnDisk(false);
    markDirty(editCountRef.current !== startedAt);
    setStatus(outcome.message);
  }, [markDirty, reloadFromDisk]);

  const save = useCallback(async (asCopy: boolean) => {
    const surface = surfaceRef.current;
    const original = pkgRef.current;
    const baseline = baselineRef.current;
    const savePath = pathRef.current;
    if (!surface || !original || !baseline || !savePath || !file || busy || modeRef.current !== "editing") return;
    if (!asCopy && changedOnDisk) { setStatus("This Word file changed on disk, so Save is blocked. Use Save as copy, or Discard to load the newer version."); return; }
    setBusy(true);
    const startedAt = editCountRef.current;
    try {
      const edited = await surface.save();
      const input = { original, baseline, edited };
      const outcome = asCopy ? await saveWordCopy(file.relPath, input, source) : await saveWordInPlace(savePath, input, source);
      if (pathRef.current === savePath) await finishSave(outcome, startedAt, edited, !asCopy);
    } catch (error) {
      if (pathRef.current !== savePath) return;
      if (error instanceof DocumentChangedOnDiskError) setChangedOnDisk(true);
      setStatus(error instanceof DocumentChangedOnDiskError ? error.message : `${asCopy ? "Save as copy" : "Save"} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, changedOnDisk, file, finishSave, source]);

  /** Confirmed: drop the edits and show the file as it is on disk now. */
  const discard = useCallback(async () => {
    if (!dirtyRef.current) { await reloadFromDisk(""); return; }
    const ok = await confirmAction("Discard your unsaved Word edits and load the file from disk?", {
      title: "Discard Word edits?", okLabel: "Discard edits", cancelLabel: "Keep editing", kind: "warning",
    });
    if (ok) await reloadFromDisk("Edits discarded.");
  }, [reloadFromDisk]);

  return {
    readOnlyReason: source.readOnlyReason, hostRef, load, mode, dirty, status, busy, surfaceReady, format, changedOnDisk,
    startEditing, stopEditing, run, insertImage, discard, report: setStatus,
    save: () => save(false), saveCopy: () => save(true),
  };
}
