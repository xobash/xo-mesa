import { bumpActivityAmount } from "../lib/activity";
import { forEachConcurrent } from "../lib/concurrency";
import { forkContentCache, moveCacheEntry } from "../lib/documentWorkingSet";
import { localISO } from "../lib/daily";
import { ancestorFolders, childRelPath, duplicateRelPath, splitRelPath } from "../lib/fsnames";
import { makeResolver, singleNoteMeta } from "../lib/graph";
import { STARTUP_TEXT_READ_CONCURRENCY } from "../lib/startupTextCache";
import { conflictBackupPath, reviewedConflictPath } from "../lib/syncConflicts";
import type { TextSaveCoordinator, TextSaveHold } from "../lib/textSaveCoordinator";
import {
  copyVaultFile, createFolder, createNote, importDroppedPaths, readNote, readNoteResult, readReviewText,
  removeFile, removeVaultEntry, renameVaultFile, writeVaultBinaryFile, writeVaultTextFile
} from "../lib/vault";
import type { VaultFile } from "../types";

import type { VaultPort } from "./vaultExternalFiles";
import type { AppState } from "../storeTypes";

interface Dependencies extends VaultPort {
  getGeneration: () => number;
  textSaves: TextSaveCoordinator<VaultFile>;
  reportingFailure: (label: string, run: () => Promise<void>) => Promise<void>;
  saveTextMutation: (file: VaultFile, content: string, expectedContent: string) => Promise<void>;
  clearTextSaveIssues: (keys: Iterable<string>) => boolean;
  addNote: (file: VaultFile, content: string) => void;
  registerExternalFile: (relPath: string, isCurrent: () => boolean) => Promise<void>;
}

/** Vault file mutations: create, duplicate, import, delete, overlay saves,
 *  mention links and conflict review. Each binds the vault root and open
 *  generation, touches the filesystem first, then merges into current state. */
