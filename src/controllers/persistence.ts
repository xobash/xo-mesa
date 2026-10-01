import {
  parseEvents
} from "../lib/daily";
import { compactDocument, forkContentCache } from "../lib/documentWorkingSet";
import { buildNotes, refreshedNoteMeta } from "../lib/graph";
import {
  listTextRevisionsAsync,
  purgeTextRevisionAsync,
  recordTextRevisionAsync
} from "../lib/textRevisionHistory";
import {
  IN_TAURI,
  flushableNoteText,
  isTextualVaultFile,
  readNote,
  readNoteResult,
  restoreRecoveryEntry,
  writeNote
} from "../lib/vault";
import type {
  VaultFile
} from "../types";

import { readTextFile as readTextFileStrict } from "@tauri-apps/plugin-fs";
import { createSaveIssueHelpers } from "../lib/saveIssues";
import {
  TextSaveCoordinator,
  type TextSaveHold,
} from "../lib/textSaveCoordinator";

import type { StoreApi } from "zustand";
import type { AppState } from "../store";
type Port = { get: () => AppState; set: StoreApi<AppState>["setState"] };

const CALENDAR_FILE = "calendar.json";
interface Dependencies extends Port {
  refreshMissingExternalFiles: (root: string, isCurrent?: () => boolean) => Promise<void>;
  getGeneration: () => number;
}
export function createPersistenceController({ get, set, getGeneration, refreshMissingExternalFiles }: Dependencies) {
  const { reportingFailure, recordTextSaveIssue, clearTextSaveIssues, setTextSaveIssueBusy } = createSaveIssueHelpers({ get, set });

  // Unsaved editor text belongs to a filesystem path, not to whichever tab is
  // active when a shared timer fires. The coordinator keeps one dirty record
  // per absolute path, serializes writes, and carries the exact disk baseline
  // into verifiedWrite's optimistic-concurrency check.
  const textSaves = new TextSaveCoordinator<VaultFile>({
    delayMs: 500,
    onStateChange: (textSaveState) => set({ textSaveState }),
    write: async ({ key, target, content, expectedContent }) => {
      const file = get().fileFor(target.relPath);
      if (!file || file.path !== key) {
        throw new Error(
          `Save target changed before ${target.relPath} could be written.`
        );
      }
      const pending = flushableNoteText(file, content);
      if (pending === null) {
        throw new Error(`Refusing to save non-text file ${target.relPath}.`);
      }
      const historyRoot = get().vaultPath ?? "";
      await writeNote(file, pending, expectedContent);
      if (pending !== expectedContent) {
        // History is deliberately outside the verified-save transaction. A
        // full browser quota must never make the already-read-back vault write
        // appear failed or leave this dirty entry queued for a duplicate save.
        queueMicrotask(() => {
          void recordTextRevisionAsync(historyRoot, target.relPath, expectedContent).then((revision) => {
            if (!revision) set({ status: `Saved ${target.relPath}, but revision history is unavailable.` });
          });
        });
      }
      const resolvedIssue = clearTextSaveIssues([key]);
      if (
        resolvedIssue &&
        (get().status.startsWith(`Save failed for ${target.relPath}:`) ||
          get().status.startsWith(`Use disk copy failed for ${target.relPath}:`))
      ) {
        set({ status: `Saved ${target.relPath}.` });
      }

      // Publish extracted graph metadata only for the revision still shown in
      // the cache. A newer edit can arrive while the verified write is in
      // flight; publishing the older snapshot would briefly regress the graph.
      if (get().contentCache[file.relPath] !== content) return;
      const cur = get().notes[file.relPath];
      compactDocument(get().contentCache, file.relPath, content);
      const next = cur ? refreshedNoteMeta(cur, content)
        : buildNotes(get().files, new Map([[file.relPath, content]]), new Set([file.relPath]))[file.relPath];
      if (next) set({ notes: { ...get().notes, [file.relPath]: next } });
    },
    onError: ({ key, target }, error) => {
      recordTextSaveIssue(key, target.relPath, String(error));
      set({ status: `Save failed for ${target.relPath}: ${String(error)}` });
    },
  });

  // Calendar and task controls edit vault text outside CodeMirror. Send those
  // mutations through the same per-path queue so they cannot race a pending
  // editor save or overwrite bytes changed by another process. A failure stays
  // dirty and is already exposed through the shared save-recovery UI.
  const saveTextMutation = async (
    file: VaultFile,
    content: string,
    expectedContent: string
  ): Promise<void> => {
    textSaves.markDirty(file.path, file, content, expectedContent);
    try {
      await textSaves.flush(file.path);
    } catch {
      // `onError` records the path and exact failure for retry/recovery.
    }
  };

  const actions: Pick<AppState, 'flushSave' | 'retryTextSaveIssue' | 'useDiskTextForSaveIssue' | 'listActiveTextRevisions' | 'restoreTextRevision' | 'purgeTextRevision' | 'restoreRecoveryEntry'> = {
    flushSave: () => {
      return textSaves.flushAll();
    },

    retryTextSaveIssue: async (key) => {
      const issue = get().textSaveIssues[key];
      if (!issue || issue.busy) return;
      if (!textSaves.isDirty(key)) {
        set({
          status:
            `Retry unavailable for ${issue.relPath}; use the disk copy action ` +
            "to resolve the uncertain file state.",
        });
        return;
      }
      setTextSaveIssueBusy(key, "retry");
      try {
        await textSaves.flush(key);
        if (!textSaves.isDirty(key)) {
          clearTextSaveIssues([key]);
          set({ status: `Saved ${issue.relPath}.` });
        }
      } catch {
        // The coordinator records the current failure and keeps the path dirty.
      } finally {
        setTextSaveIssueBusy(key, null);
      }
    },

    useDiskTextForSaveIssue: async (key) => {
      const issue = get().textSaveIssues[key];
      if (!issue || issue.busy) return;
      setTextSaveIssueBusy(key, "disk");
      let saveHold: TextSaveHold<VaultFile> | undefined;
      try {
        // Pause before reading so edits made during the read are included in
        // the confirmation and cannot race a write under the same path.
        saveHold = await textSaves.hold([key], false);
        const file = get().files.find((candidate) => candidate.path === key);
        if (!file || !isTextualVaultFile(file)) {
          throw new Error(`The text file is no longer available: ${issue.relPath}`);
        }
        // `readNote` intentionally converts native read errors to empty text
        // for ordinary previews. Conflict resolution must fail closed instead:
        // an unreadable file is never treated as an empty disk copy.
        const diskText = IN_TAURI
          ? await readTextFileStrict(file.path)
          : await readNote(file);
        const confirmed =
          typeof window !== "undefined" &&
          window.confirm(
            `Use the disk copy of "${file.relPath}"?\n\n` +
            "This replaces Mesa's unsaved changes and cannot be undone."
          );
        if (!confirmed) {
          saveHold.release();
          saveHold = undefined;
          setTextSaveIssueBusy(key, null);
          set({ status: `Kept local changes for ${file.relPath}.` });
          return;
        }

        const current = get().files.find((candidate) => candidate.path === key);
        if (!current || current.relPath !== file.relPath) {
          throw new Error(`The text file changed while it was being reloaded.`);
        }
        const currentMeta = get().notes[file.relPath];
        const nextMeta = currentMeta
          ? refreshedNoteMeta(currentMeta, diskText)
          : null;

        // The synchronous state commit follows immediately after discard, so
        // no event can observe an unpaused dirty entry with stale local text.
        saveHold.discard();
        saveHold = undefined;
        set((state) => {
          const nextIssues = { ...state.textSaveIssues };
          delete nextIssues[key];
          return {
            content:
              state.activePath === file.relPath ? diskText : state.content,
            contentCache: forkContentCache(state.contentCache, { [file.relPath]: diskText }),
            notes: nextMeta
              ? { ...state.notes, [file.relPath]: nextMeta }
              : state.notes,
            calendarEvents:
              file.relPath === CALENDAR_FILE
                ? parseEvents(diskText)
                : state.calendarEvents,
            textSaveIssues: nextIssues,
            status: `Loaded disk copy for ${file.relPath}.`,
          };
        });
      } catch (error) {
        saveHold?.release();
        recordTextSaveIssue(
          key,
          issue.relPath,
          `Use disk copy failed: ${String(error)}`
        );
        set({
          status: `Use disk copy failed for ${issue.relPath}: ${String(error)}`,
        });
      }
    },
    listActiveTextRevisions: async () => {
      const root = get().vaultPath;
      const active = get().activePath;
      const file = active ? get().fileFor(active) : null;
      if (!root || !active || !file || !isTextualVaultFile(file)) return [];
      return listTextRevisionsAsync(root, active);
    },
    restoreTextRevision: async (revisionId) => {
      const root = get().vaultPath;
      const active = get().activePath;
      const file = active ? get().fileFor(active) : null;
      if (!root || !active || !file || !isTextualVaultFile(file)) {
        throw new Error("Open a text file before restoring a revision.");
      }
      const generation = getGeneration();
      const current = () => get().vaultPath === root && get().activePath === active && getGeneration() === generation;
      await textSaves.flushAll();
      if (!current()) throw new Error("The document changed during recovery.");
      const revision = (await listTextRevisionsAsync(root, active)).find((entry) => entry.id === revisionId);
      if (!revision) throw new Error("That revision is no longer available.");
      const read = await readNoteResult(file);
      if (!current()) throw new Error("The document changed during recovery.");
      if (!read.ok) throw new Error("Could not read the document; no revision was restored.");
      const disk = read.text;
      textSaves.markDirty(file.path, file, revision.content, disk);
      set({
        contentCache: forkContentCache(get().contentCache, { [active]: revision.content }),
        content: revision.content,
        status: `Restoring ${active} from local revision history…`,
      });
      await textSaves.flush(file.path);
      if (current()) set({ status: `Restored ${active} from local revision history.` });
    },
    purgeTextRevision: async (revisionId) => {
      const root = get().vaultPath;
      const active = get().activePath;
      if (!root || !active) throw new Error("Open a text file before removing a revision.");
      if (!(await purgeTextRevisionAsync(root, active, revisionId))) {
        throw new Error("That revision is no longer available.");
      }
      set({ status: `Removed one local revision for ${active}.` });
    },
    restoreRecoveryEntry: async (entry) => {
      const root = get().vaultPath;
      if (!root) throw new Error("Open a vault before restoring recovery storage.");
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      await textSaves.flushAll();
      if (!current()) throw new Error("The vault changed during recovery.");
      const restored = await restoreRecoveryEntry(root, entry);
      if (current()) {
        await refreshMissingExternalFiles(root, current);
        if (current()) set({ status: `Restored ${restored.relPath} from recovery storage.` });
      }
      return restored;
    },

  };
  return { actions, textSaves, saveTextMutation, reportingFailure, clearTextSaveIssues };
}
