import { memo } from "react";
import { getStore, useAppStore } from "../store";
import { previewEnter, previewLeave } from "./previewTriggers";
import { startFileDrag } from "./fileDrag";
import { hueFor } from "../lib/hue";
import { type TreeNode } from "./fileTreeModel";

export async function copyText(text: string): Promise<boolean> {
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
  if (!ok) useAppStore.setState({ status: "Could not copy to the clipboard." });
  return ok;
}

/** Rows receive props; FileTree owns the store subscriptions. */
export const TreeRow = memo(function TreeRow({
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
  onContext: (rel: string, kind: "file" | "folder", name: string, x: number, y: number, invoker?: HTMLElement) => void;
  onCommitRename: (rel: string, name: string) => void;
  onCancelRename: () => void;
  onFocus: () => void;
}) {
  const open = node.file ? true : !isCollapsed;

  if (node.file) {
    const rel = node.file.relPath;
    const file = node.file;
    const isOther = !node.file.isMarkdown;
    const extensionHue = hueFor(node.file.ext);
    if (renaming) {
      return (
        <input
          className="tree-rename"
          aria-label={`Rename ${node.name}`}
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
        // Alt/Option-click opens the file beside the current document.
        onPointerDown={(e) => {
          const toSide = e.altKey;
          startFileDrag(rel, e, () => {
            previewLeave();
            if (toSide) void getStore().openToSide(rel);
            else onOpen(rel);
          });
        }}
        onKeyDown={(e) => {
          if (opensContextMenu(e)) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            onContext(rel, "file", node.name, r.left + 16, r.bottom, e.currentTarget);
            return;
          }
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
          onContext(rel, "file", node.name, e.clientX, e.clientY, e.currentTarget);
        }}
        title={node.path}
      >
        {bookmarked && <span className="tree-bookmark" aria-hidden="true">★</span>}
        <span className="tree-name">{node.name}</span>
        {isOther && (
          <span
            className={"tree-ext" + (extensionHue >= 70 && extensionHue <= 170 ? " tree-ext-neutral" : "")}
            style={{ "--ext-hue": extensionHue } as React.CSSProperties}
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
          onKeyDown={(e) => {
            if (!opensContextMenu(e)) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            onContext(node.path, "folder", node.name, r.left + 16, r.bottom, e.currentTarget);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onContext(node.path, "folder", node.name, e.clientX, e.clientY, e.currentTarget);
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

/** Shift+F10 and the Menu key open a row's context menu from the keyboard. */
export function opensContextMenu(e: React.KeyboardEvent): boolean {
  return (e.key === "F10" && e.shiftKey) || e.key === "ContextMenu";
}