export function createFileOpsController({
  get, set, getGeneration, textSaves, reportingFailure, saveTextMutation, clearTextSaveIssues, addNote, registerExternalFile,
}: Dependencies) {
  let activeImportAbort: AbortController | null = null;
  const actions: Pick<AppState,
    "saveConflictReview" | "newNote" | "createChildNote" | "saveOverlayArtifact" | "createChildFolder" | "duplicateEntry" |
    "linkUnlinkedMention" | "importDropped" | "cancelImport" | "deleteEntry"> = {
    saveConflictReview: async (root, rel, expected, content, copyRel) => {
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      if (!current() || get().syncBusy) throw new Error("Finish syncing and reopen this comparison before saving.");
      await textSaves.flushAll();
      if (!current()) throw new Error("The active vault changed. Reopen the comparison.");
      const file = get().fileFor(rel);
      if (!file?.isMarkdown && file?.ext !== "txt") throw new Error("Only Markdown and plain text can be merged here.");
      const disk = await readReviewText(file);
      if (!current() || disk !== expected || textSaves.isDirty(file.path)) {
        throw new Error("The original changed or could not be read. Reopen the comparison before saving.");
      }
      if (content === expected) return "No changes needed. Both copies were kept.";
      const backupRel = conflictBackupPath(rel, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      await writeVaultTextFile(root, backupRel, expected, { expectedMissing: true });
      if (!current()) throw new Error("The vault changed. The original was preserved; reopen the comparison.");
      await registerExternalFile(backupRel, current);
      if (!current() || textSaves.isDirty(file.path)) throw new Error("The original changed during review. Both copies were preserved.");
      textSaves.markDirty(file.path, file, content, expected);
      set({ contentCache: forkContentCache(get().contentCache, { [rel]: content }), ...(get().activePath === rel ? { content } : {}) });
      await textSaves.flush(file.path);
      let reviewedRel: string | null = null;
      if (copyRel) {
        const copy = get().fileFor(copyRel);
        if (copy) {
          const reviewedCopy = await renameVaultFile(root, copyRel, reviewedConflictPath(copyRel, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
          reviewedRel = reviewedCopy.relPath;
          if (current()) {
            const files = get().files.map((candidate) => candidate.relPath === copyRel ? reviewedCopy : candidate).sort((a, b) => a.relPath.localeCompare(b.relPath));
            const contentCache = forkContentCache(get().contentCache);
            moveCacheEntry(contentCache, copyRel, reviewedCopy.relPath);
            set({ files, contentCache });
          }
        }
      }
      return `Saved ${rel}. Previous text is in ${backupRel}; ${reviewedRel ? `the reviewed conflict copy is ${reviewedRel}.` : "the conflict copy was kept."}`;
    },

    newNote: async () => {
      const root = get().vaultPath;
      if (!root) return;
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      await reportingFailure("New note", async () => {
        const existing = new Set(get().files.map((f) => f.relPath.toLowerCase()));
        let rel = "Untitled.md";
        let n = 1;
        while (existing.has(rel.toLowerCase())) rel = `Untitled ${n++}.md`;
        const content = `# ${rel.replace(/\.md$/, "")}\n\n`;
        const file = await createNote(root, rel, content);
        if (!current()) return;
        addNote(file, content);
        await get().selectFile(file.relPath);
      });
    },

    // Right-click a folder → New note inside it.
    createChildNote: async (folderPath) => {
      const root = get().vaultPath;
      if (!root) return;
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      await reportingFailure("New note", async () => {
        const taken = get().files.map((f) => f.relPath);
        const rel = childRelPath(taken, folderPath, "Untitled", "md");
        const title = splitRelPath(rel).base;
        const file = await createNote(root, rel, `# ${title}\n\n`);
        if (!current()) return;
        addNote(file, `# ${title}\n\n`);
        // Expand the folder (and its ancestors) so the new note is visible, and
        // drop the folder from emptyFolders since it now has a file.
        const expand = { ...get().collapsedFolders };
        for (const a of [...ancestorFolders(rel), folderPath]) if (a) expand[a] = false;
        set({
          collapsedFolders: expand,
          emptyFolders: get().emptyFolders.filter((f) => f !== folderPath),
        });
        await get().selectFile(file.relPath);
      });
    },

    saveOverlayArtifact: async (kind, content, date, binding) => {
      const root = get().vaultPath;
      if (!root) {
        set({ status: "Open a vault before you save this item into it." });
        return null;
      }
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      if (binding && (binding.root !== root || binding.generation !== generation)) return null;
      const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "")
        ? date!
        : localISO();
      const extension = kind === "scratchpad" ? "md" : "mesa-board.json";
      const folder = kind === "scratchpad" ? "Scratchpad" : "Whiteboard";
      // Stable paths preserve editable daily notes and vector boards.
      const rel = kind === "scratchpad"
        ? `${folder}/${safeDate}.${extension}`
        : `${folder}/Board.${extension}`;
      let saved: VaultFile | undefined;
      let superseded = false;
      await reportingFailure(`Save ${kind} into vault`, async () => {
        if (typeof content === "string") {
          await textSaves.flushAll();
          if (!current()) return;
          const existing = get().fileFor(rel);
          const read = existing ? await readNoteResult(existing) : null;
          if (!current()) return;
          if (read && !read.ok) throw new Error("Could not read the existing overlay document.");
          const disk = read?.ok ? read.text : null;
          const expected = binding ? binding.expected : disk;
          if (disk !== expected) throw new Error("The vault document changed. Your overlay draft is preserved; review the disk copy before saving.");
          if (existing) {
            if (textSaves.isDirty(existing.path)) throw new Error("This document has newer editor changes. Your overlay draft is preserved; finish those changes before saving.");
            const cached = get().contentCache[rel];
            textSaves.markDirty(existing.path, existing, content, expected ?? "");
            await textSaves.flush(existing.path);
            superseded = get().contentCache[rel] !== cached;
            saved = existing;
          } else {
            saved = await writeVaultTextFile(root, rel, content, { expectedMissing: true });
          }
        } else {
          saved = await writeVaultBinaryFile(
            root,
            rel,
            content instanceof Uint8Array ? content : new Uint8Array(),
            { expectedMissing: true }
          );
        }
      });
      if (!saved || !current()) return null;
      if (superseded) return saved.relPath;
      if (saved.isMarkdown) {
        const existing = get().files.some((file) => file.relPath === saved!.relPath);
        if (existing) {
          const text = String(content);
          set({
            ...(get().activePath === saved.relPath ? { content: String(content) } : {}),
            notes: {
              ...get().notes,
              [saved.relPath]: singleNoteMeta(saved, text),
            },
            contentCache: forkContentCache(get().contentCache, { [saved.relPath]: text }),
            status: `Saved ${saved.relPath}.`,
          });
        } else addNote(saved, String(content));
      } else {
        const existing = get().files.some((file) => file.relPath === saved!.relPath);
        bumpActivityAmount(saved.relPath, 1.3, existing ? "edit" : "create");
        set({
          files: existing
            ? get().files
            : [...get().files, saved].sort((a, b) => a.relPath.localeCompare(b.relPath)),
          contentCache: typeof content === "string"
            ? forkContentCache(get().contentCache, { [saved.relPath]: content })
            : get().contentCache,
          status: `Saved ${saved.relPath}.`,
        });
      }
      return saved.relPath;
    },

    // Right-click a folder → New folder inside it. Empty folders aren't returned
    // by disk scans, so we track them in session state until they hold a file.
    createChildFolder: async (folderPath) => {
      const root = get().vaultPath;
      if (!root) return;
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      await reportingFailure("New folder", async () => {
        const taken = [
          ...get().files.map((f) => f.relPath),
          ...get().emptyFolders,
        ];
        const rel = childRelPath(taken, folderPath, "New folder");
        await createFolder(root, rel);
        if (!current()) return;
        const expand = { ...get().collapsedFolders };
        for (const a of [...ancestorFolders(rel), folderPath]) if (a) expand[a] = false;
        set({
          collapsedFolders: expand,
          emptyFolders: [...get().emptyFolders, rel],
        });
      });
    },

    // Duplicate any file (note or asset) next to itself with a " copy" name.
    duplicateEntry: async (relPath) => {
      const root = get().vaultPath;
      const file = get().fileFor(relPath);
      if (!root || !file) return;
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      await reportingFailure("Duplicate", async () => {
        const dest = duplicateRelPath(get().files.map((f) => f.relPath), relPath);
        const newFile = await copyVaultFile(root, relPath, dest);
        if (!current()) return;
        bumpActivityAmount(newFile.relPath, 1.0, "create");
        if (newFile.isMarkdown) {
          const text = await readNote(newFile);
          if (!current()) return;
          set({
            files: [...get().files, newFile].sort((a, b) =>
              a.relPath.localeCompare(b.relPath)
            ),
            notes: {
              ...get().notes,
              [newFile.relPath]: singleNoteMeta(newFile, text),
            },
            contentCache: forkContentCache(get().contentCache, { [newFile.relPath]: text }),
          });
          await get().selectFile(newFile.relPath);
        } else {
          set({
            files: [...get().files, newFile].sort((a, b) =>
              a.relPath.localeCompare(b.relPath)
            ),
          });
        }
      });
    },

    linkUnlinkedMention: async (sourceRel, mention, targetRel) => {
      const root = get().vaultPath;
      if (!root) return false;
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      let linked = false;
      await reportingFailure("Link mention", async () => {
        const { linkMention, linkTextFor } = await import("../lib/unlinkedMentions");
        const loaded = await get().ensureContent(sourceRel);
        if (!current()) return;
        const file = get().fileFor(sourceRel);
        const target = get().notes[targetRel];
        if (!file || !target) throw new Error(`${!file ? sourceRel : targetRel} is no longer available.`);
        const prev = get().contentCache[sourceRel] ?? loaded;
        const linkText = linkTextFor(targetRel, target.title, makeResolver(get().notes));
        if (linkText === null) throw new Error(`${targetRel} has a name a wiki link cannot hold (# | ^ [ ]).`);
        const content = linkMention(prev, mention, linkText);
        if (content === null) throw new Error(`${sourceRel} changed; refresh unlinked mentions and try again.`);
        set({
          content: get().activePath === sourceRel ? content : get().content,
          contentCache: forkContentCache(get().contentCache, { [sourceRel]: content }),
        });
        await saveTextMutation(file, content, prev);
        // A failed write stays dirty and is shown by the save-recovery UI.
        linked = !textSaves.isDirty(file.path);
      });
      return linked;
    },

    importDropped: async (paths) => {
      const root = get().vaultPath;
      if (!root) return;
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      // Report import failures so the progress message cannot remain visible.
      await reportingFailure("Import", async () => {
        activeImportAbort?.abort();
        const controller = new AbortController();
        activeImportAbort = controller;
        set({ status: "Importing…", importInProgress: true });
        let result;
        try {
          result = await importDroppedPaths(root, paths, {
            signal: controller.signal,
            onProgress: ({ completedSources, totalSources, current: importing }) => {
              if (current()) set({ status: `Importing ${completedSources}/${totalSources}: ${importing}` });
            },
          });
        } finally {
          if (activeImportAbort === controller) {
            activeImportAbort = null;
            set({ importInProgress: false });
          }
        }
        if (!current()) return;
        const { created, failures, cancelled } = result;
        if (created.length === 0) {
          if (cancelled) {
            set({ status: "Import cancelled before any files were copied." });
            return;
          }
          if (failures.length > 0) {
            throw new Error(
              failures.map(({ name, message }) => `${name}: ${message}`).join("; ")
            );
          }
          set({ status: `${Object.keys(get().notes).length} notes` });
          return;
        }
        // The watcher usually cached created notes already; read the rest with bounded concurrency.
        const loaded = new Map<string, string>();
        const unread = created.filter((f) => f.isMarkdown && !(f.relPath in get().contentCache));
        await forEachConcurrent(unread, STARTUP_TEXT_READ_CONCURRENCY, async (f) => {
          const text = await readNote(f);
          if (current()) loaded.set(f.relPath, text);
        }, () => !current());
        if (!current()) return;
        // A cache entry can leave while the reads run; never publish empty text for it.
        for (const f of created) {
          if (!f.isMarkdown || loaded.has(f.relPath) || f.relPath in get().contentCache) continue;
          const text = await readNote(f);
          if (!current()) return;
          loaded.set(f.relPath, text);
        }
        const files = [...get().files];
        const notes = { ...get().notes };
        const contentCache = forkContentCache(get().contentCache);
        const existing = new Set(files.map((f) => f.relPath));
        for (const f of created) {
          if (!existing.has(f.relPath)) {
            files.push(f);
            existing.add(f.relPath);
          }
          bumpActivityAmount(f.relPath, 1.0, "create");
          if (f.isMarkdown) {
            const text = contentCache[f.relPath] ?? loaded.get(f.relPath) ?? "";
            contentCache[f.relPath] = text;
            notes[f.relPath] = singleNoteMeta(f, text);
          }
        }
        files.sort((a, b) => a.relPath.localeCompare(b.relPath));
        set({
          files,
          notes,
          contentCache,
        });
        const finalStatus =
          (cancelled
            ? `Import cancelled after ${created.length} file${created.length > 1 ? "s" : ""}`
            : `Imported ${created.length} file${created.length > 1 ? "s" : ""}`) +
          (failures.length > 0
            ? `; ${failures.length} failed: ${failures
              .map(({ name, message }) => `${name}: ${message}`)
              .join("; ")}`
            : "");
        // A deliberate stop leaves the user in the current vault with a clear
        // partial result; it must not unexpectedly switch into a half-imported
        // archive folder.
        if (!cancelled && paths.length === 1 && /\.zip$/i.test(paths[0])) {
          const base =
            paths[0]
              .replace(/\\/g, "/")
              .split("/")
              .pop()
              ?.replace(/\.zip$/i, "") ?? "";
          const zipRoot = base ? `${root.replace(/\/+$/, "")}/${base}` : "";
          if (zipRoot && created.some((f) => f.relPath.startsWith(base + "/"))) {
            await get().openVault(zipRoot);
            set({ status: finalStatus });
            return;
          }
        }
        const firstMd = created.find((f) => f.isMarkdown);
        if (firstMd) await get().selectFile(firstMd.relPath);
        if (current()) set({ status: finalStatus });
      });
    },

    cancelImport: () => activeImportAbort?.abort(),

    deleteEntry: async (relPath) => {
      if (!(await get().confirmDiscardBinaryEdits([relPath], "Deleting it"))) return;
      const root = get().vaultPath;
      const file = get().fileFor(relPath);
      const prefix = relPath.replace(/\/+$/g, "") + "/";
      const matches = get().files.filter(
        (f) => f.relPath === relPath || f.relPath.startsWith(prefix)
      );
      // A folder with no files exists only in emptyFolders.
      const emptyFolder = get().emptyFolders.some((f) => f === relPath || f.startsWith(prefix));
      if (!root || (!file && matches.length === 0 && !emptyFolder)) return;
      const isFolder = !file;
      await reportingFailure("Delete", async () => {
        const keys = matches.map((entry) => entry.path);
        let saveHold: TextSaveHold<VaultFile> | undefined;
        try {
          // Hold child saves before awaiting removal; let in-flight writes settle.
          saveHold = await textSaves.hold(keys, false);
          if (file) await removeFile(file.path);
          else await removeVaultEntry(root, relPath, true);
          saveHold.discard();
          clearTextSaveIssues(keys);
        } catch (error) {
          saveHold?.release();
          throw error;
        }
        const removed = new Set(matches.map((f) => f.relPath));
        if (file) removed.add(relPath);
        const files = get().files.filter((f) => !removed.has(f.relPath));
        const notes = { ...get().notes };
        for (const rel of removed) delete notes[rel];
        const contentCache = forkContentCache(get().contentCache);
        for (const rel of removed) delete contentCache[rel];
        const tabs = get().openTabs.filter((t) => !removed.has(t));
        let active = get().activePath;
        let content = get().content;
        if (active && removed.has(active)) {
          active = tabs[tabs.length - 1] ?? null;
          content = active ? contentCache[active] ?? "" : "";
        }
        const docSplit = get().docSplit.other && removed.has(get().docSplit.other!)
          ? { ...get().docSplit, other: null }
          : get().docSplit;
        set({
          files,
          notes,
          contentCache,
          openTabs: tabs,
          activePath: active,
          content,
          docSplit,
          ...(isFolder ? { emptyFolders: get().emptyFolders.filter((f) => f !== relPath && !f.startsWith(prefix)) } : {}),
          status: `Moved ${isFolder ? "folder" : "file"} ${relPath} to Mesa recovery storage`,
        });
        if (active && contentCache[active] === undefined) void get().selectFile(active);
      });
    },
  };
  return { actions };
}
