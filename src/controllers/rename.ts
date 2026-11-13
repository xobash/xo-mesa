import { forkContentCache, moveCacheEntry } from "../lib/documentWorkingSet";
import { linkKey, safeBaseName, splitRelPath } from "../lib/fsnames";
import { makeResolver } from "../lib/graph";
import { normalizeRelativeTarget, referenceMayTarget, rewriteInboundLinks } from "../lib/linkRewrite";
import { extractAliases, extractLinks, extractLinksAndFirstImage, extractTags } from "../lib/markdownExtract";
import { isMarkdownPath } from "../lib/markdownCode";
import { migrateTextRevisionsAsync } from "../lib/textRevisionHistory";
import type { TextSaveCoordinator, TextSaveHold } from "../lib/textSaveCoordinator";
import { readNote, renameVaultFile, writeNote } from "../lib/vault";
import type { VaultFile } from "../types";

import type { VaultPort } from "./vaultExternalFiles";
import type { AppState } from "../storeTypes";

interface Dependencies extends VaultPort {
  getGeneration: () => number;
  textSaves: TextSaveCoordinator<VaultFile>;
}

/** Rename one entry without changing its extension or bytes, then move its
 *  history and rewrite inbound links with verified writes. */
export function createRenameController({ get, set, getGeneration, textSaves }: Dependencies) {
  const actions: Pick<AppState, "renameNote"> = {
    // Rename without changing extension or file bytes. Refresh note metadata and report failures through status.
    renameNote: async (relPath, newBaseName) => {
      if (!(await get().confirmDiscardBinaryEdits([relPath], "Renaming it"))) return;
      const file = get().fileFor(relPath);
      const root = get().vaultPath;
      if (!file || !root) return;
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      // Exact spelling from the path, so `Scan.PDF` keeps `.PDF`.
      const { dir, ext: realExt } = splitRelPath(relPath);
      const base = relPath.slice(dir.length);
      const typed =
        realExt && newBaseName.toLowerCase().endsWith("." + realExt.toLowerCase())
          ? newBaseName.slice(0, -(realExt.length + 1))
          : newBaseName;
      const clean = safeBaseName(typed);
      if (!clean) {
        set({ status: `Rename needs a file name that is valid on every platform.` });
        return;
      }
      // Wikilinks use # ^ [ ] as syntax, so a note named with them cannot be linked.
      if (file.isMarkdown && /[#^[\]]/.test(clean)) {
        set({ status: "Note names cannot contain # ^ [ or ] because links use them." });
        return;
      }
      const newRel = realExt ? `${dir}${clean}.${realExt}` : `${dir}${clean}`;
      if (newRel === relPath) return;
      if (get().fileFor(newRel)) {
        set({ status: `Rename refused: ${newRel} already exists.` });
        return;
      }
      // Inspect all Markdown references for explicit rename repair; rawLinks omits embeds.
      // Verify each source update against concurrent edits.
      const bareNameUnambiguous = get().files.filter(
        (candidate) => linkKey(`${candidate.name}.${candidate.ext}`) === linkKey(base)
      ).length === 1;
      const noteResolver = makeResolver(get().notes);
      const inboundFiles = get().files.filter((candidate) => {
        if (!candidate.isMarkdown || candidate.relPath === relPath) return false;
        const metadata = get().notes[candidate.relPath];
        // A v2 disposable index can briefly survive an interrupted upgrade.
        // Safely inspect that source once rather than miss a reference; v3
        // entries always carry `rawReferences`, so normal renames stay bounded
        // by actual candidate count instead of vault Markdown count.
        if (!metadata?.rawReferences) return true;
        const sourceDir = splitRelPath(candidate.relPath).dir.slice(0, -1);
        if (file.isMarkdown && metadata.rawLinks.some((link) =>
          noteResolver(link) === relPath ||
          noteResolver(normalizeRelativeTarget(sourceDir, link)) === relPath
        )) return true;
        return metadata.rawReferences.some((reference) =>
          referenceMayTarget(candidate.relPath, reference, relPath, bareNameUnambiguous)
        );
      });
      // Hold this identity across the OS rename. Existing edits are flushed to
      // establish the disk baseline; edits typed while rename is in flight stay
      // paused and move to the new absolute key after success.
      let saveHold: TextSaveHold<VaultFile> | undefined;
      let linkHold: TextSaveHold<VaultFile> | undefined;
      let historyMigrationFailed = false;
      let newFile: VaultFile;
      const linkUpdates: Array<{ file: VaultFile; before: string; after: string }> = [];
      try {
        saveHold = await textSaves.hold([file.path], true);
        if (inboundFiles.length) {
          try {
            linkHold = await textSaves.hold(inboundFiles.map((candidate) => candidate.path), true);
          } catch (error) {
            throw new Error(`pending edits in a note that links here could not be saved first (${String(error)}). Nothing was renamed.`);
          }
          for (const inbound of inboundFiles) {
            const before = get().contentCache[inbound.relPath] ?? await readNote(inbound);
            const { text, changed } = rewriteInboundLinks(
              inbound.relPath,
              before,
              relPath,
              newRel,
              noteResolver,
              file.isMarkdown,
              bareNameUnambiguous
            );
            if (changed) linkUpdates.push({ file: inbound, before, after: text });
          }
        }
        newFile = await renameVaultFile(root, relPath, newRel);
        saveHold.move(file.path, newFile.path, newFile);
      } catch (e) {
        saveHold?.release();
        linkHold?.release();
        if (current()) set({ status: `Rename failed: ${String(e)}` });
        return;
      }
      if (!current()) {
        linkHold?.release();
        return;
      }

      // Publish the new identity in the same task as the save-entry move, so
      // edits typed during history migration or link writes reach the new path.
      {
        const notes = { ...get().notes };
        const meta = notes[relPath];
        delete notes[relPath];
        const contentCache = forkContentCache(get().contentCache);
        moveCacheEntry(contentCache, relPath, newRel);
        if (newFile.isMarkdown) {
          const text = meta ? "" : contentCache[newRel] ?? "";
          notes[newRel] = {
            relPath: newRel,
            title: newFile.name,
            rawLinks: meta?.rawLinks ?? extractLinks(text),
            ...(meta?.rawReferences ? { rawReferences: meta.rawReferences } : {}),
            tags: meta?.tags ?? extractTags(text),
            aliases: meta?.aliases ?? extractAliases(text),
            firstImagePath: meta?.firstImagePath,
          };
        }
        const files = get()
          .files.filter((f) => f.relPath !== relPath)
          .concat(newFile)
          .sort((a, b) => a.relPath.localeCompare(b.relPath));
        const openTabs = get().openTabs.map((t) => (t === relPath ? newRel : t));
        const activePath = get().activePath === relPath ? newRel : get().activePath;
        const docSplit = get().docSplit.other === relPath ? { ...get().docSplit, other: newRel } : get().docSplit;
        set({ files, notes, contentCache, openTabs, activePath, docSplit, status: `Renaming ${relPath}…` });
        const bookmarks = get().settings.bookmarks;
        if (bookmarks.includes(relPath)) {
          get().setSetting("bookmarks", bookmarks.map((b) => (b === relPath ? newRel : b)));
        }
      }

      // Revision history is independent from the verified filesystem rename.
      // A storage failure must not undo the completed rename, but the user
      // must not lose the identity silently.
      try {
        if (!(await migrateTextRevisionsAsync(root, relPath, newRel))) historyMigrationFailed = true;
      } catch {
        historyMigrationFailed = true;
      }

      const appliedLinkUpdates: typeof linkUpdates = [];
      const editedDuringRename: string[] = [];
      // Text typed while the rename ran is newer than `before`; never replace it.
      const editedSince = (update: (typeof linkUpdates)[number]) => {
        const current = get().contentCache[update.file.relPath];
        return textSaves.isDirty(update.file.path) || (current !== undefined && current !== update.before);
      };
      let linkUpdateError: string | null = null;
      try {
        for (const update of linkUpdates) {
          if (!current()) break;
          if (editedSince(update)) {
            editedDuringRename.push(update.file.relPath);
            continue;
          }
          await writeNote(update.file, update.after, update.before);
          appliedLinkUpdates.push(update);
        }
      } catch (error) {
        linkUpdateError = String(error);
      } finally {
        linkHold?.release();
      }
      if (!current()) return;

      const notes = { ...get().notes };
      const contentCache = forkContentCache(get().contentCache);
      let activeContent: string | undefined;
      for (const update of appliedLinkUpdates) {
        // Edits typed during the write keep their text; their save then reports the changed disk copy.
        if (editedSince(update)) continue;
        contentCache[update.file.relPath] = update.after;
        if (get().activePath === update.file.relPath) activeContent = update.after;
        notes[update.file.relPath] = {
          relPath: update.file.relPath,
          title: update.file.name,
          rawLinks: extractLinks(update.after, isMarkdownPath(update.file.relPath)),
          rawReferences: extractLinksAndFirstImage(update.after, isMarkdownPath(update.file.relPath)).references,
          tags: extractTags(update.after, isMarkdownPath(update.file.relPath)),
          aliases: extractAliases(update.after),
        };
      }
      set({
        ...(appliedLinkUpdates.length ? { notes, contentCache } : {}),
        ...(activeContent !== undefined ? { content: activeContent } : {}),
        status: historyMigrationFailed
          ? `Renamed ${relPath}, but local revision history could not move.`
          : linkUpdateError
            ? `Renamed ${relPath}, but updating inbound links stopped: ${linkUpdateError}`
            : editedDuringRename.length
              ? `Renamed ${relPath}; links in ${editedDuringRename.join(", ")} were not updated because ${editedDuringRename.length === 1 ? "it was" : "they were"} being edited.`
              : appliedLinkUpdates.length
                ? `Renamed ${relPath} and updated ${appliedLinkUpdates.length} inbound ${appliedLinkUpdates.length === 1 ? "link" : "links"}`
                : `Renamed ${relPath}`,
      });
    },
  };
  return { actions };
}
