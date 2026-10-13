import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { confirmAction } from "../lib/confirmAction";
import { prepareReaderResources } from "../lib/browserReader";
import { MAX_TEXT_CACHE_FILE_BYTES } from "../lib/textCachePlan";
import { useEffect, useState } from "react";
import { stat, readTextFile } from "@tauri-apps/plugin-fs";
import type { VaultFile } from "../types";
import { useAppStore } from "../store";
import { IN_TAURI, urlForPath } from "../lib/vault";
import { hydrateSavedHtml, savedFromUrl, savedHtmlFrameDocument } from "../lib/html";

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
  const sourceReady = (providedFile ? false : cached !== undefined) || loaded?.identity === identity;
  const active = approved?.identity === identity && approved.text === text;
  const renderKey = `${identity}\0${active}\0${text}`;

  useEffect(() => {
    let alive = true;
    const read = async () => {
      if (!file) return "";
      const size = file.size ?? (providedFile ? (await stat(file.path)).size : undefined);
      if (size !== undefined && size > MAX_TEXT_CACHE_FILE_BYTES) throw new Error(`This HTML file is too large to render (${(size / 1024 / 1024).toFixed(1)} MB). Open in system browser.`);
      if (!providedFile) return ensureContent(rel);
      if (IN_TAURI) {
        const bytes = await invoke<number[]>("vault_read_bytes", { path: file.path, maxBytes: MAX_TEXT_CACHE_FILE_BYTES, requireComplete: true });
        return new TextDecoder().decode(Uint8Array.from(bytes));
      }
      return readTextFile(file.path);
    };
    void read().then(value => {
      if (alive) { setLoaded({ identity, text: value }); setError(""); }
    }).catch(reason => { if (alive) setError(`Could not read HTML: ${String(reason)}`); });
    return () => { alive = false; };
  }, [rel, identity, ensureContent, providedFile, file]);

  useEffect(() => {
    if (!file || !sourceReady || (file.size ?? 0) > MAX_TEXT_CACHE_FILE_BYTES) return;
    setError("");
    let alive = true;
    let token: string | undefined;
    const render = async () => {
      let html = await hydrateSavedHtml(text, file.path, urlForPath, readTextFile, { scripts: false,
        fonts: { readBytes: async path => Uint8Array.from(await invoke<number[]>("vault_read_bytes", { path, maxBytes: 2 * 1024 * 1024, requireComplete: true })) } });
      if (!alive) return;
      if (active && IN_TAURI) {
        token = await invoke<string>("browse_resource_session", { token: null });
        if (!alive) { await invoke("browse_resource_session", { token }); return; }
        html = await prepareReaderResources(html, savedFromUrl(text) ?? "https://example.invalid/", { token, proxyBase: convertFileSrc("", "mesa-web"), allowLocal: true,
          fetchStylesheet: url => invoke<{ css: string; finalUrl: string }>("browse_fetch_stylesheet", { token, url }) });
      }
      if (alive) setRendered({ key: renderKey, html: savedHtmlFrameDocument(html, active) });
    };
    void render().catch(reason => { if (alive) setError(`Could not render HTML: ${String(reason)}`); });
    return () => { alive = false; if (token) void invoke("browse_resource_session", { token }).catch(() => {}); };
  }, [text, file, active, renderKey, sourceReady]);

  if (!file) return <div className="editor-empty">File not found.</div>;
  const html = rendered?.key === renderKey ? rendered.html : null;
  return <div className="html-view">
    <div className="html-view-bar">
      <div className="seg">
        <button className={"seg-btn" + (!source ? " on" : "")} aria-pressed={!source} onClick={() => setSource(false)}>Rendered</button>
        <button className={"seg-btn" + (source ? " on" : "")} aria-pressed={source} onClick={() => setSource(true)}>Source</button>
      </div>
      <button className="seg-btn" aria-pressed={active} onClick={() => {
        if (active) { setApproved(null); return; }
        const request = { identity, text };
        void confirmAction("Load online images, styles, and fonts for this file while it is open? These requests can reveal reading activity to websites. Scripts and remote audio/video remain blocked.", { okLabel: "Load online resources" }).then(ok => { if (ok) setApproved(request); });
      }}>{active ? "Disable online resources" : "Enable online resources"}</button>
      <button className="seg-btn" disabled={!IN_TAURI} onClick={() => void invoke("browse_open_saved_html", { path: file.path }).catch(reason => setError(String(reason)))}>Open in system browser</button>
      <span>{active ? "Online images, styles and fonts · scripts blocked" : "Offline · scripts blocked"}</span>
    </div>
    {error && <div role="alert">{error}</div>}
    {source ? <pre className="html-source">{text}</pre> : error ? null : !html ? <div className="editor-empty">Rendering…</div> : <iframe key={`${identity}:${active}`} className="html-frame" srcDoc={html}
      sandbox="" referrerPolicy="no-referrer" title={file.name} />}
  </div>;
}
