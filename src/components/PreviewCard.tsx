import { memo, useEffect, useMemo, useRef, useState } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "../store";
import { MarkdownView } from "./MarkdownView";
import { fileKind, IN_TAURI, isTextExt, urlForPath } from "../lib/vault";
import { PdfThumb } from "./PdfThumb";
import { rtfToText } from "../lib/rtf";
import { statusLine } from "../lib/faces";
import { hydrateSavedHtml, rewriteSavedHtml } from "../lib/html";
import type { ActivityOp } from "../lib/activity";
import type { PreviewTarget } from "../types";

/** Strip a leading YAML frontmatter block and cap length for a quick peek.
 *  Activity cards use a larger cap so the highlighted change stays reachable. */
function excerpt(src: string, cap = 1200): string {
  const body = src.replace(/^﻿?---\n[\s\S]*?\n---\n?/, "");
  return body.length > cap ? body.slice(0, cap) : body;
}

function excerptAround(src: string, needle?: string, cap = 4000): string {
  const body = src.replace(/^﻿?---\n[\s\S]*?\n---\n?/, "");
  const line =
    needle?.split("\n").find((l) => l.trim().length > 2)?.trim() ??
    needle?.trim() ??
    "";
  if (line.length < 3) return excerpt(body, cap);
  const idx = body.toLowerCase().indexOf(line.toLowerCase().slice(0, 80));
  if (idx < 0) return excerpt(body, cap);
  const start = Math.max(0, idx - Math.floor(cap * 0.35));
  const end = Math.min(body.length, start + cap);
  return (start > 0 ? "...\n" : "") + body.slice(start, end);
}

interface ListItem {
  key: string;
  name: string;
  /** Small right-aligned label (extension or "folder"). */
  tag?: string;
  isFolder?: boolean;
}

const MAX_ITEMS = 14;

/**
 * The single floating preview card used everywhere — graph nodes, sidebar
 * files, sidebar folders, and tag chips. A `note` target renders a rendered
 * markdown excerpt; `folder` and `tag` targets render a list of the items
 * inside. Pointer-events are disabled so it only ever peeks, never steals focus.
 */
