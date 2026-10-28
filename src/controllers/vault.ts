import {
  bumpActivityAmount,
  changedLineStats,
  changedSnippet
} from "../lib/activity";
import {
  parseEvents,
  type CalEvent
} from "../lib/daily";
import { documentEntries, forkContentCache } from "../lib/documentWorkingSet";
import { refreshedNoteMeta } from "../lib/graph";
import { extractAliases, extractLinks, extractTags } from "../lib/markdownExtract";
import { isMarkdownPath } from "../lib/markdownCode";
import {
  DEMO_ROOT,
  IN_TAURI,
  assertVaultRootAvailable,
  authorizeVaultRoot,
  canonicalRoot,
  extOf,
  isIndexableVaultRelPath,
  isTextualVaultFile,
  isValidUtf8Text,
  needsCachedTextRefresh,
  normalizeVaultRelPath,
  pickVault,
  readNote,
  readNoteResult,
  readVaultTextOutcomes,
  recoverWriteArtifacts,
  scanVault,
  stripExt,
  watchVault,
  type FoundArtifact,
  type VaultWatchEvent
} from "../lib/vault";
import { recordTextRevisionsAsync, type RevisionInput } from "../lib/textRevisionHistory";
import { fingerprintText, loadIndexedNotes } from "../lib/vaultIndex";
import { hydrateVaultMetadata } from "../lib/vaultMetadata";
import type {
  NoteMeta,
  SortMode,
  VaultFile
} from "../types";

import { invoke } from "@tauri-apps/api/core";
import { MAX_TEXT_CACHE_FILE_BYTES } from "../lib/textCachePlan";
import { exists, stat } from "@tauri-apps/plugin-fs";
import { forEachConcurrent } from "../lib/concurrency";
import { markMesaPerf } from "../lib/mesaPerf";
import { invalidatePdfThumb } from "../lib/pdfThumbInvalidation";
import { rememberRecentVaultNative, type RecentVaultState } from "../lib/persistedUi";
import { resetSearchEligibility } from "../lib/searchMatch";
import {
  STARTUP_TEXT_READ_CONCURRENCY,
} from "../lib/startupTextCache";
import {
  resetVaultTaskMemo
} from "../lib/tasks";
import {
  TextSaveCoordinator
} from "../lib/textSaveCoordinator";

import type { StoreApi } from "zustand";
import type { AppState } from "../store";
type Port = { get: () => AppState; set: StoreApi<AppState>["setState"] };
const CALENDAR_FILE = "calendar.json";
const SORT_MODES_NEEDING_METADATA = new Set<SortMode>(["modified", "size"]);
interface Dependencies extends Port {
  textSaves: TextSaveCoordinator<VaultFile>; resetDocuments: () => void; stopResearch: () => Promise<void>;
  setupActivityBridge: () => Promise<void>; ensureSyncEventBridge: () => Promise<void>;
  stopListening: () => Promise<boolean>; startListening: (root: string) => Promise<void>;
}
/** One event per path, latest kind wins, ordered by its last occurrence. Any
 * rescan request becomes one leading rescan event that later kinds cannot hide. */
