import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { CodeText } from "./CodeText";

/**
 * Read-only viewer for code/data files: loads the file's text, then shows it
 * through `CodeText`. Used for files that are textual but not the editable
 * note types (.md/.txt go to the editor).
 */
export function CodeView({ rel }: { rel: string }) {
  const fileFor = useAppStore((s) => s.fileFor);
  const ensureContent = useAppStore((s) => s.ensureContent);
  const cached = useAppStore((s) => s.contentCache[rel]);
  const file = fileFor(rel);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    setFailed(false);
    ensureContent(rel).then(
      (c) => {
        if (alive) setLoaded(c);
      },
      () => {
        if (alive) setFailed(true);
      }
    );
    return () => {
      alive = false;
    };
  }, [rel, ensureContent, attempt]);

  // The store's copy follows disk changes; the loaded copy is the fallback.
  const text = cached ?? loaded;

  if (!file) return <div className="editor-empty">File not found.</div>;
  if (text == null && failed) {
    return (
      <div className="editor-empty" role="alert">
        <p>This file could not be read.</p>
        <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </button>
      </div>
    );
  }
  if (text == null) return <div className="editor-empty">Loading…</div>;
  return <CodeText text={text} ext={file.ext} />;
}
