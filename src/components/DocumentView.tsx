import { useEffect, useState } from "react";
import type { VaultFile } from "../types";
import { scanVault, readNote, urlForPath, isImageExt } from "../lib/vault";

const VIDEO_RE = /^(mp4|webm|ogg|ogv|mov|m4v)$/i;
function mediaKind(rel: string): "image" | "video" | "pdf" | "text" {
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  if (isImageExt(ext) || ext === "svg") return "image";
  if (VIDEO_RE.test(ext)) return "video";
  if (ext === "pdf") return "pdf";
  return "text";
}
import { resolveTarget } from "../lib/graph";
import { closeCurrentPopoutWindow, dockIntoMainWindow } from "../lib/windowDock";
import { MarkdownView } from "./MarkdownView";
import { Modal } from "./Modal";
import { useAppStore, getStore, type ThemeId } from "../store";

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

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      root.dataset.theme = theme;
      if (theme === "system") {
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        root.dataset.mode = dark ? "dark" : "light";
      } else {
        delete root.dataset.mode;
      }
    };
    apply();
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  useEffect(() => {
    let alive = true;
    void scanVault(vault).then((fs) => {
      if (alive) setFiles(fs);
    });
    return () => {
      alive = false;
    };
  }, [vault]);

  useEffect(() => {
    let alive = true;
    const f =
      files.find((x) => x.relPath === rel) ??
      ({
        path: `${vault}/${rel}`,
        relPath: rel,
        name: rel.replace(/.*\//, "").replace(/\.md$/i, ""),
        ext: "md",
        isMarkdown: true,
      } as VaultFile);
    void readNote(f).then((text) => {
      if (!alive) return;
      setContent(text);
      setTitle(f.name);
      document.title = f.name + " — Mesa";
    });
    return () => {
      alive = false;
    };
  }, [rel, files, vault]);

  const onWiki = (target: string) => {
    const lower = target.toLowerCase().replace(/\.md$/i, "");
    const hit = files.find(
      (f) =>
        f.isMarkdown &&
        (f.name.toLowerCase() === lower ||
          f.relPath.toLowerCase() === lower + ".md" ||
          f.relPath.toLowerCase() === lower)
    );
    if (hit) setRel(hit.relPath);
  };

  const kind = mediaKind(rel);
  const src = urlForPath(`${vault.replace(/\/+$/, "")}/${rel}`);
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
          <iframe className="doc-pdf" src={src} title={title} />
        ) : (
          <MarkdownView source={content} files={files} onWikiClick={onWiki} />
        )}
      </div>
    </div>
  );
}

/** In-app fallback (browser demo, where OS windows can't be spawned). */
export function DocPopoutModal() {
  const rel = useAppStore((s) => s.popoutDoc);
  const notes = useAppStore((s) => s.notes);
  const ensureContent = useAppStore((s) => s.ensureContent);
  const setPopoutDoc = useAppStore((s) => s.setPopoutDoc);

  const [content, setContent] = useState("");
  useEffect(() => {
    if (!rel) return;
    let alive = true;
    void ensureContent(rel).then((c) => {
      if (alive) setContent(c);
    });
    return () => {
      alive = false;
    };
  }, [rel, ensureContent]);

  if (!rel) return null;
  const onWiki = (target: string) => {
    const id = resolveTarget(getStore().notes, target);
    if (id) setPopoutDoc(id);
  };

  return (
    <Modal onClose={() => setPopoutDoc(null)} className="doc-modal">
      <header className="doc-window-bar">
        <span>{notes[rel]?.title ?? rel}</span>
        <button className="icon-btn" onClick={() => setPopoutDoc(null)} aria-label="Close">
          ×
        </button>
      </header>
      <div className="doc-window-body">
        <MarkdownView source={content} onWikiClick={onWiki} />
      </div>
    </Modal>
  );
}
