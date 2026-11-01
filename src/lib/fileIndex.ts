import type { VaultFile } from "../types";

/** Identity-keyed file lookup. Rebuilds only when the store replaces `files`. */
export function createFileIndex() {
  let source: VaultFile[] | null = null;
  let index = new Map<string, VaultFile>();
  return (files: VaultFile[]): Map<string, VaultFile> => {
    if (source !== files) {
      source = files;
      index = new Map();
      // Preserve Array.find semantics if malformed input contains duplicates.
      for (const file of files) if (!index.has(file.relPath)) index.set(file.relPath, file);
    }
    return index;
  };
}

const relPathLists = new WeakMap<readonly VaultFile[], string[]>();
/** Relative paths of a `files` array, cached by array identity. Treat as read-only. */
export function relPathsOf(files: readonly VaultFile[]): string[] {
  let list = relPathLists.get(files);
  if (!list) {
    list = files.map((file) => file.relPath);
    relPathLists.set(files, list);
  }
  return list;
}

/** Linear scans of one relPath list before a folder set costs less than more scans. */
export const KNOWN_FOLDER_SCANS_BEFORE_SET = 16;
/** Whether `rel` is a folder that holds a listed path. Scans the list for the
 *  first few probes, then builds a folder set for that list identity. */
export function createKnownFolderCheck(): (rels: readonly string[], rel: string) => boolean {
  let source: readonly string[] | null = null;
  let probes = 0;
  let folders: Set<string> | null = null;
  return (rels, rel) => {
    if (source !== rels) {
      source = rels;
      probes = 0;
      folders = null;
    }
    if (!folders && ++probes > KNOWN_FOLDER_SCANS_BEFORE_SET) {
      folders = new Set();
      for (const known of rels) {
        for (let i = known.indexOf("/"); i >= 0; i = known.indexOf("/", i + 1)) folders.add(known.slice(0, i));
      }
    }
    if (folders) return folders.has(rel);
    const prefix = `${rel}/`;
    return rels.some((known) => known.startsWith(prefix));
  };
}
