import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { VaultFile, NoteMeta, SortMode } from "../types";
import { getStore, useAppStore } from "../store";
import {
  compareNames,
  fileComparator,
  folderComparator,
  type FolderAgg,
} from "../lib/sort";
import { clampFloatingMenuPosition } from "../lib/menuPosition";
import { ancestorFolders } from "../lib/fsnames";
import {
  DEFAULT_ROW_HEIGHT,
  focusRowRange,
  scrollTopForRow,
  visibleRowRange,
  windowedRowIndices,
} from "../lib/treeWindow";
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

const sortedChildren = (node: TreeNode, cmp: NodeCmp): TreeNode[] =>
  [...node.children.values()].sort(cmp);

/** One visible row: the node plus the indent level it renders at. */
interface FlatRow {
  node: TreeNode;
  depth: number;
}

/**
 * The expanded tree as a flat, indexable row list — the same nodes in the same
 * order the recursive renderer produced, minus everything inside a collapsed
 * folder. Windowing needs an index per row, which a recursive render cannot
 * give it.
 */
function flattenRows(
  nodes: TreeNode[],
  depth: number,
  collapsed: Record<string, boolean>,
  cmp: NodeCmp,
  out: FlatRow[]
): void {
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (!n.file && !collapsed[n.path]) {
      flattenRows(sortedChildren(n, cmp), depth + 1, collapsed, cmp, out);
    }
  }
}

/** Nearest scrollable ancestor — the sidebar body the tree scrolls inside. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  let p = el?.parentElement ?? null;
  while (p) {
    const overflowY = getComputedStyle(p).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return p;
    p = p.parentElement;
  }
  return null;
}

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

/**
 * One rendered row. Everything it displays arrives as a PROP.
 *
 * Rows used to select their own booleans from the store. With every row in the
 * vault mounted that was the only way to avoid a whole-tree re-render, but it
 * meant ~20,800 live selectors on a 4,165-file vault, which made every `set()`
 * anywhere in the app cost 2.9 ms of subscriber fan-out — paid by every
 * keystroke, every activity blip and every PDF status change, and paid even
 * while the sidebar was closed, because it stays mounted by design. Windowing
 * mounts only ~35–48 rows, so `FileTree` can subscribe once and pass the
 * booleans down. Do NOT reintroduce per-row store subscriptions.
 */
