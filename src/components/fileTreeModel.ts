import type { VaultFile, NoteMeta, SortMode } from "../types";
import { compareNames, fileComparator, folderComparator, type FolderAgg } from "../lib/sort";

export interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: VaultFile;
  /** Aggregated stats for folders (undefined on file leaves). */
  agg?: FolderAgg;
}

export type NodeCmp = (a: TreeNode, b: TreeNode) => number;

/** Ensure a folder node exists for `path` (creating intermediates), returning it. */
export function ensureFolderPath(root: TreeNode, path: string): TreeNode {
  const parts = path.split("/");
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    let next = cur.children.get(seg);
    if (!next) {
      next = { name: seg, path: parts.slice(0, i + 1).join("/"), children: new Map() };
      cur.children.set(seg, next);
    }
    cur = next;
  }
  return cur;
}

export function buildTree(files: VaultFile[], emptyFolders: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const f of files) {
    // show every file (notes, images, PDFs, video, etc.), not just markdown
    const parts = f.relPath.split("/");
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const part = parts[i];
      if (isLeaf) {
        cur.children.set(part, {
          name: f.name,
          path: f.relPath,
          children: new Map(),
          file: f,
        });
      } else {
        let next = cur.children.get(part);
        if (!next) {
          next = { name: part, path: parts.slice(0, i + 1).join("/"), children: new Map() };
          cur.children.set(part, next);
        }
        cur = next;
      }
    }
  }
  // Folders created this session that don't yet contain a scanned file still
  // need to appear (disk scans don't return empty directories).
  for (const folder of emptyFolders) ensureFolderPath(root, folder);
  return root;
}

/**
 * Post-order pass that gives every folder node an `agg` summarizing its
 * descendants, so folders can be sorted by the active mode (newest child,
 * total size, total links) — not just alphabetically.
 */
export function annotateAggregates(
  node: TreeNode,
  notes: Record<string, NoteMeta>
): FolderAgg {
  let mtime = 0;
  let size = 0;
  let links = 0;
  for (const child of node.children.values()) {
    if (child.file) {
      mtime = Math.max(mtime, child.file.mtime ?? 0);
      size += child.file.size ?? 0;
      links += notes[child.file.relPath]?.rawLinks.length ?? 0;
    } else {
      const a = annotateAggregates(child, notes);
      mtime = Math.max(mtime, a.mtime);
      size += a.size;
      links += a.links;
    }
  }
  node.agg = { name: node.name, mtime, size, links };
  return node.agg;
}

/**
 * One comparator for the whole tree: handles files (by sort mode), folders (by
 * the same mode via aggregates), a direction flip, and either grouping folders
 * first or fully interleaving them with files.
 */
export function makeNodeCompare(
  mode: SortMode,
  dir: "asc" | "desc",
  foldersFirst: boolean,
  notes: Record<string, NoteMeta>
): NodeCmp {
  const sign = dir === "desc" ? -1 : 1;
  const fileCmp = fileComparator(mode, notes);
  const folderCmp = folderComparator(mode);
  const byName = (a: TreeNode, b: TreeNode) => compareNames(a.name, b.name);
  const metric = (n: TreeNode): number => {
    if (mode === "modified") return n.file ? n.file.mtime ?? 0 : n.agg?.mtime ?? 0;
    if (mode === "size") return n.file ? n.file.size ?? 0 : n.agg?.size ?? 0;
    if (mode === "links")
      return n.file ? notes[n.file.relPath]?.rawLinks.length ?? 0 : n.agg?.links ?? 0;
    return 0;
  };
  return (a, b) => {
    if (foldersFirst) {
      const af = a.file ? 1 : 0;
      const bf = b.file ? 1 : 0;
      if (af !== bf) return af - bf; // folders stay above files, either direction
    }
    let r: number;
    if (a.file && b.file) r = fileCmp(a.file, b.file);
    else if (!a.file && !b.file)
      r = a.agg && b.agg ? folderCmp(a.agg, b.agg) : byName(a, b);
    else if (mode === "name") r = byName(a, b);
    else if (mode === "type") {
      const at = a.file ? a.file.ext : "";
      const bt = b.file ? b.file.ext : "";
      r = at.localeCompare(bt) || byName(a, b);
    } else r = metric(b) - metric(a) || byName(a, b);
    return sign * r;
  };
}

export const sortedChildren = (node: TreeNode, cmp: NodeCmp): TreeNode[] =>
  [...node.children.values()].sort(cmp);

/** `sortedChildren` remembered per folder for one tree and comparator, so a
 * collapse toggle does not re-sort every expanded folder. */
export function childSorter(cmp: NodeCmp): (node: TreeNode) => TreeNode[] {
  const sorted = new WeakMap<TreeNode, TreeNode[]>();
  return (node) => {
    let children = sorted.get(node);
    if (!children) sorted.set(node, (children = sortedChildren(node, cmp)));
    return children;
  };
}

/** One visible row: the node plus the indent level it renders at. */
export interface FlatRow {
  node: TreeNode;
  depth: number;
}

/** Flatten expanded tree nodes in display order, excluding collapsed descendants. */
export function flattenRows(
  nodes: TreeNode[],
  depth: number,
  collapsed: Record<string, boolean>,
  children: (node: TreeNode) => TreeNode[],
  out: FlatRow[]
): void {
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (!n.file && !collapsed[n.path]) {
      flattenRows(children(n), depth + 1, collapsed, children, out);
    }
  }
}
