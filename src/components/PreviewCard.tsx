import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "../store";
import { MarkdownView } from "./MarkdownView";
import { fileKind, IN_TAURI, isTextExt, urlForPath } from "../lib/vault";
import { rtfToText } from "../lib/rtf";
import { statusLine } from "../lib/faces";
import { compareNames } from "../lib/sort";
import {
  hydrateSavedHtml,
  rewriteSavedHtml,
  stripSavedHtmlPreviewCode,
} from "../lib/html";
import type { ActivityOp } from "../lib/activity";
import type { PreviewTarget, VaultFile } from "../types";

const LazyPdfThumb = lazy(() =>
  import("./PdfThumb").then((module) => ({ default: module.PdfThumb }))
);

/** Strip a leading YAML frontmatter block and cap length for a quick peek.
 *  Activity cards use a larger cap so the highlighted change stays reachable. */
function stripPreviewFrontmatter(src: string): string {
  if (!src.startsWith("---\n") && !src.startsWith("\ufeff---\n")) return src;
  return src.replace(/^﻿?---\n[\s\S]*?\n---\n?/, "");
}

function excerpt(src: string, cap = 1200): string {
  const body = stripPreviewFrontmatter(src);
  return body.length > cap ? body.slice(0, cap) : body;
}

function excerptAround(src: string, needle?: string, cap = 4000): string {
  const body = stripPreviewFrontmatter(src);
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
const HTML_PREVIEW_MAX_CHARS = 4 * 1024 * 1024;
const HTML_PREVIEW_TOO_LARGE =
  "<!doctype html><p>Preview unavailable: this saved page is too large.</p>";

/**
 * The single floating preview card used everywhere — graph nodes, sidebar
 * files, sidebar folders, and tag chips. A `note` target renders a rendered
 * markdown excerpt; `folder` and `tag` targets render a list of the items
 * inside. Pointer-events are disabled so it only ever peeks, never steals focus.
 */
const NO_FILES: VaultFile[] = [];
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
  const ensureContent = useAppStore((s) => s.ensureContent);
  const notes = useAppStore((s) => s.notes);
  const needsFiles = target.kind === "folder";
  const files = useAppStore((s) => (needsFiles ? s.files : NO_FILES));
  const [loadedContent, setLoadedContent] = useState<{
    rel: string;
    text: string;
  } | null>(null);
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
  const noteFile = useAppStore((s) =>
    noteId ? s.fileFor(noteId) : undefined
  );
  // Graph nodes are always markdown; sidebar files can be anything. Only read
  // content for textual files — reading a binary (image/pdf) as text is garbage.
  const isRtf = noteFile?.ext === "rtf";
  const isTextual =
    noteFile ? noteFile.isMarkdown || isTextExt(noteFile.ext) || isRtf : true;
  const isHtml = noteFile ? fileKind(noteFile.ext) === "html" : false;

  // For live activity cards, throttle the content shown so a fast typer (or an
  // agent streaming edits) doesn't re-render the markdown on every keystroke —
  // that was the source of the graph lag. Hover previews update immediately.
  const rawContent =
    liveContent ?? (loadedContent?.rel === noteId ? loadedContent.text : "");
  const [htmlPreview, setHtmlPreview] = useState<{
    rel: string;
    html: string;
  } | null>(null);
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
    setLoadedContent(null);
    // Ordinary note/RTF/code cards only render a short excerpt, so they retain
    // the byte-capped peek path. Saved HTML is different: its markup, closing
    // tags, styles, and body can live beyond 16 KiB, and srcDoc must never be
    // built from a truncated document. `ensureContent` shares the store cache
    // and deduplicates any in-flight full read.
    // Native HTML previews load the real saved file directly. This avoids a
    // multi-megabyte read and prevents hover-only bytes from entering the
    // session-wide text cache. The browser demo needs a prepared srcDoc.
    if (isHtml && IN_TAURI) return;
    const load = isHtml ? ensureContent(noteId) : ensurePeek(noteId);
    void load.then((text) => {
      if (alive) setLoadedContent({ rel: noteId, text });
    });
    return () => {
      alive = false;
    };
  }, [noteId, isTextual, isHtml, ensureContent, ensurePeek]);

  useEffect(() => {
    if (!noteFile || fileKind(noteFile.ext) !== "html" || IN_TAURI) {
      setHtmlPreview(null);
      return;
    }
    let alive = true;
    const rel = noteFile.relPath;
    if (rawContent.length > HTML_PREVIEW_MAX_CHARS) {
      setHtmlPreview({ rel, html: HTML_PREVIEW_TOO_LARGE });
      return;
    }
    const stripped = stripSavedHtmlPreviewCode(rawContent);
    const fallback = rewriteSavedHtml(stripped, noteFile.path, urlForPath);
    setHtmlPreview({ rel, html: fallback });
    if (!rawContent) return;
    void hydrateSavedHtml(
      stripped,
      noteFile.path,
      urlForPath,
      readTextFile,
      { scripts: false, previewCodeStripped: true }
    ).then((html) => {
      if (alive) setHtmlPreview({ rel, html });
    });
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
      .sort(compareNames)
      .map((name) => ({ key: "dir:" + name, name, isFolder: true, tag: "folder" }));
    fileItems.sort((a, b) => compareNames(a.name, b.name));
    return [...folderList, ...fileItems];
  }, [target, files]);

  // Tag contents: every note carrying the tag.
  const tagItems = useMemo<ListItem[]>(() => {
    if (target.kind !== "tag") return [];
    return Object.values(notes)
      .filter((n) => n.tags.includes(target.tag))
      .sort((a, b) => compareNames(a.title, b.title))
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
          <Suspense fallback={<div className="preview-media-other">Loading PDF…</div>}>
            <LazyPdfThumb path={noteFile.path} />
          </Suspense>
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
      body = IN_TAURI ? (
        <iframe
          className="preview-html-frame"
          src={urlForPath(noteFile.path)}
          sandbox=""
          title={title}
        />
      ) : (
        <iframe
          className="preview-html-frame"
          srcDoc={
            htmlPreview?.rel === noteFile.relPath ? htmlPreview.html : ""
          }
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
      data-native-webview-occluder=""
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
function sameTarget(a: PreviewTarget, b: PreviewTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "note") return a.id === (b as typeof a).id;
  if (a.kind === "folder")
    return a.path === (b as typeof a).path && a.title === (b as typeof a).title;
  return a.tag === (b as { kind: "tag"; tag: string }).tag;
}

export const PreviewCard = memo(PreviewCardImpl, (a, b) => {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.fixed === b.fixed &&
    a.visible === b.visible &&
    sameTarget(a.target, b.target) &&
    a.status?.op === b.status?.op &&
    a.status?.label === b.status?.label &&
    a.status?.detail === b.status?.detail &&
    a.status?.added === b.status?.added &&
    a.status?.removed === b.status?.removed &&
    a.status?.filesChanged === b.status?.filesChanged &&
    a.status?.seed === b.status?.seed
  );
});
