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
import { extractAliases, extractLinks, extractTags } from "../lib/markdownExtract";
import {
  DEMO_ROOT,
  IN_TAURI,
  assertVaultRootAvailable,
  authorizeVaultRoot,
  canonicalRoot,
  extOf,
  isIndexableVaultRelPath,
  isTextualVaultFile,
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
import { recordTextRevisionAsync } from "../lib/textRevisionHistory";
import { fingerprintText, loadIndexedNotes } from "../lib/vaultIndex";
import { hydrateVaultMetadata } from "../lib/vaultMetadata";
import type {
  NoteMeta,
  SortMode,
  VaultFile
} from "../types";

import { invoke } from "@tauri-apps/api/core";
import { stat } from "@tauri-apps/plugin-fs";
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
    const base = rel.replace(/.*\//, "");
    const ext = extOf(base);
    const isMarkdown = /^(md|markdown)$/i.test(ext);
    const path = `${root.replace(/\/+$/, "")}/${rel}`;
    const name = stripExt(base);
    const file: VaultFile = { path, relPath: rel, name, ext, isMarkdown };
    if (isTextualVaultFile(file)) {
      let content = "";
      try {
        content = await readNote(file);
      } catch {
        /* may not exist on disk yet (create announced before write) */
      }
      if (get().fileFor(rel) || !isCurrent()) return; // lost a race — already added
      set({
        files: [...get().files, file].sort((a, b) =>
          a.relPath.localeCompare(b.relPath)
        ),
        notes: {
          ...get().notes,
          [rel]: {
            relPath: rel,
            title: name,
            rawLinks: extractLinks(content),
            tags: extractTags(content),
            aliases: extractAliases(content),
            firstImagePath: undefined,
          },
        },
        contentCache: forkContentCache(get().contentCache, { [rel]: content }),
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
          a.relPath.localeCompare(b.relPath)
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
    const textAdditions = additions.filter(isTextualVaultFile);
    // An external create storm can contain thousands of text files. Keep
    // the final state commit atomic, but bound the reads and decoded strings
    // held by the ingestion pass so a watcher/activity burst cannot create one
    // Promise and one full document buffer per file.
    await forEachConcurrent(
      textAdditions,
      STARTUP_TEXT_READ_CONCURRENCY,
      async (f) => {
        const text = await readNote(f);
        if (!isCurrent()) return;
        nextCache[f.relPath] = text;
        nextNotes[f.relPath] = {
          relPath: f.relPath,
          title: f.name,
          rawLinks: extractLinks(text),
          tags: extractTags(text),
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
    for (const file of remaining) {
      if (!(file.relPath in cache) && file.relPath in nextCache) cache[file.relPath] = nextCache[file.relPath];
      if (!(file.relPath in notes) && file.relPath in nextNotes) notes[file.relPath] = nextNotes[file.relPath];
    }
    set({
      files: [...current.files, ...remaining].sort((a, b) => a.relPath.localeCompare(b.relPath)),
      notes,
      contentCache: cache,
    });
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

  // Remove a file from all relevant state maps when it's deleted externally.
  function removeExternalFile(rel: string): void {
    const files = get().files.filter((f) => f.relPath !== rel);
    const notes = { ...get().notes };
    delete notes[rel];
    const contentCache = forkContentCache(get().contentCache);
    delete contentCache[rel];
    const openTabs = get().openTabs.filter((t) => t !== rel);
    let activePath = get().activePath;
    const wasActive = activePath === rel;
    if (wasActive) activePath = null;
    set({
      files,
      notes,
      contentCache,
      openTabs,
      activePath,
      ...(wasActive ? { content: "" } : {}),
      ...(rel === CALENDAR_FILE ? { calendarEvents: [] } : {}),
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
    const pendingContent = new Map<string, string>();
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
    const flush = () => {
      if (!isCurrent()) return;
      if (!pendingContent.size && !pendingNotes.size && !filesDirty) return;
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
      for (const evt of events) {
        for (const p of evt.paths) {
          watcherPaths++;
          if (!isCurrent()) return;
          // Cheap form first: a path under the vault root resolves on the
          // root-prefix branch without the list being read at all.
          let rel = normalizeVaultRelPath(p, rootRaw);
          if (!rel) rel = normalizeVaultRelPath(p, rootRaw, knownRels());
          if (!rel) {
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
            const removedFile = get().fileFor(rel);
            if (removedFile) {
              if (textSaves.isDirty(removedFile.path)) {
                set({
                  status:
                    `File deleted outside Mesa; unsaved text was kept for ${rel}.`,
                });
              } else {
                removeExternalFile(rel);
              }
            }
            continue;
          }

          // --- Create or Modify ---
          let file = get().fileFor(rel);
          if (!file) {
            // a brand-new file appeared on disk — register it
            await registerExternalFile(rel, isCurrent);
            if (!isCurrent()) return;
            file = get().fileFor(rel);
            if (!file) {
              await rescanOnce();
              if (!isCurrent()) return;
              file = get().fileFor(rel);
            }
            scheduleExternalRefresh(rootRaw, isCurrent);
            if (file) {
              let detail = "";
              let added = 0;
              if (isTextualVaultFile(file)) {
                watcherReads++;
                const startedAt = performance.now();
                const text = await readNote(file).finally(() => {
                  watcherReadMs += performance.now() - startedAt;
                });
                if (!isCurrent()) return;
                detail = text.slice(0, 160);
                added = changedLineStats("", text).added;
              }
              bumpActivityAmount(rel, 1.3, "create", undefined, detail, {
                added,
                removed: 0,
              });
            }
            continue;
          }

          // Existing file — refresh content/metadata
          if (isTextualVaultFile(file)) {
            watcherReads++;
            const startedAt = performance.now();
            const read = await readNoteResult(file).finally(() => {
              watcherReadMs += performance.now() - startedAt;
            });
            if (!isCurrent()) return;
            if (!read.ok) {
              set({ status: `External change could not be read; keeping cached content for ${rel}.` });
              continue;
            }
            const text = read.text;
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
              let preserved = false;
              if (get().contentCache[rel] !== undefined) {
                preserved = Boolean(await recordTextRevisionAsync(rootRaw, rel, old));
                if (!isCurrent()) return;
              }
              if (textSaves.isDirty(file.path)) {
                set({ status: `File changed outside Mesa; unsaved text was kept for ${rel}.` });
                continue;
              }
              set({ status: `File changed outside Mesa: ${rel}. ${preserved ? "Previous text kept in document history." : "Previous text history is unavailable."}` });
              const cur = get().notes[rel];
              if (cur) {
                pendingNotes.set(rel, {
                  ...cur,
                  rawLinks: extractLinks(text),
                  tags: extractTags(text),
                  aliases: extractAliases(text),
                });
              }
              pendingContent.set(rel, text);
            } else {
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
              const read = await readNoteResult(file).finally(() => {
                watcherReadMs += performance.now() - startedAt;
              });
              if (!isCurrent()) return;
              if (!read.ok) {
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
    } finally {
      // Applies whatever the batch got through even if a later path throws —
      // the per-file commits this replaced had that property too.
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
    const stop = await watchVault(root, (events) =>
      void handleExternalChange(events, root, generation)
    );
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
      // Do this before flushing the current editor, cancelling research, or
      // stopping its watcher. A failed switch must leave the current vault
      // fully operational; startup restore keeps the missing root selected in
      // an explicit retryable state instead of publishing a blank workspace.
      try {
        await authorizeVaultRoot(root);
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
          if (isCurrentOpen()) set({ loading: false });
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
              set({ loading: false, syncStatus: `Could not stop the old vault listener: ${String(error)}` });
              const activeRoot = get().vaultPath;
              if (activeRoot && !unwatch) await setupWatcher(activeRoot).catch(() => { });
            }
            return;
          }
          if (!isCurrentOpen()) return;
        }

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
          content: "",
          activeContentState: "ready",
          emptyFolders: [],
          unindexedTextFiles: 0,
          skippedTextFiles: 0,
          failedTextFiles: 0,
          unreadableTextReasons: {},
          indexingTextFiles: files.filter(isTextualVaultFile).length,
          loading: false,
          status: `${files.length} files found. Indexing text…${recentWarning}`,
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
            const indexed = await loadIndexedNotes({
              root, files, stopped: () => !isCurrentOpen(),
              read: group => readVaultTextOutcomes(root, group),
              fingerprints: rels => IN_TAURI && rels.length
                ? invoke<(string | null)[]>("vault_text_fingerprints", { root, rels })
                : Promise.all(rels.map(async rel => {
                  const result = await readNoteResult(files.find(file => file.relPath === rel)!);
                  return result.ok ? fingerprintText(result.text) : null;
                })),
              onProgress: (completed, total) => {
                if (isCurrentOpen()) set({ indexingTextFiles: total - completed });
              },
            });
            if (!isCurrentOpen()) return;
            const current = get();
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
              unindexedTextFiles: Object.keys(unreadableTextReasons).length,
              skippedTextFiles: Object.values(unreadableTextReasons).filter(reason => reason === "skipped").length,
              failedTextFiles: Object.values(unreadableTextReasons).filter(reason => reason === "failed").length,
              unreadableTextReasons,
              status: `${Object.keys(indexed.notes).length} documents indexed`,
            });
            markMesaPerf("search-index-ready", { files: Object.keys(indexed.notes).length, reused: indexed.reused, read: indexed.read });
          } catch (error) {
            if (isCurrentOpen()) set({ indexingTextFiles: 0, status: `Text indexing failed: ${String(error)}` });
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
        set({ loading: false, unavailableVault: { root, name: pendingName, reason: String(error) }, status: `Vault open failed: ${String(error)}. Reconnect the drive and retry.` });
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
