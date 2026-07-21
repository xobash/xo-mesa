import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { VaultFile, NoteMeta, SortMode } from "../types";
import { getStore, useAppStore } from "../store";
import { fileComparator, folderComparator, type FolderAgg } from "../lib/sort";
import { clampFloatingMenuPosition } from "../lib/menuPosition";
import { ancestorFolders } from "../lib/fsnames";
import { previewEnter, previewLeave } from "./previewTriggers";
import { startFileDrag } from "./fileDrag";
import { hueFor } from "../lib/hue";

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: VaultFile;
  /** Aggregated stats for folders (undefined on file leaves). */
  agg?: FolderAgg;
}

type NodeCmp = (a: TreeNode, b: TreeNode) => number;

/** Stable stand-in subscribed when note metadata cannot affect the tree. */
const EMPTY_NOTES: Record<string, NoteMeta> = {};

/** Ensure a folder node exists for `path` (creating intermediates), returning it. */
function ensureFolderPath(root: TreeNode, path: string): TreeNode {
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

function buildTree(files: VaultFile[], emptyFolders: string[]): TreeNode {
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
function annotateAggregates(
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
function makeNodeCompare(
  mode: SortMode,
  dir: "asc" | "desc",
  foldersFirst: boolean,
  notes: Record<string, NoteMeta>
): NodeCmp {
  const sign = dir === "desc" ? -1 : 1;
  const fileCmp = fileComparator(mode, notes);
  const folderCmp = folderComparator(mode);
  const byName = (a: TreeNode, b: TreeNode) =>
    a.name.localeCompare(b.name, undefined, { numeric: true });
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

const sortedChildren = (node: TreeNode, cmp: NodeCmp): TreeNode[] =>
  [...node.children.values()].sort(cmp);

interface MenuState {
  rel: string;
  kind: "file" | "folder";
  name: string;
  x: number;
  y: number;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "true");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

function TreeItem({
  node,
  depth,
  renaming,
  cmp,
  onContext,
  onCommitRename,
  onCancelRename,
}: {
  node: TreeNode;
  depth: number;
  renaming: string | null;
  cmp: NodeCmp;
  onContext: (rel: string, kind: "file" | "folder", name: string, x: number, y: number) => void;
  onCommitRename: (rel: string, name: string) => void;
  onCancelRename: () => void;
}) {
  const activePath = useAppStore((s) => s.activePath);
  const openFile = useAppStore((s) => s.openFile);
  const collapsed = useAppStore((s) => s.collapsedFolders);
  const toggleFolder = useAppStore((s) => s.toggleFolder);
  const bookmarked = useAppStore((s) => s.settings.bookmarks.includes(node.path));
  const open = !node.file ? !collapsed[node.path] : true;

  if (node.file) {
    const rel = node.file.relPath;
    const file = node.file;
    const isActive = activePath === rel;
    const isOther = !node.file.isMarkdown;
    if (renaming === rel) {
      return (
        <input
          className="tree-rename"
          style={{ marginLeft: depth * 14 + 10 }}
          autoFocus
          defaultValue={node.name}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename(rel, (e.target as HTMLInputElement).value);
            else if (e.key === "Escape") onCancelRename();
          }}
          onBlur={(e) => onCommitRename(rel, e.target.value)}
        />
      );
    }
    return (
      <button
        className={
          "tree-file" +
          (isActive ? " active" : "") +
          (isOther ? " other" : "") +
          (bookmarked ? " bookmarked" : "")
        }
        data-rel={rel}
        style={{ paddingLeft: depth * 14 + 10 }}
        // pointer-drag: click opens in the editor; drag onto the center/right
        // pane (or out of the window) to open it there.
        onPointerDown={(e) =>
          startFileDrag(rel, e, () => {
            previewLeave();
            void openFile(rel);
          })
        }
        onMouseEnter={(e) =>
          previewEnter(
            { kind: "note", id: rel },
            e.currentTarget.getBoundingClientRect()
          )
        }
        onMouseLeave={previewLeave}
        onContextMenu={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.altKey) {
            await copyText(file.path);
            return;
          }
          onContext(rel, "file", node.name, e.clientX, e.clientY);
        }}
        title={node.path}
      >
        {bookmarked && <span className="tree-bookmark" aria-hidden="true">★</span>}
        <span className="tree-name">{node.name}</span>
        {isOther && (
          <span
            className="tree-ext"
            style={{
              color: `hsl(${hueFor(node.file.ext)} 45% 62%)`,
              borderColor: `hsl(${hueFor(node.file.ext)} 40% 55% / 0.4)`,
            }}
          >
            {node.file.ext}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="tree-folder-group">
      {node.name && (
        <button
          className={"tree-folder" + (bookmarked ? " bookmarked" : "")}
          style={{ paddingLeft: depth * 14 + 4 }}
          onClick={() => {
            previewLeave();
            toggleFolder(node.path);
          }}
          onMouseEnter={(e) =>
            previewEnter(
              { kind: "folder", path: node.path, title: node.name },
              e.currentTarget.getBoundingClientRect()
            )
          }
          onMouseLeave={previewLeave}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onContext(node.path, "folder", node.name, e.clientX, e.clientY);
          }}
        >
          <span className="caret">{open ? "▾" : "▸"}</span>
          {node.name}
          {bookmarked && <span className="tree-bookmark" aria-hidden="true">★</span>}
        </button>
      )}
      {open &&
        sortedChildren(node, cmp).map((c) => (
          <TreeItem
            key={c.path}
            node={c}
            depth={node.name ? depth + 1 : depth}
            renaming={renaming}
            cmp={cmp}
            onContext={onContext}
            onCommitRename={onCommitRename}
            onCancelRename={onCancelRename}
          />
        ))}
    </div>
  );
}

export function FileTree() {
  const files = useAppStore((s) => s.files);
  // Note metadata reaches the rendered tree ONLY through the "links" sort mode
  // (rawLinks counts feed the file comparator and folder aggregates). In every
  // other mode, subscribe to a stable empty map instead: the notes identity
  // churns on each debounced editor save (≤2 Hz while typing), and without
  // this pin that churn re-rendered and re-sorted the entire sidebar tree.
  // Event handlers that need real note titles read getStore() at event time.
  const notes = useAppStore((s) =>
    s.settings.sortMode === "links" ? s.notes : EMPTY_NOTES
  );
  const emptyFolders = useAppStore((s) => s.emptyFolders);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const activePath = useAppStore((s) => s.activePath);
  const enableTabs = useAppStore((s) => s.settings.enableTabs);
  const bookmarks = useAppStore((s) => s.settings.bookmarks);
  const revealTick = useAppStore((s) => s.revealTick);
  const collapsedFolders = useAppStore((s) => s.collapsedFolders);
  const setCollapsedFolders = useAppStore((s) => s.setCollapsedFolders);
  const openFile = useAppStore((s) => s.openFile);
  const openDocWindow = useAppStore((s) => s.openDocWindow);
  const deleteEntry = useAppStore((s) => s.deleteEntry);
  const renameNote = useAppStore((s) => s.renameNote);
  const duplicateEntry = useAppStore((s) => s.duplicateEntry);
  const toggleBookmark = useAppStore((s) => s.toggleBookmark);
  const createChildNote = useAppStore((s) => s.createChildNote);
  const createChildFolder = useAppStore((s) => s.createChildFolder);
  const fileFor = useAppStore((s) => s.fileFor);
  const sortMode: SortMode = useAppStore((s) => s.settings.sortMode);
  const sortDir = useAppStore((s) => s.settings.sortDir);
  const foldersFirst = useAppStore((s) => s.settings.foldersFirst);
  const typeFilter = useAppStore((s) => s.settings.typeFilter);
  // Apply the file-type filter before building the tree (folders with no
  // surviving descendants simply won't appear).
  const shownFiles = useMemo(
    () =>
      !typeFilter || typeFilter === "all"
        ? files
        : files.filter((f) => f.ext.toLowerCase() === typeFilter),
    [files, typeFilter]
  );
  const tree = useMemo(
    () => buildTree(shownFiles, emptyFolders),
    [shownFiles, emptyFolders]
  );
  // Folder aggregates depend on both structure and note metadata (link counts).
  useMemo(() => annotateAggregates(tree, notes), [tree, notes]);
  const cmp = useMemo(
    () => makeNodeCompare(sortMode, sortDir, foldersFirst, notes),
    [sortMode, sortDir, foldersFirst, notes]
  );
  const children = sortedChildren(tree, cmp);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  // Reveal active file: a one-shot triggered by the sidebar's ⌖ button (via
  // revealTick). Expand every folder on the path to the active file and scroll
  // it into view. Skips the very first mount so it only fires on real clicks.
  const revealMounted = useRef(false);
  useEffect(() => {
    if (!revealMounted.current) {
      revealMounted.current = true;
      return;
    }
    if (!activePath) return;
    const ancestors = ancestorFolders(activePath);
    let changed = false;
    const next = { ...collapsedFolders };
    for (const a of ancestors) {
      if (next[a]) {
        next[a] = false;
        changed = true;
      }
    }
    if (changed) setCollapsedFolders(next);
    const id = requestAnimationFrame(() => {
      const el = treeRef.current?.querySelector(
        `.tree-file[data-rel="${(window.CSS?.escape ?? ((s: string) => s))(activePath)}"]`
      );
      el?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(id);
    // Only react to the reveal trigger, not to activePath or collapse changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTick]);

  useLayoutEffect(() => {
    if (!menu || typeof window === "undefined") return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = clampFloatingMenuPosition(
      { x: menu.x, y: menu.y },
      { width: window.innerWidth, height: window.innerHeight },
      { width: rect.width, height: rect.height }
    );
    if (next.left !== menu.x || next.top !== menu.y) {
      setMenu({ ...menu, x: next.left, y: next.top });
    }
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  if (children.length === 0) {
    return <div className="tree-empty">No notes yet.</div>;
  }

  const absPath = (rel: string): string => {
    const f = fileFor(rel);
    if (f) return f.path;
    return vaultPath ? `${vaultPath.replace(/\/+$/, "")}/${rel}` : rel;
  };

  return (
    <div className="file-tree" ref={treeRef}>
      {children.map((c) => (
        <TreeItem
          key={c.path}
          node={c}
          depth={0}
          renaming={renaming}
          cmp={cmp}
          onContext={(rel, kind, name, x, y) => setMenu({ rel, kind, name, x, y })}
          onCommitRename={(rel, name) => {
            setRenaming(null);
            if (name && name !== getStore().notes[rel]?.title)
              void renameNote(rel, name);
          }}
          onCancelRename={() => setRenaming(null)}
        />
      ))}

      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.kind === "folder" ? (
            <>
              <button
                className="context-item"
                onClick={() => {
                  void createChildNote(menu.rel);
                  setMenu(null);
                }}
              >
                New note
              </button>
              <button
                className="context-item"
                onClick={() => {
                  void createChildFolder(menu.rel);
                  setMenu(null);
                }}
              >
                New folder
              </button>
              <div className="context-sep" />
              <button
                className="context-item"
                onClick={() => {
                  toggleBookmark(menu.rel);
                  setMenu(null);
                }}
              >
                {bookmarks.includes(menu.rel) ? "Remove from bookmarks" : "Bookmark…"}
              </button>
              <button
                className="context-item"
                onClick={() => {
                  void copyText(menu.rel);
                  setMenu(null);
                }}
              >
                Copy path
              </button>
            </>
          ) : (
            <>
              {enableTabs && (
                <button
                  className="context-item"
                  onClick={() => {
                    void openFile(menu.rel);
                    setMenu(null);
                  }}
                >
                  Open in new tab
                </button>
              )}
              <button
                className="context-item"
                onClick={() => {
                  void openDocWindow(menu.rel);
                  setMenu(null);
                }}
              >
                Open in new window
              </button>
              <div className="context-sep" />
              <button
                className="context-item"
                onClick={() => {
                  void duplicateEntry(menu.rel);
                  setMenu(null);
                }}
              >
                Duplicate
              </button>
              <button
                className="context-item"
                onClick={() => {
                  toggleBookmark(menu.rel);
                  setMenu(null);
                }}
              >
                {bookmarks.includes(menu.rel) ? "Remove from bookmarks" : "Bookmark…"}
              </button>
              <button
                className="context-item"
                onClick={() => {
                  void copyText(absPath(menu.rel));
                  setMenu(null);
                }}
              >
                Copy path
              </button>
              <div className="context-sep" />
              <button
                className="context-item"
                onClick={() => {
                  setRenaming(menu.rel);
                  setMenu(null);
                }}
              >
                Rename…
              </button>
            </>
          )}
          <div className="context-sep" />
          <button
            className="context-item danger"
            onClick={() => {
              const title =
                menu.kind === "file"
                  ? getStore().notes[menu.rel]?.title ?? menu.name
                  : menu.name;
              const detail =
                menu.kind === "folder"
                  ? `Delete folder "${title}" and everything inside it? This cannot be undone.`
                  : `Delete "${title}"? This cannot be undone.`;
              setMenu(null);
              if (window.confirm(detail)) {
                void deleteEntry(menu.rel);
              }
            }}
          >
            Delete {menu.kind}
          </button>
        </div>
      )}
    </div>
  );
}
