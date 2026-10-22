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
