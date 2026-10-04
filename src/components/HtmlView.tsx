import { useEffect, useMemo, useState } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "../store";
import { IN_TAURI, urlForPath } from "../lib/vault";
import { hydrateSavedHtml, rewriteSavedHtml } from "../lib/html";

/**
 * Renders an .html file as the actual page in an iframe of the file (so its
 * relative CSS / _files / scripts load), with a toggle to view the raw source.
 *
 * The sandbox allows page scripts, but keeps the document on an opaque origin.
 * Saved files can arrive from imports, sync, web archives, or an agent, so a
 * page must not gain read access to Mesa's broad asset-protocol origin.
 */
export function HtmlView({ rel }: { rel: string }) {
  const fileFor = useAppStore((s) => s.fileFor);
  const ensureContent = useAppStore((s) => s.ensureContent);
  const file = fileFor(rel);
  const [source, setSource] = useState(false);
  const [src, setSrc] = useState("");
  const [renderedHtml, setRenderedHtml] = useState("");
  const directSrc = useMemo(
    () => (IN_TAURI && file ? urlForPath(file.path) : ""),
    [file]
  );

  useEffect(() => {
    if (directSrc && !source) {
      setSrc("");
      return;
    }
    let alive = true;
    void ensureContent(rel).then((c) => {
      if (alive) setSrc(c);
    });
    return () => {
      alive = false;
    };
  }, [rel, ensureContent, directSrc, source]);

  useEffect(() => {
    if (directSrc) {
      setRenderedHtml("");
      return;
    }
    if (!file) {
      setRenderedHtml("");
      return;
    }
    let alive = true;
    const fallback = rewriteSavedHtml(src, file.path, urlForPath);
    setRenderedHtml(fallback);
    if (!src) return;
    void hydrateSavedHtml(src, file.path, urlForPath, readTextFile).then((html) => {
      if (alive) setRenderedHtml(html);
    });
    return () => {
      alive = false;
    };
  }, [src, file, directSrc]);

  if (!file) return <div className="editor-empty">File not found.</div>;

  return (
    <div className="html-view">
      <div className="html-view-bar">
        <div className="seg">
          <button
            className={"seg-btn" + (!source ? " on" : "")}
            aria-pressed={!source}
            onClick={() => setSource(false)}
          >
            Rendered
          </button>
          <button
            className={"seg-btn" + (source ? " on" : "")}
            aria-pressed={source}
            onClick={() => setSource(true)}
          >
            Source
          </button>
        </div>
      </div>
      {source ? (
        <pre className="html-source">{src}</pre>
      ) : directSrc ? (
        <iframe
          className="html-frame"
          src={directSrc}
          sandbox="allow-scripts allow-popups allow-forms allow-modals"
          title={file.name}
        />
      ) : (
        <iframe
          className="html-frame"
          srcDoc={renderedHtml}
          sandbox="allow-scripts allow-popups allow-forms allow-modals"
          title={file.name}
        />
      )}
    </div>
  );
}
