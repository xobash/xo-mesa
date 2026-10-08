import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { watch } from "@tauri-apps/plugin-fs";
import type { VaultFile } from "../types";
import {
  extOf,
  fileKind,
  isEditableTextExt,
  isTextualVaultFile,
  resolveTextVaultLink,
  readNoteResult,
  scanVault,
  stripExt,
  urlForPath,
  IN_TAURI,
} from "../lib/vault";
import { installCloseGuard } from "../lib/closeGuard";
import { resolveTarget } from "../lib/graph";
import { closeCurrentPopoutWindow, dockIntoMainWindow } from "../lib/windowDock";
import { MarkdownView } from "./MarkdownView";
import { Modal } from "./Modal";
import { CodeView } from "./CodeView";
import { HtmlView } from "./HtmlView";
import { RtfView } from "./RtfView";
import { useAppStore, getStore, type ThemeId } from "../store";
import { isThemeId } from "../lib/persistedUi";
import { useApplyTheme } from "./useApplyTheme";
import { markMesaPerf } from "../lib/mesaPerf";
import { rtfToText } from "../lib/rtf";

// Standalone windows share the same PDF surface as the main workspace without
// pulling pdf.js/pdf-lib into the entry chunk used by every document window.
const LazyPdfView = lazy(() =>
  import("./PdfView").then((module) => ({ default: module.PdfView }))
);

export const DOCUMENT_CATALOG_REQUEST_EVENT = "mesa://document-catalog-request";
export const DOCUMENT_CATALOG_EVENT = "mesa://document-catalog";

/**
 * Standalone document window (Tauri). Spawned with ?doc, ?vault, ?theme in the
 * URL; asks the main window for its existing file catalog and renders a
 * reading view without walking the vault a second time.
 */
