import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { VaultFile } from "../types";
import {
  extOf,
  fileKind,
  isEditableTextExt,
  isTextualVaultFile,
  resolveTextVaultLink,
  readNote,
  scanVault,
  stripExt,
  urlForPath,
} from "../lib/vault";
import { resolveTarget } from "../lib/graph";
import { closeCurrentPopoutWindow, dockIntoMainWindow } from "../lib/windowDock";
import { MarkdownView } from "./MarkdownView";
import { Modal } from "./Modal";
import { CodeView } from "./CodeView";
import { HtmlView } from "./HtmlView";
import { RtfView } from "./RtfView";
import { useAppStore, getStore, type ThemeId } from "../store";
import { useApplyTheme } from "./useApplyTheme";
import { markMesaPerf } from "../lib/mesaPerf";
import { rtfToText } from "../lib/rtf";

// Standalone windows share the same PDF surface as the main workspace without
// pulling pdf.js/pdf-lib into the entry chunk used by every document window.
const LazyPdfView = lazy(() =>
  import("./PdfView").then((module) => ({ default: module.PdfView }))
);

/**
 * Standalone document window (Tauri). Spawned with ?doc, ?vault, ?theme in the
 * URL; scans the vault for asset resolution and renders a clean reading view.
 */
export function DocumentView() {
  const params = new URLSearchParams(location.search);
  const vault = params.get("vault") ?? "";
  const initial = params.get("doc") ?? "";
  const theme = (params.get("theme") as ThemeId) || "void";

  const [rel, setRel] = useState(initial);
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState(initial);

  useApplyTheme(theme);

  useEffect(() => {
    let alive = true;
    void scanVault(vault).then((fs) => {
      if (alive) setFiles(fs);
    });
    return () => {
      alive = false;
    };
  }, [vault]);

  const selectedFile = useMemo<VaultFile>(() => {
    const existing = files.find((file) => file.relPath === rel);
    if (existing) return existing;
    const base = rel.replace(/.*\//, "");
    const ext = extOf(base);
    return {
      path: `${vault.replace(/\/+$/, "")}/${rel}`,
      relPath: rel,
      name: stripExt(base),
      ext,
      isMarkdown: ext === "md" || ext === "markdown",
    };
  }, [files, rel, vault]);

  useEffect(() => {
    let alive = true;
    setTitle(selectedFile.name);
    document.title = selectedFile.name + " — Mesa";
    if (!isTextualVaultFile(selectedFile)) {
      setContent("");
      return () => {
        alive = false;
      };
    }
    void readNote(selectedFile).then((text) => {
      if (!alive) return;
      setContent(text);
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
      <div className="doc-window-body">
        {kind === "image" ? (
          <img className="doc-media" src={src} alt={title} />
        ) : kind === "video" ? (
          <video className="doc-media" src={src} controls />
        ) : kind === "pdf" ? (
          <Suspense fallback={<div className="editor-empty">Loading PDF editor…</div>}>
            <LazyPdfView rel={rel} file={selectedFile} />
          </Suspense>
        ) : kind === "html" ? (
          <iframe
            className="html-frame"
            src={src}
            sandbox="allow-scripts allow-popups allow-forms allow-modals"
            title={title}
          />
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
  useEffect(() => {
    if (!rel) return;
    let alive = true;
    if (!needsMarkdownContent) return;
    void ensureContent(rel).then((c) => {
      if (alive) setContent(c);
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