export function mergeWatchEvents(events: VaultWatchEvent[]): VaultWatchEvent[] {
  const last = new Map<string, VaultWatchEvent["kind"]>();
  let rescan: VaultWatchEvent | null = null;
  for (const event of events) {
    if (event.kind === "rescan") { rescan ??= { kind: "rescan", paths: event.paths.slice(0, 1) }; continue; }
    for (const path of event.paths) { last.delete(path); last.set(path, event.kind); }
  }
  const merged = [...last].map(([path, kind]): VaultWatchEvent => ({ kind, paths: [path] }));
  return rescan ? [rescan, ...merged] : merged;
}
const fileOrder = new Intl.Collator(undefined).compare;
function vaultFileFor(root: string, rel: string): VaultFile {
  const base = rel.replace(/.*\//, "");
  const ext = extOf(base);
  return { path: `${root.replace(/\/+$/, "")}/${rel}`, relPath: rel, name: stripExt(base), ext, isMarkdown: /^(md|markdown)$/i.test(ext) };
}
export function createVaultController({ get, set, textSaves, resetDocuments, stopResearch, setupActivityBridge, ensureSyncEventBridge, stopListening, startListening }: Dependencies) {
  // A path is not a lifecycle identity: reopening the same vault must cancel
  // the previous open's scan and background metadata/search work too.
  let vaultOpenGeneration = 0;
  let vaultOpenRequest = 0;
  let unwatch: (() => void) | undefined;
  let watcherSetupGeneration = 0;
  let externalRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  async function registerExternalFile(
    rel: string,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    const root = get().vaultPath;
    if (!root || get().fileFor(rel) || !isCurrent()) return;
    // One definition of what belongs in a vault, shared with scanVault's walk.
    if (!isIndexableVaultRelPath(rel)) return;
    const file = vaultFileFor(root, rel);
    const { path, name } = file;
    if (isTextualVaultFile(file)) {
      // A failed read may be a create announced before its write; the file
      // stays catalogue-only until a watcher change or an open reads it.
      const read = await readWatchedText(file);
      if (get().fileFor(rel) || !isCurrent()) return; // lost a race — already added
      const content = read.ok ? read.text : "";
      set({
        files: [...get().files, file].sort((a, b) =>
          fileOrder(a.relPath, b.relPath)
        ),
        notes: {
          ...get().notes,
          [rel]: {
            relPath: rel,
            title: name,
            rawLinks: extractLinks(content, isMarkdownPath(rel)),
            tags: extractTags(content, isMarkdownPath(rel)),
            aliases: extractAliases(content),
            firstImagePath: undefined,
          },
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
      }
      if (get().fileFor(rel) || !isCurrent()) return; // lost a race
      set({
        files: [...get().files, file].sort((a, b) =>
          fileOrder(a.relPath, b.relPath)
        ),
      });
    }
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
    const unreadable: Record<string, "skipped" | "failed"> = {};
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
        nextNotes[f.relPath] = {
          relPath: f.relPath,
          title: f.name,
          rawLinks: extractLinks(text, isMarkdownPath(f.relPath)),
          tags: extractTags(text, isMarkdownPath(f.relPath)),
          aliases: extractAliases(text),
          firstImagePath: undefined,
        };
      },
      () => !isCurrent()
    );
    if (!isCurrent()) return;
    const current = get();
    const present = new Set(current.files.map((file) => file.relPath));
    const remaining = additions.filter((file) => !present.has(file.relPath));
    const cache = forkContentCache(current.contentCache);
    const notes = { ...current.notes };
    const skipped: Record<string, "skipped" | "failed"> = {};
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
  function unreadableUpdate(added: Record<string, "skipped" | "failed">): Partial<AppState> {
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
    const notes = { ...get().notes };
    const contentCache = forkContentCache(get().contentCache);
    for (const rel of rels) {
      delete notes[rel];
      delete contentCache[rel];
    }
    const openTabs = get().openTabs.filter((t) => !rels.has(t));
    let activePath = get().activePath;
    const wasActive = activePath !== null && rels.has(activePath);
    if (wasActive) activePath = null;
    const { docSplit } = get();
    set({
      files,
      ...(docSplit.other !== null && rels.has(docSplit.other) ? { docSplit: { ...docSplit, other: null } } : {}),
      notes,
      contentCache,
      openTabs,
      activePath,
      ...(wasActive ? { content: "" } : {}),
      ...(rels.has(CALENDAR_FILE) ? { calendarEvents: [] } : {}),
    });
  }

  // React to external file changes (AI agents / other tools editing the vault):
  // flicker the changed node and refresh its metadata so the graph stays live.
  // Handles creates, modifies, and deletes for ALL file types — not just
  // markdown — so the sidebar, graph, and content cache stay in sync with the
  // filesystem.
  async function handleExternalChange(
    events: VaultWatchEvent[],
    watcherRoot: string,
    watcherGeneration: number
  ) {
    const isCurrent = () =>
      Boolean(watcherRoot) &&
      get().vaultPath === watcherRoot &&
      vaultOpenGeneration === watcherGeneration;
    if (!isCurrent()) return;
    const watcherStartedAt = performance.now();
    let watcherPaths = 0;
    let watcherRescans = 0;
    let watcherReads = 0;
    let watcherReadMs = 0;
    let watcherRescanMs = 0;
    const rootRaw = watcherRoot;
    const seen = new Set<string>();
    // Deduplicate changed paths and publish accumulated results once per batch.
    const historyItems: RevisionInput[] = [];
    const cleanChanges: string[] = [];
    let watcherWarning = false;
    const pendingContent = new Map<string, string>();
    const pendingEditable = new Map<string, boolean>();
    const created = new Map<string, VaultFile>();
    const pendingNotes = new Map<string, NoteMeta>();
    let filesDirty = false;
    // Build alias-path lookup lists only when needed; cache by files-array identity.
    let knownFrom: VaultFile[] | null = null;
    let knownRelPaths: string[] = [];
    const knownRels = (): string[] => {
      const cur = get().files;
      if (knownFrom !== cur) {
        knownFrom = cur;
        knownRelPaths = cur.map((f) => f.relPath);
      }
      return knownRelPaths;
    };
    // A full rescan is `scanVault` over the whole vault. One per batch picks up
    // everything on disk at that moment, so a second one inside the same loop
    // can only repeat work; anything created after it is left to the debounced
    // refresh. Unbounded rescans inside an event handler are what turned a
    // burst of unrecognized paths into a freeze.
    let rescanned = false;
    const rescanOnce = async (): Promise<void> => {
      if (rescanned) return;
      rescanned = true;
      watcherRescans++;
      const startedAt = performance.now();
      try {
        await refreshMissingExternalFiles(rootRaw, isCurrent);
      } finally {
        watcherRescanMs += performance.now() - startedAt;
      }
    };
    // Consecutive deletes commit together, before the next await or path that
    // reads the catalogue, so later work always sees them applied.
    const removals = new Set<string>();
    const commitRemovals = () => {
      removeExternalFiles(removals);
      removals.clear();
    };
    // A dirty file deleted outside Mesa stays open so its local text survives.
    const removeUnlessDirty = (rel: string) => {
      const removedFile = get().fileFor(rel);
      if (!removedFile) return;
      if (textSaves.isDirty(removedFile.path)) {
        watcherWarning = true;
        set({ status: `File deleted outside Mesa; unsaved text was kept for ${rel}.` });
      } else {
        removals.add(rel);
      }
    };
    const flush = () => {
      if (!isCurrent()) return;
      if (!pendingContent.size && !pendingEditable.size && !pendingNotes.size && !filesDirty) return;
      const next: Partial<AppState> = {};
      if (pendingContent.size) {
        // Read at flush time, so creates and deletes that committed during the
        // loop are already in the base. `seen` means a rel is never both queued
        // here and removed in the same batch.
        const cache = forkContentCache(get().contentCache);
        let changed = false;
        for (const [rel, text] of pendingContent) {
          const file = get().fileFor(rel);
          // The user can start typing after the disk read but before this batch
          // commits. Never replace that newer local buffer with the queued read.
          if (file && textSaves.isDirty(file.path)) continue;
          cache[rel] = text;
          changed = true;
          if (get().activePath === rel) next.content = text;
          if (rel === CALENDAR_FILE) next.calendarEvents = parseEvents(text);
        }
        if (changed) next.contentCache = cache;
      }
      const active = get().activePath;
      if (active && pendingEditable.has(active)) {
        const file = get().fileFor(active);
        if (file && !textSaves.isDirty(file.path)) {
          const valid = pendingEditable.get(active);
          next.activeContentState = valid ? "ready" : "invalid-encoding";
          if (!valid) next.status = `${active} is not valid UTF-8; opened read-only to avoid corrupting it.`;
        }
      }
      if (pendingNotes.size) {
        const notes = { ...get().notes };
        let changed = false;
        for (const [rel, meta] of pendingNotes) {
          const file = get().fileFor(rel);
          if (file && textSaves.isDirty(file.path)) continue;
          notes[rel] = meta;
          changed = true;
        }
        if (changed) next.notes = notes;
      }
      // Stat refreshes mutate the VaultFile objects in place; the array copy
      // exists only to give React a new identity to re-render from.
      if (filesDirty) next.files = [...get().files];
      set(next);
    };
    try {
      if (events.some((event) => event.kind === "rescan")) {
        // One scan per batch replaces every lost event; it also answers any
        // unresolvable path below.
        rescanned = true;
        watcherRescans++;
        watcherWarning = true;
        const startedAt = performance.now();
        const recovered = await rescanAsEvents(rootRaw, isCurrent).finally(() => {
          watcherRescanMs += performance.now() - startedAt;
        });
        if (!isCurrent()) return;
        if (recovered) set({ status: "The vault watcher missed changes; Mesa rescanned the vault." });
        events = [...events.filter((event) => event.kind !== "rescan"), ...(recovered ?? [])];
      }
      for (const evt of events) {
        for (const p of evt.paths) {
          watcherPaths++;
          if (!isCurrent()) return;
          if (evt.kind !== "remove") commitRemovals();
          // Cheap form first: a path under the vault root resolves on the
          // root-prefix branch without the list being read at all.
          let rel = normalizeVaultRelPath(p, rootRaw);
          if (!rel) rel = normalizeVaultRelPath(p, rootRaw, knownRels());
          if (!rel) {
            commitRemovals();
            await rescanOnce();
            if (!isCurrent()) return;
            rel = normalizeVaultRelPath(p, rootRaw, knownRels());
            // Created after this batch's rescan: let the debounced refresh find
            // it instead of scanning the whole vault again mid-loop. Previously
            // such a path was simply dropped.
            if (!rel) scheduleExternalRefresh(rootRaw, isCurrent);
          }
          if (!rel || seen.has(rel)) continue;
          seen.add(rel);

          // Ignore paths excluded by isIndexableVaultRelPath before refresh or rescan.
          if (!isIndexableVaultRelPath(rel)) continue;

          // --- Deletion ---
          if (evt.kind === "remove") {
            removeUnlessDirty(rel);
            continue;
          }

          // --- Create or Modify ---
          const file = get().fileFor(rel);
          if (!file) {
            // Renames, moves out and recursive folder deletes can arrive as one
            // modify event for the folder path. Never catalogue a folder as a
            // file; drop its known subtree when it is gone from disk.
            const prefix = `${rel}/`;
            if (knownRels().some((known) => known.startsWith(prefix))) {
              const gone = await vanishedFromDisk(vaultFileFor(rootRaw, rel).path);
              if (!isCurrent()) return;
              if (gone) {
                for (const known of knownRels()) {
                  if (!known.startsWith(prefix) || seen.has(known)) continue;
                  seen.add(known);
                  removeUnlessDirty(known);
                }
              }
              continue;
            }
            created.set(rel, vaultFileFor(rootRaw, rel));
            continue;
          }

          // Existing file — refresh content/metadata
          if (isTextualVaultFile(file)) {
            watcherReads++;
            const startedAt = performance.now();
            const read = await readWatchedText(file).finally(() => {
              watcherReadMs += performance.now() - startedAt;
            });
            if (!isCurrent()) return;
            if (read.tooLarge) {
              if (get().openTabs.includes(rel) || get().activePath === rel) {
                watcherWarning = true;
                set({ status: `${rel} changed outside Mesa; it is 8 MiB or larger, so reopen it to see the change.` });
              }
              continue;
            }
            if (!read.ok) {
              // The old name of a rename arrives as a modify; a file that is
              // gone from disk is a removal, not an unreadable change.
              const gone = await vanishedFromDisk(file.path);
              if (!isCurrent()) return;
              if (gone) {
                removeUnlessDirty(rel);
                continue;
              }
              watcherWarning = true;
              set({ status: `External change could not be read; keeping cached content for ${rel}.` });
              continue;
            }
            const text = read.text;
            let valid: boolean;
            try { valid = await isValidUtf8Text(file, text); }
            catch (error) {
              if (!isCurrent()) return;
              watcherWarning = true;
              set({ status: `External change could not be validated; keeping cached content for ${rel}: ${String(error)}` });
              continue;
            }
            if (!isCurrent()) return;
            pendingEditable.set(rel, valid);
            const old = get().contentCache[rel] ?? "";
            if (text === old) continue; // unchanged, or our own in-app save
            // brighter flicker for bigger edits
            const mag = Math.min(1.6, 0.5 + Math.abs(text.length - old.length) / 180);
            bumpActivityAmount(
              rel,
              mag,
              "write",
              undefined,
              changedSnippet(old, text),
              changedLineStats(old, text)
            );
            // A clean active document can accept the disk update. A dirty file
            // cannot: its verified save will detect the changed baseline and
            // keep the local edit retryable instead of overwriting either side.
            if (!textSaves.isDirty(file.path)) {
              cleanChanges.push(rel);
              if (get().contentCache[rel] !== undefined) {
                historyItems.push({ relPath: rel, content: old, source: "external" });
              }
              const cur = get().notes[rel];
              if (cur) pendingNotes.set(rel, refreshedNoteMeta(cur, text) ?? cur);
              pendingContent.set(rel, text);
            } else {
              watcherWarning = true;
              set({ status: `File changed outside Mesa; unsaved text was kept for ${rel}.` });
            }
          } else {
            // Binary file was modified (e.g. an image was replaced).
            // Refresh its stat so sidebar sorting stays accurate.
            if (file.ext === "pdf") {
              // Stale hover thumbnails must not survive an on-disk change.
              invalidatePdfThumb(file.path);
            }
            // Refresh cached text for external edits without replacing the
            // document currently being typed in.
            if (
              !textSaves.isDirty(file.path) &&
              needsCachedTextRefresh(file, get().contentCache[rel])
            ) {
              watcherReads++;
              const startedAt = performance.now();
              const read = await readWatchedText(file).finally(() => {
                watcherReadMs += performance.now() - startedAt;
              });
              if (!isCurrent()) return;
              if (read.tooLarge) continue;
              if (!read.ok) {
                watcherWarning = true;
                set({ status: `External change could not be read; keeping cached content for ${rel}.` });
                continue;
              }
              const text = read.text;
              // Mesa's own saves land here too; an unchanged read must not churn
              // the cache identity that every text consumer subscribes to.
              if (text !== get().contentCache[rel]) {
                pendingContent.set(rel, text);
              }
            }
            try {
              const s = await stat(file.path);
              if (!isCurrent()) return;
              file.size = s.size;
              file.mtime = s.mtime ? new Date(s.mtime).getTime() : undefined;
              // Re-render once for the batch, not once per file.
              filesDirty = true;
            } catch {
              /* stat failed — leave as-is */
            }
          }
        }
      }
      commitRemovals();
      if (created.size) {
        const additions = [...created.values()];
        const texts = new Map<string, string>();
        await forEachConcurrent(additions, STARTUP_TEXT_READ_CONCURRENCY, async file => {
          if (isTextualVaultFile(file)) {
            watcherReads++;
            const startedAt = performance.now();
            try {
              const result = await readWatchedText(file);
              if (result.ok) texts.set(file.relPath, result.text);
              else if (!result.tooLarge && isCurrent()) set({ status: `External create could not be read: ${file.relPath}.` });
            } catch {
              if (isCurrent()) set({ status: `External create could not be read: ${file.relPath}.` });
            } finally { watcherReadMs += performance.now() - startedAt; }
          } else {
            try {
              const info = await stat(file.path);
              file.size = info.size; file.mtime = info.mtime ? new Date(info.mtime).getTime() : undefined;
            } catch { /* Names remain available when metadata cannot be read. */ }
          }
        }, () => !isCurrent());
        if (!isCurrent()) return;
        const present = new Set(get().files.map(file => file.relPath));
        const fresh = additions.filter(file => !present.has(file.relPath));
        if (fresh.length) {
          const notes = { ...get().notes };
          const cache = forkContentCache(get().contentCache);
          for (const file of fresh) {
            const text = texts.get(file.relPath);
            if (text === undefined) continue;
            cache[file.relPath] = text;
            notes[file.relPath] = { relPath: file.relPath, title: file.name, rawLinks: extractLinks(text, isMarkdownPath(file.relPath)), tags: extractTags(text, isMarkdownPath(file.relPath)), aliases: extractAliases(text), firstImagePath: undefined };
          }
          set({ files: [...get().files, ...fresh].sort((a,b) => fileOrder(a.relPath,b.relPath)), notes, contentCache: cache });
          for (const file of fresh) {
            const text = texts.get(file.relPath) ?? "";
            bumpActivityAmount(file.relPath, 1.3, "create", undefined, text.slice(0,160), { added: changedLineStats("",text).added, removed: 0 });
          }
        }
      }
    } finally {
      if (isCurrent()) commitRemovals();
      // Applies whatever the batch got through even if a later path throws —
      // the per-file commits this replaced had that property too.
      if (isCurrent() && cleanChanges.length) {
        const revisions = historyItems.length ? await recordTextRevisionsAsync(rootRaw, historyItems) : [];
        if (isCurrent()) {
          const dirty = cleanChanges.filter(rel => {
            const file = get().fileFor(rel);
            return file && textSaves.isDirty(file.path);
          });
          if (dirty.length) {
            for (const rel of dirty) set({ status: `File changed outside Mesa; unsaved text was kept for ${rel}.` });
          } else if (!watcherWarning) {
            const label = cleanChanges.length === 1 ? "File changed outside Mesa" : `${cleanChanges.length} files changed outside Mesa`;
            set({ status: `${label}; ${revisions.length === cleanChanges.length && revisions.every(Boolean) ? "Previous text kept in document history." : "Previous text history is unavailable for some files."}` });
          }
        }
      }
      const flushStartedAt = performance.now();
      flush();
      markMesaPerf("watcher-batch", {
        durationMs: Math.round((performance.now() - watcherStartedAt) * 10) / 10,
        readMs: Math.round(watcherReadMs * 10) / 10,
        rescanMs: Math.round(watcherRescanMs * 10) / 10,
        commitMs: Math.round((performance.now() - flushStartedAt) * 10) / 10,
        events: events.length,
        paths: watcherPaths,
        rescans: watcherRescans,
        reads: watcherReads,
      });
    }
  }

  async function setupWatcher(root: string) {
    const setupGeneration = ++watcherSetupGeneration;
    try {
      unwatch?.();
    } catch {
      /* ignore */
    }
    unwatch = undefined;
    const generation = vaultOpenGeneration;
    let tail: Promise<void> = Promise.resolve();
    let pending: VaultWatchEvent[] | null = null;
    const enqueue = (events: VaultWatchEvent[]) => {
      if (pending) { pending.push(...events); return; }
      pending = [...events];
      tail = tail.then(async () => {
        const batch = mergeWatchEvents(pending!);
        pending = null;
        if (setupGeneration !== watcherSetupGeneration) return;
        await handleExternalChange(batch, root, generation);
      }).catch(error => console.warn("[mesa] external change batch failed:", error));
    };
    const stop = await watchVault(root, enqueue);
    if (setupGeneration !== watcherSetupGeneration) {
      // A newer vault opened while this watcher was starting. Do not retain a
      // late watcher whose cleanup handle belongs to an older vault.
      stop();
      return;
    }
    unwatch = stop;
  }

  const actions: Pick<AppState, "openVault"> = {
    openVault: async (path) => {
      const picked = path ?? (await pickVault());
      if (!picked) return;
      // Canonicalize here so *every* entry point (startup restore, ?vault=
      // deeplink, recent-row click, zip import, agent panel) stores the exact
      // same spelling as the folder dialog. Otherwise the recents list can hold
      // two forms of one folder and the switcher can't remove it (Windows).
      const root = picked === DEMO_ROOT ? DEMO_ROOT : canonicalRoot(picked);
      if (!root) return;
      if (get().dirtyBinaryPaths.length && !(await get().confirmDiscardBinaryEdits(null, "Opening a vault"))) return;
      const request = ++vaultOpenRequest;
      const requestIsCurrent = () => request === vaultOpenRequest;
      const pendingName =
        root === DEMO_ROOT ? "Demo Vault" : root.split(/[\\/]/).pop() || root;
      const remoteHint = root.replace(/\\/g, "/").startsWith("/Volumes/") || root.replace(/\\/g, "/").startsWith("//");
      set({
        loading: true,
        status: remoteHint
          ? "Reaching the vault over the network…"
          : "Checking the vault folder…",
      });
      let storageWarning: string | null = null;
      // Do this before flushing the current editor, cancelling research, or
      // stopping its watcher. A failed switch must leave the current vault
      // fully operational; startup restore keeps the missing root selected in
      // an explicit retryable state instead of publishing a blank workspace.
      try {
        storageWarning = await authorizeVaultRoot(root);
        await assertVaultRootAvailable(root);
      } catch (error) {
        if (!requestIsCurrent()) return;
        set({
          loading: false,
          unavailableVault: {
            root,
            name: pendingName,
            reason: String(error),
          },
          status: `Vault unavailable: ${pendingName}. Reconnect the drive; Mesa will retry automatically.`,
        });
        // A superseded scan may already have stopped the active watcher.
        // Restore it even when this newer request never reached the scan phase.
        const activeRoot = get().vaultPath;
        if (activeRoot && !unwatch) await setupWatcher(activeRoot).catch(() => { });
        return;
      }
      if (!requestIsCurrent()) return;
      set({ unavailableVault: null });
      markMesaPerf("vault-open-requested", {
        native: IN_TAURI,
        filePathProvided: path != null,
      });
      // A vault switch cannot strand a debounce timer whose relative path may
      // also exist in the next vault. Keep the old vault active if any verified
      // save fails, so the user can resolve the conflict without losing text.
      try {
        await textSaves.flushAll();
      } catch {
        if (requestIsCurrent()) {
          set({ loading: false });
          const activeRoot = get().vaultPath;
          if (activeRoot && !unwatch) await setupWatcher(activeRoot).catch(() => { });
        }
        return;
      }
      if (!requestIsCurrent()) return;
      const openGeneration = ++vaultOpenGeneration;
      const isCurrentOpen = () => vaultOpenGeneration === openGeneration && requestIsCurrent();
      try {
        resetDocuments();
        const activeResearch = get().deepResearch;
        if (activeResearch && activeResearch.phase !== "idle") {
          void stopResearch();
          set({
            deepResearch: {
              ...activeResearch,
              phase: "cancelled",
              launchStage: "cancelled",
              changeSet: null,
              error: "Deep Research was cancelled because the active vault changed.",
            },
          });
        }
        // Invalidate and stop the outgoing watcher before the new vault scan.
        // `watchVault` is asynchronous, so a watcher that is still starting can
        // otherwise resolve later and remain attached to the old vault.
        watcherSetupGeneration++;
        try {
          unwatch?.();
        } catch {
          /* ignore */
        }
        unwatch = undefined;
        set({
          loading: true,
          status: remoteHint
            ? "Reaching the vault over the network…"
            : "Looking through the vault…",
        });
        markMesaPerf("vault-scan-start", { rootKind: root.startsWith("/Volumes/") || root.startsWith("//") ? "remote-hint" : "local-or-unknown" });
        // The task memo keys on relPath, so without this the outgoing vault's
        // note contents stay reachable until the dashboard next runs a pass.
        resetVaultTaskMemo();
        // Same reason: the search eligibility memo keys on relPath and holds the
        // text it answered for, so the outgoing vault's strings would stay
        // reachable through it.
        resetSearchEligibility();

        // Wait for fallback metadata only when the active sidebar sort needs it;
        // otherwise load it after the initial paint.
        const needsMetadataNow = SORT_MODES_NEEDING_METADATA.has(
          get().settings.sortMode
        );
        // Reuse scan-discovered recovery artifacts; null requires recovery to walk the vault itself.
        let discoveredArtifacts: FoundArtifact[] | null = null;
        let files = await scanVault(root, {
          metadata: needsMetadataNow,
          stopped: () => !isCurrentOpen(),
          onArtifacts: (a) => {
            discoveredArtifacts = a;
          },
        });
        markMesaPerf("vault-scan-complete", { files: files.length });
        if (!isCurrentOpen()) return;
        set({ status: `Found ${files.length.toLocaleString()} files. Opening the notes now…` });
        // Never throws; never blocks opening the vault. `null` means this scan
        // could not answer (demo, or no native command) and recovery walks itself.
        const recovered = await recoverWriteArtifacts(
          root,
          () => !isCurrentOpen(),
          discoveredArtifacts
        );
        if (!isCurrentOpen()) return;
        if (recovered.restored.length) {
          console.warn(
            "[mesa] restored files from interrupted saves:",
            recovered.restored
          );
          // A restored file has to be scanned like any other. Re-listing costs one
          // round-trip and only happens when a save was actually interrupted.
          files = await scanVault(root, {
            metadata: needsMetadataNow,
            stopped: () => !isCurrentOpen(),
          });
          if (!isCurrentOpen()) return;
        }
        // Publish the catalog before reading unrelated documents. The selected
        // document uses its own read; the bounded corpus pass runs after open.

        // Load the vault's calendar events (calendar.json at the root), if any.
        let calendarEvents: CalEvent[] = [];
        const calFile = files.find((f) => f.relPath === CALENDAR_FILE);
        if (calFile) {
          try {
            calendarEvents = parseEvents(await readNote(calFile));
          } catch {
            /* ignore an unreadable calendar.json */
          }
        }
        if (!isCurrentOpen()) {
          return;
        }

        const name =
          root === DEMO_ROOT ? "Demo Vault" : root.split(/[\\/]/).pop() || root;
        let recentState: RecentVaultState | null = null;
        let recentWarning = "";
        if (IN_TAURI && root !== DEMO_ROOT) {
          try { recentState = await rememberRecentVaultNative(root); }
          catch (error) {
            if (!String(error).includes("not allowed") && !String(error).includes("main workspace")) recentWarning = " Recent vaults could not be saved.";
          }
          if (!isCurrentOpen()) return;
        }

        // Scanning leaves the outgoing editor mounted. Drain edits made during
        // that scan immediately before the synchronous state swap; after this
        // await, no user event can interleave before `set` replaces the old vault.
        try {
          await textSaves.flushAll();
        } catch {
          // This open superseded the previous vault's index pass.
          if (isCurrentOpen()) set({ loading: false, notesIndexPending: false });
          return;
        }
        if (!isCurrentOpen()) {
          return;
        }
        let resumeListening = false;
        if (get().vaultPath !== root) {
          try {
            resumeListening = await stopListening();
          } catch (error) {
            if (isCurrentOpen()) {
              set({ loading: false, notesIndexPending: false, syncStatus: `Could not stop the old vault listener: ${String(error)}` });
              const activeRoot = get().vaultPath;
              if (activeRoot && !unwatch) await setupWatcher(activeRoot).catch(() => { });
            }
            return;
          }
          if (!isCurrentOpen()) return;
        }

        const textFileCount = files.filter(isTextualVaultFile).length;
        set({
          vaultPath: root,
          vaultName: name,
          unavailableVault: null,
          recentVaults: recentState?.entries ?? get().recentVaults,
          currentRecentVaultId: recentState?.last ?? get().currentRecentVaultId,
          calendarEvents,
          files,
          notes: {},
          contentCache: {},
          openTabs: [],
          activePath: null,
          docSplit: { ...get().docSplit, other: null },
          content: "",
          activeContentState: "ready",
          emptyFolders: [],
          unindexedTextFiles: 0,
          skippedTextFiles: 0,
          failedTextFiles: 0,
          unreadableTextReasons: {},
          indexingTextFiles: textFileCount,
          notesIndexPending: textFileCount > 0,
          loading: false,
          status: `${files.length} files found. Indexing text…${recentWarning}${storageWarning ? ` ${storageWarning}` : ""}`,
        });
        if (resumeListening) {
          try {
            await startListening(root);
          } catch (error) {
            if (isCurrentOpen()) set({ syncListening: false, syncStatus: `Could not listen on the new vault: ${String(error)}` });
          }
        }
        markMesaPerf("vault-ready", {
          files: files.length,
          notes: 0,
          markdownFiles: files.filter((f) => f.isMarkdown).length,
        });

        const first = files.find((f) => f.isMarkdown);
        if (first) await get().selectFile(first.relPath);
        if (!isCurrentOpen()) return;

        // Stream the search-only text — and, when it was skipped, the file
        // metadata — in behind the now-usable UI.
        if (!needsMetadataNow) {
          void hydrateVaultMetadata(root, files, isCurrentOpen, get, set);
        }
        void (async () => {
          try {
            // A reopened vault shows its stored index at once; verification
            // below then patches only documents whose bytes changed.
            let provisional: { notes: Record<string, NoteMeta> } | null = null;
            const indexed = await loadIndexedNotes({
              onCached: (cached) => {
                if (!isCurrentOpen()) return;
                const current = get();
                const cache = forkContentCache(cached.cache);
                // The selected document and any watcher refresh own their bytes.
                for (const { rel } of documentEntries(current.contentCache)) cache[rel] = current.contentCache[rel];
                provisional = { notes: cached.notes };
                set({
                  contentCache: cache,
                  notes: { ...cached.notes, ...current.notes },
                  indexingTextFiles: cached.missing,
                  notesIndexPending: false,
                  status: `${Object.keys(cached.notes).length} documents loaded from the local index. Checking for changes…`,
                });
                markMesaPerf("index-cache-published", { files: Object.keys(cached.notes).length, missing: cached.missing });
              },
              root, files, stopped: () => !isCurrentOpen(),
              read: group => readVaultTextOutcomes(root, group),
              fingerprints: rels => IN_TAURI && rels.length
                ? invoke<(string | null)[]>("vault_text_fingerprints", { root, rels })
                : Promise.all(rels.map(async rel => {
                  const result = await readNoteResult(files.find(file => file.relPath === rel)!);
                  return result.ok ? fingerprintText(result.text) : null;
                })),
              onProgress: (completed, total) => {
                if (isCurrentOpen() && !provisional) set({ indexingTextFiles: total - completed });
              },
            });
            if (!isCurrentOpen()) return;
            const current = get();
            const shown = (provisional as { notes: Record<string, NoteMeta> } | null)?.notes;
            if (shown) {
              // Patch only re-read documents, unless an edit or watcher refresh
              // replaced that document after the stored index was shown.
              const changes: Record<string, string> = {};
              const changedNotes: Record<string, NoteMeta> = {};
              for (const [rel, text] of indexed.changed) {
                if (rel in shown && current.notes[rel] !== shown[rel]) continue;
                if (!(rel in shown) && rel in current.notes) continue;
                changes[rel] = text;
                if (indexed.notes[rel]) changedNotes[rel] = indexed.notes[rel];
              }
              const unreadable: Record<string, "skipped" | "failed"> = {};
              for (const rel of indexed.skipped) unreadable[rel] = "skipped";
              for (const rel of indexed.failed) unreadable[rel] = "failed";
              set({
                ...(Object.keys(changes).length ? {
                  contentCache: forkContentCache(current.contentCache, changes),
                  notes: { ...current.notes, ...changedNotes },
                } : {}),
                indexingTextFiles: 0,
                notesIndexPending: false,
                unindexedTextFiles: Object.keys(unreadable).length,
                skippedTextFiles: indexed.skipped.length,
                failedTextFiles: indexed.failed.length,
                unreadableTextReasons: unreadable,
                status: `${Object.keys(indexed.notes).length} documents indexed`,
              });
              markMesaPerf("search-index-ready", { files: Object.keys(indexed.notes).length, reused: indexed.reused, read: indexed.read });
              return;
            }
            const mergedCache = forkContentCache(indexed.cache);
            // A direct open, edit or watcher refresh during indexing owns its
            // current bytes. Copy only those newer records over the snapshot.
            for (const { rel } of documentEntries(current.contentCache))
              mergedCache[rel] = current.contentCache[rel];
            const unreadableTextReasons: Record<string, "skipped" | "failed"> = {};
            for (const rel of indexed.skipped) if (!(rel in mergedCache)) unreadableTextReasons[rel] = "skipped";
            for (const rel of indexed.failed) if (!(rel in mergedCache)) unreadableTextReasons[rel] = "failed";
            set({
              contentCache: mergedCache,
              notes: { ...indexed.notes, ...current.notes },
              indexingTextFiles: 0,
              notesIndexPending: false,
              unindexedTextFiles: Object.keys(unreadableTextReasons).length,
              skippedTextFiles: Object.values(unreadableTextReasons).filter(reason => reason === "skipped").length,
              failedTextFiles: Object.values(unreadableTextReasons).filter(reason => reason === "failed").length,
              unreadableTextReasons,
              status: `${Object.keys(indexed.notes).length} documents indexed`,
            });
            markMesaPerf("search-index-ready", { files: Object.keys(indexed.notes).length, reused: indexed.reused, read: indexed.read });
          } catch (error) {
            if (isCurrentOpen()) set({ indexingTextFiles: 0, notesIndexPending: false, status: `Text indexing failed: ${String(error)}` });
          }
        })();

        void setupWatcher(root);
        void setupActivityBridge();
        // Register the sync log/progress listener now — not just before a local
        // sync — so INCOMING syncs (this device receiving; `[serve]` lines from
        // the Rust server) fill the console too. Without this, the receiving
        // device dropped every event and showed no console at all.
        void ensureSyncEventBridge().catch((error) => set({ syncStatus: `Sync event setup failed: ${String(error)}` }));
      } catch (error) {
        if (!isCurrentOpen()) return;
        set({ loading: false, notesIndexPending: false, unavailableVault: { root, name: pendingName, reason: String(error) }, status: `Vault open failed: ${String(error)}. Reconnect the drive and retry.` });
        const previousRoot = get().vaultPath;
        if (previousRoot) void setupWatcher(previousRoot);
      }
    },

  };
  return {
    actions, get generation() { return vaultOpenGeneration; }, registerExternalFile, refreshMissingExternalFiles, scheduleExternalRefresh,
    dispose() { vaultOpenRequest++; vaultOpenGeneration++; watcherSetupGeneration++; clearTimeout(externalRefreshTimer); unwatch?.(); unwatch = undefined; }
  };
}