export function DocumentView() {
  const params = new URLSearchParams(location.search);
  const vault = params.get("vault") ?? "";
  const initial = params.get("doc") ?? "";
  const themeParam = params.get("theme");
  const theme: ThemeId = isThemeId(themeParam) ? themeParam : "void";

  const [rel, setRel] = useState(initial);
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState(initial);
  const [fileRevision, setFileRevision] = useState(0);
  const [closeIssue, setCloseIssue] = useState("");
  const [viewIssue, setViewIssue] = useState("");
  const pdfDirtyRef = useRef(false);
  const onPdfDirtyChange = useCallback((dirty: boolean) => {
    pdfDirtyRef.current = dirty;
    if (!dirty) {
      setCloseIssue("");
      setViewIssue("");
    }
  }, []);

  useApplyTheme(theme);

  useEffect(() => {
    if (!IN_TAURI) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      if (disposed) return;
      stop = installCloseGuard(
        getCurrentWindow(),
        async () => {
          if (pdfDirtyRef.current) throw new Error("Save the PDF before closing this window.");
        },
        () => pdfDirtyRef.current,
        setCloseIssue,
      );
    }).catch((error) => {
      if (!disposed) setCloseIssue(`Close safety failed to start: ${String(error)}`);
    });
    return () => { disposed = true; stop?.(); };
  }, []);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    if (!IN_TAURI) {
      void scanVault(vault).then((catalog) => {
        if (alive) setFiles(catalog);
      });
      return () => { alive = false; };
    }
    void listen<{ vault: string; files: VaultFile[] }>(DOCUMENT_CATALOG_EVENT, (event) => {
      const payload = event.payload;
      if (alive && payload?.vault === vault && Array.isArray(payload.files)) {
        setFiles(payload.files);
      }
    }).then(async (stop) => {
      if (!alive) { stop(); return; }
      unlisten = stop;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await emit(DOCUMENT_CATALOG_REQUEST_EVENT, {
        label: getCurrentWindow().label,
        vault,
      });
    }).catch((error) => {
      if (alive) setViewIssue(`Document links unavailable: ${String(error)}`);
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [vault]);

  const selectedFile = useMemo<VaultFile>(() => {
    const existing = files.find((file) => file.relPath === rel);
    if (existing) return fileRevision ? { ...existing, mtime: fileRevision } : existing;
    const base = rel.replace(/.*\//, "");
    const ext = extOf(base);
    return {
      path: `${vault.replace(/\/+$/, "")}/${rel}`,
      relPath: rel,
      name: stripExt(base),
      ext,
      isMarkdown: ext === "md" || ext === "markdown",
      mtime: fileRevision || undefined,
    };
  }, [files, rel, vault, fileRevision]);

  useEffect(() => {
    if (!IN_TAURI) return;
    let alive = true;
    let stop: (() => void) | undefined;
    const path = selectedFile.path.replace(/\\/g, "/");
    const parent = path.slice(0, path.lastIndexOf("/"));
    const compare = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    void watch(parent, (event) => {
      if (!alive || !Array.isArray(event.paths)) return;
      if (!event.paths.some((changed) => compare(changed) === compare(path) || compare(changed) === compare(parent))) return;
      if (pdfDirtyRef.current) {
        setViewIssue("This PDF changed on disk. Keep this window open and save or review your edits.");
        return;
      }
      setFileRevision((revision) => revision + 1);
    }, { recursive: false, delayMs: 120 }).then((unwatch) => {
      if (alive) stop = unwatch;
      else unwatch();
    }).catch((error) => {
      if (alive) setViewIssue(`Live file updates unavailable: ${String(error)}`);
    });
    return () => { alive = false; stop?.(); };
  }, [selectedFile.path]);

  useEffect(() => {
    let alive = true;
    setTitle(selectedFile.name);
    document.title = selectedFile.name + " — Mesa";
    if (!isTextualVaultFile(selectedFile) || selectedFile.ext === "html" || selectedFile.ext === "htm") {
      setContent("");
      return () => {
        alive = false;
      };
    }
    void readNoteResult(selectedFile).then((result) => {
      if (!alive) return;
      if (result.ok) {
        setContent(result.text);
        setViewIssue((issue) => issue.startsWith("This file is unavailable") ? "" : issue);
      } else setViewIssue("This file is unavailable. Its previous view remains visible.");
    });
    return () => {
      alive = false;
    };
  }, [selectedFile]);

  const onWiki = (target: string) => {
    const hit = resolveTextVaultLink(files, target);
    if (hit) setRel(hit.relPath);
  };

  const kind = fileKind(selectedFile.ext);
  const src = urlForPath(selectedFile.path);
  useEffect(() => {
    markMesaPerf("detached-document-visible", {
      kind,
      isMarkdown: selectedFile.isMarkdown,
    });
  }, [kind, selectedFile.isMarkdown]);
  return (
    <div className="doc-window">
      <header className="doc-window-bar">
        <span>{title}</span>
        <div className="dock-actions">
          <button
            className="dock-btn"
            onClick={() => void dockIntoMainWindow({ kind: "doc", relPath: rel })}
          >
            Dock
          </button>
          <button
            className="icon-btn"
            onClick={() => void closeCurrentPopoutWindow()}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </header>
      {closeIssue && <div className="doc-window-issue" role="alert">{closeIssue}</div>}
      {viewIssue && <div className="doc-window-issue" role="alert">{viewIssue}</div>}
      <div className="doc-window-body">
        {kind === "image" ? (
          <img className="doc-media" src={src} alt={title} />
        ) : kind === "video" ? (
          <video className="doc-media" src={src} controls />
        ) : kind === "pdf" ? (
          <Suspense fallback={<div className="editor-empty">Loading PDF editor…</div>}>
            <LazyPdfView rel={rel} file={selectedFile} onDirtyChange={onPdfDirtyChange} />
          </Suspense>
        ) : kind === "html" ? (
          <HtmlView rel={rel} file={selectedFile} />
        ) : selectedFile.ext.toLowerCase() === "rtf" ? (
          <pre className="rtf-text">{rtfToText(content)}</pre>
        ) : isEditableTextExt(selectedFile.ext) ? (
          <MarkdownView source={content} files={files} onWikiClick={onWiki} />
        ) : (
          <pre className="code-source">{content}</pre>
        )}
      </div>
    </div>
  );
}

/** In-app fallback (browser demo, where OS windows can't be spawned). */
export function DocPopoutModal() {
  const rel = useAppStore((s) => s.popoutDoc);
  const notes = useAppStore((s) => s.notes);
  const fileFor = useAppStore((s) => s.fileFor);
  const ensureContent = useAppStore((s) => s.ensureContent);
  const setPopoutDoc = useAppStore((s) => s.setPopoutDoc);
  const file = rel ? fileFor(rel) : undefined;
  const kind = file ? fileKind(file.ext) : "text";
  const needsMarkdownContent = Boolean(file?.isMarkdown || !file);

  const [content, setContent] = useState("");
  const [contentIssue, setContentIssue] = useState("");
  useEffect(() => {
    if (!rel) return;
    let alive = true;
    if (!needsMarkdownContent) return;
    setContentIssue("");
    void ensureContent(rel).then((c) => {
      if (alive) setContent(c);
    }).catch(() => {
      if (alive) setContentIssue("This document could not be read.");
    });
    return () => {
      alive = false;
    };
  }, [rel, ensureContent, needsMarkdownContent]);

  if (!rel) return null;
  const onWiki = (target: string) => {
    const id = resolveTarget(getStore().notes, target);
    if (id) setPopoutDoc(id);
  };

  return (
    <Modal onClose={() => setPopoutDoc(null)} className="doc-modal" title="Document">
      <header className="doc-window-bar">
        <span>{notes[rel]?.title ?? rel}</span>
        <button className="icon-btn" onClick={() => setPopoutDoc(null)} aria-label="Close">
          ×
        </button>
      </header>
      <div className="doc-window-body">
        {contentIssue && <div className="doc-window-issue" role="alert">{contentIssue}</div>}
        {kind === "image" && file ? (
          <img className="doc-media" src={urlForPath(file.path)} alt={file.name} />
        ) : kind === "video" && file ? (
          <video className="doc-media" src={urlForPath(file.path)} controls />
        ) : kind === "pdf" && file ? (
          <Suspense fallback={<div className="editor-empty">Loading PDF editor…</div>}>
            <LazyPdfView rel={rel} file={file} />
          </Suspense>
        ) : kind === "html" ? (
          <HtmlView rel={rel} />
        ) : kind === "rtf" ? (
          <RtfView rel={rel} />
        ) : file &&
          isTextualVaultFile(file) &&
          !file.isMarkdown &&
          !isEditableTextExt(file.ext) ? (
          <CodeView rel={rel} />
        ) : (
          <MarkdownView source={content} onWikiClick={onWiki} />
        )}
      </div>
    </Modal>
  );
}
