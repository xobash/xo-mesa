import {
  bumpActivityAmount,
  changedLineStats,
  changedSnippet
} from "../lib/activity";
import { stat } from "@tauri-apps/plugin-fs";
import { forEachConcurrent } from "../lib/concurrency";
import { parseEvents } from "../lib/daily";
import { forkContentCache } from "../lib/documentWorkingSet";
import { createKnownFolderCheck, relPathsOf } from "../lib/fileIndex";
import { refreshedNoteMeta } from "../lib/graph";
import { extractAliases, extractLinks, extractTags } from "../lib/markdownExtract";
import { isMarkdownPath } from "../lib/markdownCode";
import { markMesaPerf } from "../lib/mesaPerf";
import { invalidatePdfThumb } from "../lib/pdfThumbInvalidation";
import { STARTUP_TEXT_READ_CONCURRENCY } from "../lib/startupTextCache";
import { recordTextRevisionsAsync, type RevisionInput } from "../lib/textRevisionHistory";
import type { TextSaveCoordinator } from "../lib/textSaveCoordinator";
import {
  isIndexableVaultRelPath,
  isTextualVaultFile,
  isValidUtf8Text,
  needsCachedTextRefresh,
  normalizeVaultRelPath,
  toVaultFile,
  type VaultWatchEvent
} from "../lib/vault";
import type { NoteMeta, VaultFile } from "../types";
import type { AppState } from "../storeTypes";
import { CALENDAR_FILE, fileOrder, type ExternalFiles, type VaultPort } from "./vaultExternalFiles";

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

interface WatchBatchDependencies extends VaultPort {
  textSaves: TextSaveCoordinator<VaultFile>;
  external: ExternalFiles;
  /** The vault-open generation now; a batch for another generation is stale. */
  currentGeneration: () => number;
}

/** The watcher batch pipeline. Callers serialize batches per watcher. */
export function createWatchBatchHandler({ get, set, textSaves, external, currentGeneration }: WatchBatchDependencies) {
  const { readWatchedText, refreshMissingExternalFiles, removeExternalFiles, rescanAsEvents, scheduleExternalRefresh, vanishedFromDisk } = external;
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
      currentGeneration() === watcherGeneration;
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
    // Build alias-path lookup lists only when needed. `relPathsOf` caches by
    // files-array identity across batches, so path lookup indexes survive too.
    const knownRels = (): string[] => relPathsOf(get().files);
    // A create storm probes every new path; the check switches to a folder set.
    const knownFolder = createKnownFolderCheck();
    const isKnownFolder = (rel: string): boolean => knownFolder(knownRels(), rel);
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
            if (isKnownFolder(rel)) {
              const gone = await vanishedFromDisk(toVaultFile(rootRaw, rel).path);
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
            created.set(rel, toVaultFile(rootRaw, rel));
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
              // Unchanged metadata must not republish `notes`: a new identity
              // rebuilds the graph and backlink index for a prose-only edit.
              const cur = get().notes[rel];
              const meta = cur && refreshedNoteMeta(cur, text);
              if (meta) pendingNotes.set(rel, meta);
              else pendingNotes.delete(rel);
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
              const mtime = s.mtime ? new Date(s.mtime).getTime() : undefined;
              // An unchanged stat (xattr or access event) must not republish
              // `files`; re-render once for the batch, not once per file.
              if (file.size !== s.size || file.mtime !== mtime) {
                file.size = s.size;
                file.mtime = mtime;
                filesDirty = true;
              }
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
          const sorted = [...get().files, ...fresh].sort((a,b) => fileOrder(a.relPath,b.relPath));
          // Binary-only creates leave notes and text untouched; republishing
          // them would rebuild the graph and backlink index for nothing.
          if (fresh.some(file => texts.has(file.relPath))) {
            const notes = { ...get().notes };
            const cache = forkContentCache(get().contentCache);
            for (const file of fresh) {
              const text = texts.get(file.relPath);
              if (text === undefined) continue;
              cache[file.relPath] = text;
              notes[file.relPath] = { relPath: file.relPath, title: file.name, rawLinks: extractLinks(text, isMarkdownPath(file.relPath)), tags: extractTags(text, isMarkdownPath(file.relPath)), aliases: extractAliases(text), firstImagePath: undefined };
            }
            set({ files: sorted, notes, contentCache: cache });
          } else set({ files: sorted });
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

  return handleExternalChange;
}
