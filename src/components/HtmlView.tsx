import { useEffect, useMemo, useState } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "../store";
import { IN_TAURI, urlForPath } from "../lib/vault";
import { hydrateSavedHtml, rewriteSavedHtml } from "../lib/html";

/**
 * Renders an .html file as the actual page in an iframe of the file (so its
 * relative CSS / _files / scripts load), with a toggle to view the raw source.
 *
 * The sandbox allows scripts + same-origin so a saved web page renders like a
 * real browser. This is a deliberate trade-off: vault files are the user's own
 * local content, not untrusted remote pages, so running their JS/CSS is the
 * desired behaviour (matching how a browser would open the file directly).
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
    let alive = true;
    void ensureContent(rel).then((c) => {
      if (alive) setSrc(c);
    });
    return () => {
      alive = false;
    };
  }, [rel, ensureContent]);

  useEffect(() => {
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
  }, [src, file]);

  if (!file) return <div className="editor-empty">File not found.</div>;

  return (
    <div className="html-view">
      <div className="html-view-bar">
        <div className="seg">
          <button
            className={"seg-btn" + (!source ? " on" : "")}
            onClick={() => setSource(false)}
          >
            Rendered
          </button>
          <button
            className={"seg-btn" + (source ? " on" : "")}
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
          sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals"
          title={file.name}
        />
      ) : (
        <iframe
          className="html-frame"
          srcDoc={renderedHtml}
          sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals"
          title={file.name}
        />
      )}
    </div>
  );
}
