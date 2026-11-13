import type { StoreApi } from "zustand";
import { exists, stat } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import type { ActivityOp } from "../lib/activity";
import { forEachConcurrent } from "../lib/concurrency";
import { forkContentCache } from "../lib/documentWorkingSet";
import { relPathsOf } from "../lib/fileIndex";
import { singleNoteMeta } from "../lib/graph";
import { STARTUP_TEXT_READ_CONCURRENCY } from "../lib/startupTextCache";
import { MAX_TEXT_CACHE_FILE_BYTES } from "../lib/textCachePlan";
import {
  DEMO_ROOT,
  IN_TAURI,
  isIndexableVaultRelPath,
  isTextualVaultFile,
  normalizeVaultRelPath,
  readNoteResult,
  scanVault,
  toVaultFile,
  type VaultWatchEvent
} from "../lib/vault";
import type { VaultFile } from "../types";
import type { AppState, UnreadableTextReason } from "../storeTypes";

export type VaultPort = { get: () => AppState; set: StoreApi<AppState>["setState"] };
export const CALENDAR_FILE = "calendar.json";
export const fileOrder = new Intl.Collator(undefined).compare;

/** Catalogue maintenance for files that change outside Mesa: registration,
 *  bounded watcher reads, debounced refresh and batched removal. */
