import { useEffect, useState } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import type { VaultFile } from "../types";
import { useAppStore } from "../store";
import { urlForPath } from "../lib/vault";
import { hydrateSavedHtml, rewriteSavedHtml, savedHtmlFrameDocument } from "../lib/html";

/** Saved content is offline until the user approves this exact document. */
export function HtmlView({ rel, file: providedFile }: { rel: string; file?: VaultFile }) {
  const storedFile = useAppStore(s => s.fileFor(rel));
  const file = providedFile ?? storedFile;
  const ensureContent = useAppStore(s => s.ensureContent);
  const generation = useAppStore(s => s.getVaultGeneration());
  const root = useAppStore(s => s.vaultPath);
  const cached = useAppStore(s => s.contentCache[rel]);
  const identity = `${root}\0${generation}\0${file?.path ?? rel}\0${file?.mtime ?? ""}`;
  const [source, setSource] = useState(false);
  const [loaded, setLoaded] = useState<{ identity: string; text: string } | null>(null);
  const [approved, setApproved] = useState<{ identity: string; text: string } | null>(null);
  const [rendered, setRendered] = useState<{ key: string; html: string } | null>(null);
  const [error, setError] = useState("");
  const text = (providedFile ? undefined : cached) ?? (loaded?.identity === identity ? loaded.text : "");
  const active = approved?.identity === identity && approved.text === text;
  const renderKey = `${identity}\0${active}\0${text}`;

  useEffect(() => {
    let alive = true;
    void (providedFile ? readTextFile(providedFile.path) : ensureContent(rel)).then(value => {
      if (alive) { setLoaded({ identity, text: value }); setError(""); }
    }).catch(reason => { if (alive) setError(`Could not read HTML: ${String(reason)}`); });
    return () => { alive = false; };
  }, [rel, identity, ensureContent, providedFile]);

  useEffect(() => {
    if (!file) return;
    let alive = true;
    void hydrateSavedHtml(text, file.path, urlForPath, readTextFile, { scripts: active })
      .then(html => { if (alive) setRendered({ key: renderKey, html: savedHtmlFrameDocument(html, active) }); })
      .catch(reason => { if (alive) setError(`Could not render HTML: ${String(reason)}`); });
    return () => { alive = false; };
  }, [text, file, active, renderKey]);

  if (!file) return <div className="editor-empty">File not found.</div>;
  const html = rendered?.key === renderKey ? rendered.html
    : savedHtmlFrameDocument(rewriteSavedHtml(text, file.path, urlForPath), active);
  return <div className="html-view">
    <div className="html-view-bar">
      <div className="seg">
        <button className={"seg-btn" + (!source ? " on" : "")} aria-pressed={!source} onClick={() => setSource(false)}>Rendered</button>
        <button className={"seg-btn" + (source ? " on" : "")} aria-pressed={source} onClick={() => setSource(true)}>Source</button>
      </div>
      <button className="seg-btn" aria-pressed={active} onClick={() => {
        if (active) { setApproved(null); return; }
        if (window.confirm("Enable active content for this file while it is open? Scripts and remote resources can contact websites and transmit data in this document.")) setApproved({ identity, text });
      }}>{active ? "Disable active content" : "Enable active content"}</button>
      <span>{active ? "Active content · network enabled" : "Offline · scripts blocked"}</span>
    </div>
    {error && <div role="alert">{error}</div>}
    {source ? <pre className="html-source">{text}</pre> : <iframe key={`${identity}:${active}`} className="html-frame" srcDoc={html}
      sandbox={active ? "allow-scripts allow-popups allow-forms allow-modals" : ""} referrerPolicy="no-referrer" title={file.name} />}
  </div>;
}
