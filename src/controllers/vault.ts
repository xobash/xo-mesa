import {
  parseEvents,
  type CalEvent
} from "../lib/daily";
import { documentEntries, forkContentCache } from "../lib/documentWorkingSet";
import {
  DEMO_ROOT,
  IN_TAURI,
  assertVaultRootAvailable,
  authorizeVaultRoot,
  baseName,
  canonicalRoot,
  isTextualVaultFile,
  pickVault,
  readNote,
  readNoteResult,
  readVaultTextOutcomes,
  recoverWriteArtifacts,
  scanVault,
  watchVault,
  type FoundArtifact,
  type VaultWatchEvent
} from "../lib/vault";
import { fingerprintText, loadIndexedNotes } from "../lib/vaultIndex";
import { hydrateVaultMetadata } from "../lib/vaultMetadata";
import type {
  NoteMeta,
  SortMode,
  VaultFile
} from "../types";

import { invoke } from "@tauri-apps/api/core";
import { markMesaPerf } from "../lib/mesaPerf";
import { rememberRecentVaultNative, type RecentVaultState } from "../lib/persistedUi";
import {
  resetVaultTaskMemo
} from "../lib/tasks";
import {
  TextSaveCoordinator
} from "../lib/textSaveCoordinator";

import type { AppState, UnreadableTextReason } from "../storeTypes";
import { CALENDAR_FILE, createExternalFiles, type VaultPort } from "./vaultExternalFiles";
import { createWatchBatchHandler, mergeWatchEvents } from "./vaultWatcher";
export { mergeWatchEvents } from "./vaultWatcher";
const SORT_MODES_NEEDING_METADATA = new Set<SortMode>(["modified", "size"]);
interface Dependencies extends VaultPort {
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
  const external = createExternalFiles({ get, set });
  const { registerExternalFile, refreshMissingExternalFiles, scheduleExternalRefresh, resolveActivityPath } = external;
  const handleExternalChange = createWatchBatchHandler({
    get, set, textSaves, external, currentGeneration: () => vaultOpenGeneration,
  });

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
        root === DEMO_ROOT ? "Demo Vault" : baseName(root);
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
          root === DEMO_ROOT ? "Demo Vault" : baseName(root);
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
              const unreadable: Record<string, UnreadableTextReason> = {};
              for (const rel of indexed.skipped) unreadable[rel] = "skipped";
              for (const rel of indexed.offline ?? []) unreadable[rel] = "offline";
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
            const unreadableTextReasons: Record<string, UnreadableTextReason> = {};
            for (const rel of indexed.skipped) if (!(rel in mergedCache)) unreadableTextReasons[rel] = "skipped";
            for (const rel of indexed.offline ?? []) if (!(rel in mergedCache)) unreadableTextReasons[rel] = "offline";
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
    actions, get generation() { return vaultOpenGeneration; }, registerExternalFile, refreshMissingExternalFiles, scheduleExternalRefresh, resolveActivityPath,
    dispose() { vaultOpenRequest++; vaultOpenGeneration++; watcherSetupGeneration++; external.cancelScheduledRefresh(); unwatch?.(); unwatch = undefined; }
  };
}
