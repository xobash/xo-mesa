import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { stat, watch } from "@tauri-apps/plugin-fs";
import type { VaultFile } from "../types";
import {
  extOf,
  isEditableTextExt,
  isOpenableTextFile,
  resolveTextVaultLink,
  readNoteResult,
  scanVault,
  stripExt,
  IN_TAURI,
} from "../lib/vault";
import { installCloseGuard } from "../lib/closeGuard";
import { createFileIndex } from "../lib/fileIndex";
import { resolveTarget } from "../lib/graph";
import { installNativeDragDock } from "../lib/windowDock";
import { MarkdownView } from "./MarkdownView";
import { Modal } from "./Modal";
import { CodeView } from "./CodeView";
import { CodeText } from "./CodeText";
import { MAX_TEXT_CACHE_FILE_BYTES, MAX_TEXT_CACHE_FILE_LABEL } from "../lib/textCachePlan";
import { formatBytes } from "../lib/formatBytes";
import { FileKindView } from "./FileKindView";
import { useDocumentKind } from "./useDocumentKind";
import { useAppStore, getStore, type ThemeId } from "../store";
import { isThemeId } from "../lib/persistedUi";
import { useApplyTheme } from "./useApplyTheme";
import { markMesaPerf } from "../lib/mesaPerf";

export const DOCUMENT_CATALOG_REQUEST_EVENT = "mesa://document-catalog-request";
export const DOCUMENT_CATALOG_EVENT = "mesa://document-catalog";

/** Live byte size of a file, or the catalog's size when it cannot be read. */
async function liveSize(file: VaultFile): Promise<number | undefined> {
  if (!IN_TAURI) return file.size;
  try {
    return (await stat(file.path)).size;
  } catch {
    return file.size;
  }
}

function sizeNotice(size: number): string {
  return `This file is ${formatBytes(size)}, over the ${MAX_TEXT_CACHE_FILE_LABEL} Mesa shows in a document window. Open it in the main window or another app.`;
}

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
  const uiStyle = useAppStore((s) => s.uiStyle);

  const [rel, setRel] = useState(initial);
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [content, setContent] = useState("");
  const [oversize, setOversize] = useState("");
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

  useApplyTheme(theme, uiStyle);

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

  const fileIndex = useMemo(() => createFileIndex(), []);
  const selectedFile = useMemo<VaultFile>(() => {
    const existing = fileIndex(files).get(rel);
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
  }, [fileIndex, files, rel, vault, fileRevision]);
  const detachedKind = useDocumentKind(selectedFile);

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
    document.title = selectedFile.name;
    if (IN_TAURI) {
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => {
          if (alive) return getCurrentWindow().setTitle(selectedFile.name);
        })
        .catch((error) => console.warn("[mesa] document window title update failed:", error));
    }
    // Only text kinds render from this text; every other kind reads its own bytes.
    if (detachedKind !== "text") {
      setContent("");
      setOversize("");
      return () => {
        alive = false;
      };
    }
    void (async () => {
      const size = await liveSize(selectedFile);
      if (!alive) return;
      if (size !== undefined && size > MAX_TEXT_CACHE_FILE_BYTES) {
        setContent("");
        setOversize(sizeNotice(size));
        return;
      }
      const result = await readNoteResult(selectedFile);
      if (!alive) return;
      if (!result.ok) {
        setViewIssue("This file is unavailable. Its previous view remains visible.");
        return;
      }
      // Characters never outnumber bytes, so this only catches growth after the size check.
      if (result.text.length > MAX_TEXT_CACHE_FILE_BYTES) {
        setContent("");
        setOversize(sizeNotice(result.text.length));
        return;
      }
      setOversize("");
      setContent(result.text);
      setViewIssue((issue) => issue.startsWith("This file is unavailable") ? "" : issue);
    })();
    return () => {
      alive = false;
    };
  }, [selectedFile, detachedKind]);

  useEffect(() => {
    if (!IN_TAURI || !rel) return;
    let dispose: (() => void) | undefined;
    let alive = true;
    void installNativeDragDock({ kind: "doc", relPath: rel })
      .then((cleanup) => { if (alive) dispose = cleanup; else cleanup(); })
      .catch((error) => console.warn("[mesa] native document docking unavailable:", error));
    return () => { alive = false; dispose?.(); };
  }, [rel]);

  const onWiki = (target: string) => {
    const hit = resolveTextVaultLink(files, target);
    if (hit) setRel(hit.relPath);
  };

  const kind = detachedKind;
  useEffect(() => {
    markMesaPerf("detached-document-visible", {
      kind,
      isMarkdown: selectedFile.isMarkdown,
    });
  }, [kind, selectedFile.isMarkdown]);
  return (
    <div className="doc-window">
      {closeIssue && <div className="doc-window-issue" role="alert">{closeIssue}</div>}
      {viewIssue && <div className="doc-window-issue" role="alert">{viewIssue}</div>}
      {kind === "text" && oversize && <div className="doc-window-issue" role="status">{oversize}</div>}
      <div className="doc-window-body">
        {kind !== "text" ? (
          // Detached windows are view-only except PDFs, whose edits block close.
          <FileKindView rel={rel} file={selectedFile} onDirtyChange={onPdfDirtyChange} />
        ) : isEditableTextExt(selectedFile.ext) ? (
          <MarkdownView source={content} files={files} onWikiClick={onWiki} />
        ) : (
          <CodeText text={content} ext={selectedFile.ext} />
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
  const kind = useDocumentKind(file);
  const needsMarkdownContent = Boolean(file?.isMarkdown || !file);

  const [content, setContent] = useState("");
  const [contentIssue, setContentIssue] = useState("");
  useEffect(() => {
    if (!rel) return;
    let alive = true;
    setContent("");
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
        {file && kind !== "text" ? (
          <FileKindView rel={rel} file={file} />
        ) : file &&
          isOpenableTextFile(file) &&
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
