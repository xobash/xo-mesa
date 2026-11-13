import { confirmAction } from "../lib/confirmAction";
import { isGeneratedNavigationFile } from "../lib/navigationFilters";
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
import type { NoteMeta, SortMode } from "../types";
import { getStore, useAppStore } from "../store";
import { clampFloatingMenuPosition } from "../lib/menuPosition";
import { ancestorFolders } from "../lib/fsnames";
import {
  DEFAULT_ROW_HEIGHT,
  focusRowRange,
  scrollTopForRow,
  visibleRowRange,
  windowedRowIndices,
} from "../lib/treeWindow";
import { buildTree, annotateAggregates, makeNodeCompare, childSorter, type FlatRow, flattenRows } from "./fileTreeModel";
import { copyText, TreeRow } from "./FileTreeRow";

/** Stable stand-in subscribed when note metadata cannot affect the tree. */
const EMPTY_NOTES: Record<string, NoteMeta> = {};

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

/** Mount viewport rows, overscan, and the keyboard focus range.
 * Rows receive state through props. Reserve the full row-list height and
 * position rows by index so scrolling remains stable. memo isolates parent renders. */
export const FileTree = memo(function FileTree() {
  const files = useAppStore((s) => s.files);
  // Subscribe to notes only for links sorting. Event handlers read current titles from the store.
  const notes = useAppStore((s) =>
    s.settings.sortMode === "links" ? s.notes : EMPTY_NOTES
  );
  const emptyFolders = useAppStore((s) => s.emptyFolders);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const enableTabs = useAppStore((s) => s.settings.enableTabs);
  const bookmarks = useAppStore((s) => s.settings.bookmarks);
  const revealTick = useAppStore((s) => s.revealTick);
  // Subscribed once here and passed to each row as a boolean — see `TreeRow`.
  const activePath = useAppStore((s) => s.activePath);
  const collapsedFolders = useAppStore((s) => s.collapsedFolders);
  const setCollapsedFolders = useAppStore((s) => s.setCollapsedFolders);
  const toggleFolder = useAppStore((s) => s.toggleFolder);
  const openFile = useAppStore((s) => s.openFile);
  const openDocWindow = useAppStore((s) => s.openDocWindow);
  const deleteEntry = useAppStore((s) => s.deleteEntry);
  const renameNote = useAppStore((s) => s.renameNote);
  const duplicateEntry = useAppStore((s) => s.duplicateEntry);
  const openRecovery = useAppStore((s) => s.openRecovery);
  const hideGenerated = useAppStore(s => s.settings.hideGeneratedFiles);
  const setSetting = useAppStore(s => s.setSetting);
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
    () => files.filter(file => (!typeFilter || typeFilter === "all" || file.ext.toLowerCase() === typeFilter) &&
      (!hideGenerated || !isGeneratedNavigationFile(file.relPath))),
    [files, typeFilter, hideGenerated]
  );
  const filterNotice = hideGenerated || (typeFilter && typeFilter !== "all")
    ? <div className="tree-filter-notice" role="status">Navigation filtered · {files.length - shownFiles.length} hidden <button className="seg-btn" onClick={() => { setSetting("hideGeneratedFiles", false); setSetting("typeFilter", "all"); }}>Show all</button></div>
    : null;
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
  // Entries are keyed by folder node, and every tree build makes new nodes.
  const children = useMemo(() => childSorter(cmp), [cmp]);
  // The visible tree as a flat, indexable row list — the same nodes in the same
  // order the recursive renderer produced, minus the ones inside collapsed
  // folders.
  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    flattenRows(children(tree), 0, collapsedFolders, children, out);
    return out;
  }, [tree, children, collapsedFolders]);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Row that opened the menu; keyboard dismissal returns focus to it.
  const menuInvokerRef = useRef<HTMLElement | null>(null);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Row geometry is measured after every render.
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
    (rel: string, kind: "file" | "folder", name: string, x: number, y: number, invoker?: HTMLElement) => {
      menuInvokerRef.current = invoker ?? null;
      setMenu({ rel, kind, name, x, y });
    },
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

  // Reveal runs on revealTick, skips initial mount, and reads active path and folder state at event time.
  const revealMounted = useRef(false);
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!revealMounted.current) {
      revealMounted.current = true;
      return;
    }
    const { activePath: liveActive, collapsedFolders: liveCollapsed } = getStore();
    if (!liveActive) return;
    if (getStore().settings.hideGeneratedFiles && isGeneratedNavigationFile(liveActive)) setSetting("hideGeneratedFiles", false);
    if (getStore().settings.typeFilter !== "all") setSetting("typeFilter", "all");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reveal is keyed by the explicit trigger and reads current store state.
  }, [revealTick]);

  // Scroll by row index, not `scrollIntoView` on a node: the target row is
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

  const menuOpen = menu !== null;
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuOpen]);
  function restoreMenuFocus(): void {
    const invoker = menuInvokerRef.current;
    menuInvokerRef.current = null;
    if (invoker?.isConnected) invoker.focus();
  }
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      setMenu(null);
      restoreMenuFocus();
      return;
    }
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1
      : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
    if (next === null || !items.length) return;
    e.preventDefault();
    items[(next + items.length) % items.length].focus();
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    // Escape dismisses the menu like every native context menu, so keyboard
    // users are never stranded. Handled in the CAPTURE phase and stopped there so the same press cannot also close a
    // modal stacked behind the menu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        restoreMenuFocus();
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
    return <>{filterNotice}<div className="tree-empty">{files.length ? "No files match the navigation filters." : "No notes yet."}</div></>;
  }

  const absPath = (rel: string): string => {
    const f = fileFor(rel);
    if (f) return f.path;
    return vaultPath ? `${vaultPath.replace(/\/+$/, "")}/${rel}` : rel;
  };

  return (
    <>{filterNotice}<div
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
          // Portal fixed menus outside the transformed sidebar so viewport
          // coordinates remain independent of its scroll position.
          <div
            ref={menuRef}
            className="context-menu"
            role="menu"
            aria-label={`Actions for ${menu.name}`}
            data-native-webview-occluder=""
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
            // Like native menus, activating an item returns focus to its row
            // before the action runs, so dialogs it opens can restore focus there.
            onClickCapture={(e) => {
              if ((e.target as HTMLElement).closest('[role="menuitem"]')) restoreMenuFocus();
            }}
            onKeyDown={onMenuKeyDown}
          >
          {menu.kind === "folder" ? (
            <>
              <button
                role="menuitem"
                className="context-item"
                onClick={() => {
                  void createChildNote(menu.rel);
                  setMenu(null);
                }}
              >
                New note
              </button>
              <button
                role="menuitem"
                className="context-item"
                onClick={() => {
                  void createChildFolder(menu.rel);
                  setMenu(null);
                }}
              >
                New folder
              </button>
              <div className="context-sep" role="separator" />
              <button
                role="menuitem"
                className="context-item"
                onClick={() => {
                  toggleBookmark(menu.rel);
                  setMenu(null);
                }}
              >
                {bookmarks.includes(menu.rel) ? "Remove from bookmarks" : "Bookmark…"}
              </button>
              <button
                role="menuitem"
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
                  role="menuitem"
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
                role="menuitem"
                className="context-item"
                onClick={() => {
                  void getStore().openToSide(menu.rel);
                  setMenu(null);
                }}
              >
                Open to the side
              </button>
              <button
                role="menuitem"
                className="context-item"
                onClick={() => {
                  void openDocWindow(menu.rel);
                  setMenu(null);
                }}
              >
                Open in new window
              </button>
              <div className="context-sep" role="separator" />
              <button
                role="menuitem"
                className="context-item"
                onClick={() => {
                  void duplicateEntry(menu.rel);
                  setMenu(null);
                }}
              >
                Duplicate
              </button>
              <button
                role="menuitem"
                className="context-item"
                onClick={() => {
                  toggleBookmark(menu.rel);
                  setMenu(null);
                }}
              >
                {bookmarks.includes(menu.rel) ? "Remove from bookmarks" : "Bookmark…"}
              </button>
              <button
                role="menuitem"
                className="context-item"
                onClick={() => {
                  void copyText(absPath(menu.rel));
                  setMenu(null);
                }}
              >
                Copy path
              </button>
              <div className="context-sep" role="separator" />
              <button
                role="menuitem"
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
          <div className="context-sep" role="separator" />
          <button
            role="menuitem"
                className="context-item danger"
            onClick={() => {
              const title =
                menu.kind === "file"
                  ? getStore().notes[menu.rel]?.title ?? menu.name
                  : menu.name;
              const detail =
                menu.kind === "folder"
                  ? `Move folder "${title}" and everything inside it to Mesa recovery storage?`
                  : `Move "${title}" to Mesa recovery storage?`;
              setMenu(null);
              const rel = menu.rel;
              const root = getStore().vaultPath;
              const generation = getStore().getVaultGeneration();
              void confirmAction(detail, { okLabel: "Move to recovery" }).then(ok => {
                if (ok && getStore().vaultPath === root && getStore().getVaultGeneration() === generation) void deleteEntry(rel);
              });
            }}
          >
            Move to recovery
          </button>
          <button
            role="menuitem"
                className="context-item"
            onClick={() => {
              setMenu(null);
              openRecovery();
            }}
          >
            Open recovery storage
          </button>
          </div>,
          document.body
        )}
    </div></>
  );
});
