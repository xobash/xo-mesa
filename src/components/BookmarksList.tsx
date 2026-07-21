import { useMemo } from "react";
import { useAppStore } from "../store";
import { previewEnter, previewLeave } from "./previewTriggers";

/**
 * Sidebar Bookmarks section. Lists the user's bookmarked files and folders
 * (set from the file-tree context menu). Clicking a file opens it; clicking a
 * folder expands it in the tree. Stale bookmarks (entries that no longer
 * resolve in the current vault) are hidden, not shown as dead rows.
 */
export function BookmarksList() {
  const bookmarks = useAppStore((s) => s.settings.bookmarks);
  const collapsed = useAppStore((s) => s.settings.bookmarksCollapsed);
  const setSetting = useAppStore((s) => s.setSetting);
  const files = useAppStore((s) => s.files);
  const emptyFolders = useAppStore((s) => s.emptyFolders);
  const openFile = useAppStore((s) => s.openFile);
  const toggleBookmark = useAppStore((s) => s.toggleBookmark);
  const collapsedFolders = useAppStore((s) => s.collapsedFolders);
  const setCollapsedFolders = useAppStore((s) => s.setCollapsedFolders);

  const items = useMemo(() => {
    const fileSet = new Set(files.map((f) => f.relPath));
    const folderSet = new Set(emptyFolders);
    return bookmarks
      .map((rel) => {
        const isFile = fileSet.has(rel);
        const isFolder =
          !isFile &&
          (folderSet.has(rel) || files.some((f) => f.relPath.startsWith(rel + "/")));
        return { rel, isFile, isFolder };
      })
      .filter((b) => b.isFile || b.isFolder);
  }, [bookmarks, files, emptyFolders]);

  if (items.length === 0) return null;

  const label = (rel: string) =>
    rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/i, "");

  const openBookmark = (rel: string, isFile: boolean) => {
    previewLeave();
    if (isFile) {
      void openFile(rel);
      return;
    }
    // Folder: expand it and every ancestor so it's visible in the tree.
    const next = { ...collapsedFolders };
    const parts = rel.split("/");
    for (let i = 0; i < parts.length; i++) next[parts.slice(0, i + 1).join("/")] = false;
    setCollapsedFolders(next);
  };

  return (
    <div className={"bookmark-section" + (collapsed ? " collapsed" : "")}>
      <button
        className="sidebar-header bookmark-header"
        onClick={() => setSetting("bookmarksCollapsed", !collapsed)}
        aria-expanded={!collapsed}
        title={collapsed ? "Show bookmarks" : "Hide bookmarks"}
      >
        <span className={"tag-caret" + (collapsed ? " collapsed" : "")}>▾</span>
        Bookmarks
        <span className="tag-section-count">{items.length}</span>
      </button>
      {!collapsed && (
        <div className="bookmark-list">
          {items.map((b) => (
            <div key={b.rel} className="bookmark-row">
              <button
                className="bookmark-chip"
                title={b.rel}
                onClick={() => openBookmark(b.rel, b.isFile)}
                onMouseEnter={(e) =>
                  b.isFile &&
                  previewEnter(
                    { kind: "note", id: b.rel },
                    e.currentTarget.getBoundingClientRect()
                  )
                }
                onMouseLeave={previewLeave}
              >
                <span className="bookmark-icon" aria-hidden="true">
                  {b.isFolder ? "▸" : "★"}
                </span>
                <span className="bookmark-name">{label(b.rel)}</span>
              </button>
              <button
                className="bookmark-remove"
                title="Remove bookmark"
                aria-label="Remove bookmark"
                onClick={() => toggleBookmark(b.rel)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