export function createExternalFiles({ get, set }: VaultPort) {
  let externalRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  async function registerExternalFile(
    rel: string,
    isCurrent: () => boolean = () => true,
    allowMissing = true
  ): Promise<void> {
    const root = get().vaultPath;
    if (!root || get().fileFor(rel) || !isCurrent()) return;
    // One definition of what belongs in a vault, shared with scanVault's walk.
    if (!isIndexableVaultRelPath(rel)) return;
    const file = toVaultFile(root, rel);
    const { path } = file;
    if (isTextualVaultFile(file)) {
      // A failed read may be a create announced before its write; the file
      // stays catalogue-only until a watcher change or an open reads it.
      const read = await readWatchedText(file);
      if (!allowMissing && !read.ok && !read.tooLarge) return;
      if (get().fileFor(rel) || !isCurrent()) return; // lost a race — already added
      const content = read.ok ? read.text : "";
      set({
        files: [...get().files, file].sort((a, b) =>
          fileOrder(a.relPath, b.relPath)
        ),
        notes: {
          ...get().notes,
          [rel]: singleNoteMeta(file, content),
        },
        ...(read.ok
          ? { contentCache: forkContentCache(get().contentCache, { [rel]: content }) }
          : unreadableUpdate({ [rel]: read.tooLarge ? "skipped" : "failed" })),
      });
    } else {
      // Binary file — add to the file list so the sidebar shows it, but no
      // text metadata is needed.
      // Best-effort stat for sort ordering.
      try {
        const s = await stat(path);
        file.size = s.size;
        file.mtime = s.mtime ? new Date(s.mtime).getTime() : undefined;
      } catch {
        /* stat unavailable — name-based sorting still works */
        if (!allowMissing) return;
      }
      if (get().fileFor(rel) || !isCurrent()) return; // lost a race
      set({
        files: [...get().files, file].sort((a, b) =>
          fileOrder(a.relPath, b.relPath)
        ),
      });
    }
  }

  // Pi reports a path before (or instead of) touching it. Known paths resolve
  // without I/O; only a create or write may register a file that is not there
  // yet; an unresolved path gets one debounced catalog refresh per burst, never
  // a full scan per event. Returns "" when the path is not a vault file.
  async function resolveActivityPath(
    rawPath: string,
    op: ActivityOp,
    root: string,
    isCurrent: () => boolean
  ): Promise<string> {
    const rel = normalizeVaultRelPath(rawPath, root) ||
      normalizeVaultRelPath(rawPath, root, relPathsOf(get().files));
    if (!rel) {
      scheduleExternalRefresh(root, isCurrent);
      return "";
    }
    if (get().fileFor(rel)) return rel;
    if (!isIndexableVaultRelPath(rel)) return "";
    await registerExternalFile(rel, isCurrent, op === "create" || op === "write");
    return isCurrent() && get().fileFor(rel) ? rel : "";
  }

  async function refreshMissingExternalFiles(
    root: string,
    isCurrent: () => boolean = () => get().vaultPath === root
  ): Promise<void> {
    if (!root || get().vaultPath !== root || !isCurrent()) return;
    const scanned = await scanVault(root);
    if (!isCurrent()) return;
    const latest = get();
    if (latest.vaultPath !== root) return;
    const existing = new Set(latest.files.map((f) => f.relPath));
    const additions = scanned.filter((f) => !existing.has(f.relPath));
    if (additions.length === 0) return;

    const nextNotes = { ...latest.notes };
    const nextCache = forkContentCache(latest.contentCache);
    const unreadable: Record<string, UnreadableTextReason> = {};
    const textAdditions = additions.filter(isTextualVaultFile);
    // An external create storm can contain thousands of text files. Keep
    // the final state commit atomic, but bound the reads and decoded strings
    // held by the ingestion pass so a watcher/activity burst cannot create one
    // Promise and one full document buffer per file.
    await forEachConcurrent(
      textAdditions,
      STARTUP_TEXT_READ_CONCURRENCY,
      async (f) => {
        const read = await readWatchedText(f);
        if (!isCurrent()) return;
        const text = read.ok ? read.text : "";
        if (read.ok) nextCache[f.relPath] = text;
        else unreadable[f.relPath] = read.tooLarge ? "skipped" : "failed";
        nextNotes[f.relPath] = singleNoteMeta(f, text);
      },
      () => !isCurrent()
    );
    if (!isCurrent()) return;
    const current = get();
    const present = new Set(current.files.map((file) => file.relPath));
    const remaining = additions.filter((file) => !present.has(file.relPath));
    const cache = forkContentCache(current.contentCache);
    const notes = { ...current.notes };
    const skipped: Record<string, UnreadableTextReason> = {};
    for (const file of remaining) {
      if (!(file.relPath in cache) && file.relPath in nextCache) cache[file.relPath] = nextCache[file.relPath];
      if (!(file.relPath in notes) && file.relPath in nextNotes) notes[file.relPath] = nextNotes[file.relPath];
      if (file.relPath in unreadable && !(file.relPath in cache)) skipped[file.relPath] = unreadable[file.relPath];
    }
    set({
      files: [...current.files, ...remaining].sort((a, b) => fileOrder(a.relPath, b.relPath)),
      notes,
      contentCache: cache,
      ...unreadableUpdate(skipped),
    });
  }

  /** After lost watcher events: one scan turns the difference between disk and
   * the catalog into ordinary watcher events (create, remove, metadata modify). */
  async function rescanAsEvents(root: string, isCurrent: () => boolean): Promise<VaultWatchEvent[] | null> {
    let scanned: VaultFile[];
    try {
      scanned = await scanVault(root);
    } catch (error) {
      if (isCurrent()) set({ status: `The vault watcher missed changes and the rescan failed: ${String(error)}` });
      return null;
    }
    if (!isCurrent()) return null;
    const known = new Map(get().files.map((file) => [file.relPath, file]));
    const onDisk = new Set(scanned.map((file) => file.relPath));
    const created: string[] = [];
    const modified: string[] = [];
    for (const file of scanned) {
      const prior = known.get(file.relPath);
      if (!prior) created.push(file.path);
      else if (file.size !== undefined && file.mtime !== undefined && (file.size !== prior.size || file.mtime !== prior.mtime)) modified.push(prior.path);
    }
    // An empty listing of a non-empty catalog is treated as unavailable, not as
    // a mass deletion.
    const removed = scanned.length ? [...known.values()].filter((file) => !onDisk.has(file.relPath)).map((file) => file.path) : [];
    const events: VaultWatchEvent[] = [];
    if (removed.length) events.push({ kind: "remove", paths: removed });
    if (created.length) events.push({ kind: "create", paths: created });
    if (modified.length) events.push({ kind: "modify", paths: modified });
    return events;
  }

  function scheduleExternalRefresh(
    root: string,
    isCurrent: () => boolean = () => get().vaultPath === root
  ): void {
    if (!root) return;
    if (externalRefreshTimer) clearTimeout(externalRefreshTimer);
    externalRefreshTimer = setTimeout(() => {
      externalRefreshTimer = undefined;
      if (isCurrent()) void refreshMissingExternalFiles(root, isCurrent);
    }, 180);
  }

  // Automatic watcher reads use the startup index's 8 MiB cap: a large log that
  // keeps growing must not be re-read in full on every change. Opening a file
  // still reads it completely.
  async function readWatchedText(file: VaultFile): Promise<{ ok: boolean; text: string; tooLarge?: boolean }> {
    if (!IN_TAURI || file.path.startsWith(DEMO_ROOT)) return readNoteResult(file);
    try {
      const bytes = new Uint8Array(await invoke<ArrayBuffer>("vault_read_bytes", {
        path: file.path, maxBytes: MAX_TEXT_CACHE_FILE_BYTES, requireComplete: false,
      }));
      if (bytes.length >= MAX_TEXT_CACHE_FILE_BYTES) return { ok: false, text: "", tooLarge: true };
      return { ok: true, text: new TextDecoder().decode(bytes) };
    } catch {
      return { ok: false, text: "" };
    }
  }

  // Only a definite "absent" counts; an exists() error keeps the entry.
  async function vanishedFromDisk(path: string): Promise<boolean> {
    if (path.startsWith(DEMO_ROOT)) return false;
    try {
      return !(await exists(path));
    } catch {
      return false;
    }
  }

  // Catalogue-only text files: merge their reasons and recount the totals.
  function unreadableUpdate(added: Record<string, UnreadableTextReason>): Partial<AppState> {
    if (!Object.keys(added).length) return {};
    const unreadableTextReasons = { ...get().unreadableTextReasons, ...added };
    const reasons = Object.values(unreadableTextReasons);
    return {
      unreadableTextReasons,
      unindexedTextFiles: reasons.length,
      skippedTextFiles: reasons.filter((reason) => reason === "skipped").length,
      failedTextFiles: reasons.filter((reason) => reason === "failed").length,
    };
  }

  // Remove externally deleted files from all relevant state maps in one commit.
  function removeExternalFiles(rels: ReadonlySet<string>): void {
    if (!rels.size) return;
    const files = get().files.filter((f) => !rels.has(f.relPath));
    // Copy a map only when it holds a removed path: deleting images or PDFs
    // must not republish notes or text, which rebuilds graph and backlinks.
    const holds = (map: object) => [...rels].some((rel) => Object.prototype.hasOwnProperty.call(map, rel));
    let notes: AppState["notes"] | undefined;
    if (holds(get().notes)) {
      notes = { ...get().notes };
      for (const rel of rels) delete notes[rel];
    }
    let contentCache: AppState["contentCache"] | undefined;
    if (holds(get().contentCache)) {
      contentCache = forkContentCache(get().contentCache);
      for (const rel of rels) delete contentCache[rel];
    }
    const openTabs = get().openTabs.some((t) => rels.has(t))
      ? get().openTabs.filter((t) => !rels.has(t))
      : undefined;
    let activePath = get().activePath;
    const wasActive = activePath !== null && rels.has(activePath);
    if (wasActive) activePath = null;
    const { docSplit } = get();
    set({
      files,
      ...(docSplit.other !== null && rels.has(docSplit.other) ? { docSplit: { ...docSplit, other: null } } : {}),
      ...(notes ? { notes } : {}),
      ...(contentCache ? { contentCache } : {}),
      ...(openTabs ? { openTabs } : {}),
      activePath,
      ...(wasActive ? { content: "" } : {}),
      ...(rels.has(CALENDAR_FILE) ? { calendarEvents: [] } : {}),
    });
  }

  return {
    registerExternalFile, resolveActivityPath, refreshMissingExternalFiles, rescanAsEvents,
    scheduleExternalRefresh, readWatchedText, vanishedFromDisk, removeExternalFiles,
    cancelScheduledRefresh() { clearTimeout(externalRefreshTimer); },
  };
}

export type ExternalFiles = ReturnType<typeof createExternalFiles>;