function PreviewCardImpl({
  target,
  x,
  y,
  fixed,
  status,
  visible = true,
}: {
  target: PreviewTarget;
  x: number;
  y: number;
  /** position: fixed (global layer) vs absolute (inside the graph wrap). */
  fixed?: boolean;
  /** Controls the smooth show/hide timing for activity cards. */
  visible?: boolean;
  /** When shown as a live activity card: the op, optional status text, and the
   *  changed chunk to highlight in the body. */
  status?: {
    op: ActivityOp;
    label?: string;
    detail?: string;
    added?: number;
    removed?: number;
    filesChanged?: number;
    seed?: string;
  };
}) {
  const ensurePeek = useAppStore((s) => s.ensurePeek);
  const notes = useAppStore((s) => s.notes);
  const files = useAppStore((s) => s.files);
  const [content, setContent] = useState("");
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(visible));
    return () => cancelAnimationFrame(id);
  }, [visible]);

  const noteId = target.kind === "note" ? target.id : null;
  // Reactive: when an editor/agent changes the cached content, the card updates
  // live without a re-fetch.
  const liveContent = useAppStore((s) =>
    noteId ? s.contentCache[noteId] : undefined
  );
  const noteFile = useMemo(
    () => (noteId ? files.find((f) => f.relPath === noteId) : undefined),
    [noteId, files]
  );
  // Graph nodes are always markdown; sidebar files can be anything. Only read
  // content for textual files — reading a binary (image/pdf) as text is garbage.
  const isRtf = noteFile?.ext === "rtf";
  const isTextual =
    noteFile ? noteFile.isMarkdown || isTextExt(noteFile.ext) || isRtf : true;

  // For live activity cards, throttle the content shown so a fast typer (or an
  // agent streaming edits) doesn't re-render the markdown on every keystroke —
  // that was the source of the graph lag. Hover previews update immediately.
  const rawContent = liveContent ?? content;
  const [htmlPreview, setHtmlPreview] = useState("");
  const [shownContent, setShownContent] = useState(rawContent);
  const lastShownAt = useRef(0);
  useEffect(() => {
    if (!status) {
      setShownContent(rawContent);
      return;
    }
    const now = performance.now();
    const wait = 300 - (now - lastShownAt.current);
    if (wait <= 0) {
      lastShownAt.current = now;
      setShownContent(rawContent);
      return;
    }
    const id = setTimeout(() => {
      lastShownAt.current = performance.now();
      setShownContent(rawContent);
    }, wait);
    return () => clearTimeout(id);
  }, [rawContent, status]);

  useEffect(() => {
    if (!noteId || !isTextual) return;
    let alive = true;
    setContent("");
    // Byte-capped head-of-file peek — previews never need (or wait for) the
    // whole file. Falls through to the full cached content when available.
    void ensurePeek(noteId).then((c) => {
      if (alive) setContent(c);
    });
    return () => {
      alive = false;
    };
  }, [noteId, isTextual, ensurePeek]);

  useEffect(() => {
    if (!noteFile || fileKind(noteFile.ext) !== "html") {
      setHtmlPreview("");
      return;
    }
    let alive = true;
    const fallback = rewriteSavedHtml(rawContent, noteFile.path, urlForPath);
    setHtmlPreview(fallback);
    if (!rawContent) return;
    void hydrateSavedHtml(rawContent, noteFile.path, urlForPath, readTextFile).then(
      (html) => {
        if (alive) setHtmlPreview(html);
      }
    );
    return () => {
      alive = false;
    };
  }, [noteFile, rawContent]);

  // Folder contents: the immediate children (sub-folders first, then files).
  const folderItems = useMemo<ListItem[]>(() => {
    if (target.kind !== "folder") return [];
    const prefix = target.path ? target.path + "/" : "";
    const folders = new Set<string>();
    const fileItems: ListItem[] = [];
    for (const f of files) {
      if (prefix && !f.relPath.startsWith(prefix)) continue;
      const rest = f.relPath.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        fileItems.push({
          key: f.relPath,
          name: f.name,
          tag: f.isMarkdown ? undefined : f.ext,
        });
      } else {
        folders.add(rest.slice(0, slash));
      }
    }
    const folderList: ListItem[] = [...folders]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name) => ({ key: "dir:" + name, name, isFolder: true, tag: "folder" }));
    fileItems.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return [...folderList, ...fileItems];
  }, [target, files]);

  // Tag contents: every note carrying the tag.
  const tagItems = useMemo<ListItem[]>(() => {
    if (target.kind !== "tag") return [];
    return Object.values(notes)
      .filter((n) => n.tags.includes(target.tag))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
      .map((n) => ({ key: n.relPath, name: n.title }));
  }, [target, notes]);

  let title: string;
  let sub: string | null = null;
  let body: React.ReactNode;

  if (target.kind === "note") {
    title = notes[target.id]?.title ?? noteFile?.name ?? target.id;
    const kind = noteFile ? fileKind(noteFile.ext) : "text";
    if (noteFile && kind === "image") {
      body = (
        <div className="preview-media">
          <img className="preview-img" src={urlForPath(noteFile.path)} alt={title} />
        </div>
      );
    } else if (noteFile && kind === "pdf") {
      sub = "PDF";
      body = (
        <div className="preview-media">
          <PdfThumb path={noteFile.path} />
        </div>
      );
    } else if (noteFile && kind === "video") {
      sub = noteFile.ext.toUpperCase();
      body = (
        <div className="preview-media">
          <video
            className="preview-img"
            src={urlForPath(noteFile.path)}
            muted
            preload="metadata"
          />
        </div>
      );
    } else if (noteFile && kind === "html") {
      sub = "HTML";
      // Fully sandboxed: a hover peek renders markup only — no scripts,
      // popups, forms, or same-origin access can run from a preview.
      body = (
        <iframe
          className="preview-html-frame"
          {...(IN_TAURI
            ? { src: urlForPath(noteFile.path) }
            : { srcDoc: htmlPreview })}
          sandbox=""
          title={title}
        />
      );
    } else if (noteFile && !isTextual) {
      sub = noteFile.ext.toUpperCase();
      body = (
        <div className="preview-media-other">
          No preview available for .{noteFile.ext} files
        </div>
      );
    } else if (isRtf) {
      sub = "RTF";
      body = <pre className="preview-rtf">{excerpt(rtfToText(rawContent), 1400)}</pre>;
    } else {
      const source = status
        ? excerptAround(shownContent, status.detail, 4000)
        : excerpt(rawContent, 1200);
      body = (
        <MarkdownView
          source={source}
          highlight={status?.detail}
        />
      );
    }
  } else {
    const items = target.kind === "folder" ? folderItems : tagItems;
    title = target.kind === "folder" ? target.title || "Vault" : "#" + target.tag;
    sub = `${items.length} item${items.length === 1 ? "" : "s"}`;
    body =
      items.length === 0 ? (
        <div className="preview-empty-list">Nothing here yet.</div>
      ) : (
        <ul className="preview-list">
          {items.slice(0, MAX_ITEMS).map((it) => (
            <li key={it.key} className={"preview-row" + (it.isFolder ? " folder" : "")}>
              <span className="preview-row-icon">{it.isFolder ? "▸" : "•"}</span>
              <span className="preview-row-name">{it.name}</span>
              {it.tag && <span className="preview-row-tag">{it.tag}</span>}
            </li>
          ))}
          {items.length > MAX_ITEMS && (
            <li className="preview-row more">+{items.length - MAX_ITEMS} more</li>
          )}
        </ul>
      );
  }

  const footer = status
    ? statusLine(
        status.op,
        status.seed ?? (target.kind === "note" ? target.id : title),
        status.label
      )
    : null;

  return (
    <div
      className={"hover-card" + (fixed ? " fixed" : "") + (status ? " activity" : "")}
      style={{ left: x, top: y, opacity: shown ? 1 : 0, transform: shown ? "translateY(0)" : "translateY(5px)" }}
    >
      <div className="hover-card-title">
        <span className="hover-card-name">{title}</span>
        {sub && <span className="hover-card-sub">{sub}</span>}
      </div>
      <div className="hover-card-body">{body}</div>
      {status && (
        <div className="hover-card-delta">
          <span>{status.filesChanged ?? 1} file changed</span>
          <span className="delta-add">+{status.added ?? 0}</span>
          <span className="delta-remove">-{status.removed ?? 0}</span>
        </div>
      )}
      {footer && <div className="hover-card-foot">{footer}</div>}
    </div>
  );
}

/**
 * Memoized so a parent re-render (e.g. the graph's animation loop pushing new
 * card positions) doesn't re-render every card — only when this card's own
 * position/target/status actually changes. Internal content updates (throttled
 * above) still flow through normally.
 */
export const PreviewCard = memo(PreviewCardImpl, (a, b) => {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.fixed === b.fixed &&
    a.visible === b.visible &&
    a.target.kind === b.target.kind &&
    JSON.stringify(a.target) === JSON.stringify(b.target) &&
    a.status?.op === b.status?.op &&
    a.status?.label === b.status?.label &&
    a.status?.detail === b.status?.detail &&
    a.status?.added === b.status?.added &&
    a.status?.removed === b.status?.removed &&
    a.status?.filesChanged === b.status?.filesChanged &&
    a.status?.seed === b.status?.seed
  );
});
