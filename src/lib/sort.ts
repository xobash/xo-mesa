import type { VaultFile, NoteMeta, SortMode } from "../types";

export type { SortMode };

export const SORT_LABELS: Record<SortMode, string> = {
  name: "Name (A–Z)",
  modified: "Date modified",
  size: "Size",
  links: "Links",
  type: "File type",
};

/** Comparator for sidebar files. Ties fall back to name for stable order. */
export function fileComparator(
  mode: SortMode,
  notes: Record<string, NoteMeta>
): (a: VaultFile, b: VaultFile) => number {
  const byName = (a: VaultFile, b: VaultFile) =>
    a.name.localeCompare(b.name, undefined, { numeric: true });
  const links = (f: VaultFile) => notes[f.relPath]?.rawLinks.length ?? 0;

  switch (mode) {
    case "modified":
      return (a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || byName(a, b);
    case "size":
      return (a, b) => (b.size ?? 0) - (a.size ?? 0) || byName(a, b);
    case "links":
      return (a, b) => links(b) - links(a) || byName(a, b);
    case "type":
      return (a, b) => a.ext.localeCompare(b.ext) || byName(a, b);
    case "name":
    default:
      return byName;
  }
}

/**
 * Aggregated stats for a folder, derived from all of its descendant files, so
 * folders can be ordered by the same sort mode the user picked for files
 * (newest child, total size, total links). Computed once per tree build.
 */
export interface FolderAgg {
  name: string;
  /** Newest mtime among descendants. */
  mtime: number;
  /** Total size of descendants (bytes). */
  size: number;
  /** Total outgoing links across descendant notes. */
  links: number;
}

/**
 * Comparator for folders, mirroring the file sort mode wherever it has a
 * meaningful folder analog. "type" has none (a folder has no extension), so it
 * falls back to name — same as "name". Ties always fall back to name for a
 * stable order.
 */
export function folderComparator(
  mode: SortMode
): (a: FolderAgg, b: FolderAgg) => number {
  const byName = (a: FolderAgg, b: FolderAgg) =>
    a.name.localeCompare(b.name, undefined, { numeric: true });
  switch (mode) {
    case "modified":
      return (a, b) => b.mtime - a.mtime || byName(a, b);
    case "size":
      return (a, b) => b.size - a.size || byName(a, b);
    case "links":
      return (a, b) => b.links - a.links || byName(a, b);
    case "type":
    case "name":
    default:
      return byName;
  }
}