const TreeRow = memo(function TreeRow({
  node,
  depth,
  isActive,
  isCollapsed,
  bookmarked,
  renaming,
  onOpen,
  onToggle,
  onContext,
  onCommitRename,
  onCancelRename,
  onFocus,
}: {
  node: TreeNode;
  depth: number;
  isActive: boolean;
  isCollapsed: boolean;
  bookmarked: boolean;
  renaming: boolean;
  onOpen: (rel: string) => void;
  onToggle: (path: string) => void;
  onContext: (rel: string, kind: "file" | "folder", name: string, x: number, y: number) => void;
  onCommitRename: (rel: string, name: string) => void;
  onCancelRename: () => void;
  onFocus: () => void;
}) {
  const open = node.file ? true : !isCollapsed;

  if (node.file) {
    const rel = node.file.relPath;
    const file = node.file;
    const isOther = !node.file.isMarkdown;
    if (renaming) {
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
        onFocus={onFocus}
        // pointer-drag: click opens in the editor; drag onto the center/right
        // pane (or out of the window) to open it there.
        onPointerDown={(e) =>
          startFileDrag(rel, e, () => {
            previewLeave();
            onOpen(rel);
          })
        }
        onKeyDown={(e) => {
          if (e.repeat || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          previewLeave();
          onOpen(rel);
        }}
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
    <>
      {node.name && (
        <button
          className={"tree-folder" + (bookmarked ? " bookmarked" : "")}
          style={{ paddingLeft: depth * 14 + 4 }}
          aria-expanded={open}
          onFocus={onFocus}
          onClick={() => {
            previewLeave();
            onToggle(node.path);
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
    </>
  );
});

/**
 * The sidebar tree, WINDOWED: the expanded tree is flattened into a row list
 * and only the rows covering the sidebar viewport — plus overscan, plus
 * whatever holds keyboard focus — are mounted.
 *
 * A real vault has thousands of entries, and mounting them all cost far more
 * than their own render. Measured on the 4,165-file vault: 13,102 DOM nodes,
 * 94.0 MB heap, and ~20,800 row selectors that made ANY store update cost
 * 2.97 ms of fan-out (3.86 ms for one editor keystroke) — whether or not the
 * sidebar was even visible, since it stays mounted by design. Windowed:
 * 917 DOM nodes, 78.1 MB, 0.045 ms fan-out, 0.74 ms per keystroke.
 *
 * `FileTree` takes no props, so `memo` makes parent re-renders free while its
 * own store subscriptions drive every update it needs. Three things keep this
 * correct, and all three are load-bearing:
 *  - rows are prop-driven (see `TreeRow`) — no per-row store subscriptions;
 *  - the container reserves the FULL row count × measured row height and
 *    positions each row by index, so the scrollbar and every scroll offset
 *    match a fully-mounted tree;
 *  - `focusRowRange` keeps the focused row and its Tab neighbours mounted, so
 *    keyboard reachability is exactly what it was with every row mounted.
 */
export const FileTree = memo(function FileTree() {
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
  const enableTabs = useAppStore((s) => s.settings.enableTabs);
  const bookmarks = useAppStore((s) => s.settings.bookmarks);
  const revealTick = useAppStore((s) => s.revealTick);
  // Subscribed ONCE here and passed to each row as a boolean — see `TreeRow`.
  const activePath = useAppStore((s) => s.activePath);
  const collapsedFolders = useAppStore((s) => s.collapsedFolders);
  const setCollapsedFolders = useAppStore((s) => s.setCollapsedFolders);
  const toggleFolder = useAppStore((s) => s.toggleFolder);
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
  // The visible tree as a flat, indexable row list — the same nodes in the same
  // order the recursive renderer produced, minus the ones inside collapsed
  // folders.
  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    flattenRows(sortedChildren(tree, cmp), 0, collapsedFolders, cmp, out);
    return out;
  }, [tree, cmp, collapsedFolders]);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  const [view, setView] = useState({
    scrollTop: 0,
    offset: 0,
    viewportHeight: 0,
  });
  // Index of the row that currently holds DOM focus, so Tab keeps reaching the
  // next/previous row even when both are scrolled out of the mounted window.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  // Track the sidebar's scroll geometry. Coalesced into one rAF so a fast
  // scroll re-windows once per frame instead of once per scroll event.
  useLayoutEffect(() => {
    const el = treeRef.current;
    const scroller = scrollerOf(el);
    scrollerRef.current = scroller;
    if (!el) return;
    if (!scroller) {
      // No scroll container (tests, or a sidebar laid out without one): render
      // every row rather than windowing against a viewport that doesn't exist.
      setView({ scrollTop: 0, offset: 0, viewportHeight: Number.POSITIVE_INFINITY });
      return;
    }
    let raf = 0;
    const measure = () => {
      raf = 0;
      const scrollTop = scroller.scrollTop;
      const offset =
        el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scrollTop;
      const viewportHeight = scroller.clientHeight;
      setView((prev) =>
        prev.scrollTop === scrollTop &&
        prev.offset === offset &&
        prev.viewportHeight === viewportHeight
          ? prev
          : { scrollTop, offset, viewportHeight }
      );
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    ro?.observe(scroller);
    window.addEventListener("resize", schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      scroller.removeEventListener("scroll", schedule);
      ro?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [rows.length]);

  // Measure a real row rather than trusting the constant: the reserved height
  // and every row's `top` are derived from it, so a theme or font change that
  // alters the row box must move them with it.
  useLayoutEffect(() => {
    const row = treeRef.current?.querySelector(".tree-file, .tree-folder");
    if (!row) return;
    const measured = row.getBoundingClientRect().height;
    if (measured > 0 && Math.abs(measured - rowHeight) > 0.5) setRowHeight(measured);
  });

  const range = visibleRowRange(rows.length, {
    scrollTop: view.scrollTop,
    offset: view.offset,
    viewportHeight: view.viewportHeight,
    rowHeight,
  });
  const mounted = windowedRowIndices(range, focusRowRange(focusIndex, rows.length));

  // Stable row handlers so a re-window doesn't invalidate every memoized row.
  const onOpen = useCallback((rel: string) => void openFile(rel), [openFile]);
  const onToggle = useCallback((path: string) => toggleFolder(path), [toggleFolder]);
  const onContext = useCallback(
    (rel: string, kind: "file" | "folder", name: string, x: number, y: number) =>
      setMenu({ rel, kind, name, x, y }),
    []
  );
  const onCommitRename = useCallback(
    (rel: string, name: string) => {
      setRenaming(null);
      if (name && name !== getStore().notes[rel]?.title) void renameNote(rel, name);
    },
    [renameNote]
  );
  const onCancelRename = useCallback(() => setRenaming(null), []);

  // Reveal active file: a one-shot triggered by the sidebar's ⌖ button (via
  // revealTick). Expand every folder on the path to the active file and scroll
  // it into view. Skips the very first mount so it only fires on real clicks.
  //
  // `activePath` and `collapsedFolders` are read from the store HERE rather
  // than subscribed at the top of the component. This effect is deliberately
  // keyed on `revealTick` alone, so a subscription only ever fed it a stale
  // render snapshot — while making the whole sidebar re-render on every file
  // switch. `TreeItem` subscribes to `activePath` itself, so the two rows whose
  // highlight actually changes still update; the other 4,000+ rows in a large
  // vault no longer re-render to produce identical markup (measured 251 ms per
  // file switch on a 4,165-file vault). Reading at event time is also fresher:
  // it reveals the file that is active when ⌖ is pressed.
  const revealMounted = useRef(false);
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!revealMounted.current) {
      revealMounted.current = true;
      return;
    }
    const { activePath: liveActive, collapsedFolders: liveCollapsed } = getStore();
    if (!liveActive) return;
    const ancestors = ancestorFolders(liveActive);
    let changed = false;
    const next = { ...liveCollapsed };
    for (const a of ancestors) {
      if (next[a]) {
        next[a] = false;
        changed = true;
      }
    }
    if (changed) setCollapsedFolders(next);
    // Hand off to the layout effect below: the row list has to be rebuilt with
    // those folders expanded before the target has an index to scroll to.
    setRevealTarget(liveActive);
    // Only react to the reveal trigger; the store is read directly above so
    // activePath/collapse changes cannot re-run (or stale-close over) this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTick]);

  // Scroll by row INDEX, not `scrollIntoView` on a node: the target row is
  // normally unmounted, so there is no element to scroll to.
  useLayoutEffect(() => {
    if (!revealTarget) return;
    const scroller = scrollerRef.current;
    const index = rows.findIndex((r) => r.node.path === revealTarget);
    if (index < 0 || !scroller) {
      setRevealTarget(null);
      return;
    }
    const top = scrollTopForRow(index, {
      scrollTop: scroller.scrollTop,
      offset: view.offset,
      viewportHeight: scroller.clientHeight,
      rowHeight,
    });
    if (top !== null) scroller.scrollTop = top;
    setRevealTarget(null);
  }, [revealTarget, rows, rowHeight, view.offset]);

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
    // Escape dismisses the menu like every native context menu — it used to
    // close only on click/blur, stranding keyboard users. Handled in the
    // CAPTURE phase and stopped there so the same press cannot also close a
    // modal stacked behind the menu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  if (rows.length === 0) {
    return <div className="tree-empty">No notes yet.</div>;
  }

  const absPath = (rel: string): string => {
    const f = fileFor(rel);
    if (f) return f.path;
    return vaultPath ? `${vaultPath.replace(/\/+$/, "")}/${rel}` : rel;
  };

  return (
    // The container reserves the FULL row count so the scrollbar and every
    // scroll offset match a fully-mounted tree; each row is placed by index.
    <div
      className="file-tree"
      ref={treeRef}
      style={{ height: rows.length * rowHeight }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusIndex(null);
      }}
    >
      {mounted.map((i) => {
        const row = rows[i];
        return (
          <div
            key={row.node.path}
            className="tree-row"
            style={{ top: i * rowHeight, height: rowHeight }}
          >
            <TreeRow
              node={row.node}
              depth={row.depth}
              isActive={activePath === row.node.path}
              isCollapsed={!!collapsedFolders[row.node.path]}
              bookmarked={bookmarks.includes(row.node.path)}
              renaming={renaming === row.node.path}
              onOpen={onOpen}
              onToggle={onToggle}
              onFocus={() => setFocusIndex(i)}
              onContext={onContext}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
            />
          </div>
        );
      })}

      {menu &&
        createPortal(
          // Portaled to <body>: `.sidebar` sets `transform`/`will-change`, which
          // makes it the containing block for `position: fixed` descendants, so
          // a menu rendered inside it is laid out against the sidebar's SCROLLED
          // content (measured top: -19734 at a scroll of 20,000).
          <div
            ref={menuRef}
            className="context-menu"
            data-native-webview-occluder=""
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
          </div>,
          document.body
        )}
    </div>
  );
});
