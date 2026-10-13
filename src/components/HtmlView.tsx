import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { confirmAction } from "../lib/confirmAction";
import { prepareReaderResources } from "../lib/browserReader";
import { MAX_TEXT_CACHE_FILE_BYTES } from "../lib/textCachePlan";
import { useEffect, useMemo, useState } from "react";
import { stat, readTextFile } from "@tauri-apps/plugin-fs";
import type { VaultFile } from "../types";
import { useAppStore } from "../store";
import { IN_TAURI, urlForPath } from "../lib/vault";
import { MAX_SAVED_HTML_ASSET_CHARS, hydrateSavedHtml, savedFromUrl, savedHtmlFrameDocument } from "../lib/html";

async function readSavedStylesheet(path: string): Promise<string> {
  if (!IN_TAURI) return readTextFile(path);
  const bytes = await invoke<ArrayBuffer>("vault_read_bytes", { path, maxBytes: MAX_SAVED_HTML_ASSET_CHARS, requireComplete: true });
  return new TextDecoder().decode(new Uint8Array(bytes));
}

type HtmlVersion = { identity: string; text: string };

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
  const [approved, setApproved] = useState<HtmlVersion | null>(null);
  const [scriptConsent, setScriptConsent] = useState<{ version: HtmlVersion; online: boolean } | null>(null);
  const [runSession, setRunSession] = useState<{ consent: typeof scriptConsent; url: string } | null>(null);
  const [rendered, setRendered] = useState<{ key: { version: HtmlVersion; active: boolean }; html: string } | null>(null);
  const [error, setError] = useState("");
  const [runError, setRunError] = useState<{ version: HtmlVersion; message: string } | null>(null);
  const text = (providedFile ? undefined : cached) ?? (loaded?.identity === identity ? loaded.text : "");
  const sourceReady = (providedFile ? false : cached !== undefined) || loaded?.identity === identity;
  const documentVersion = useMemo(() => ({ identity, text }), [identity, text]);
  const active = approved === documentVersion;
  const running = scriptConsent?.version === documentVersion;
  const runUrl = running && runSession?.consent === scriptConsent ? runSession.url : null;
  const renderKey = useMemo(() => ({ version: documentVersion, active }), [documentVersion, active]);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      if (!file) return "";
      const size = file.size ?? (providedFile ? (await stat(file.path)).size : undefined);
      if (size !== undefined && size > MAX_TEXT_CACHE_FILE_BYTES) throw new Error(`This HTML file is too large to render (${(size / 1024 / 1024).toFixed(1)} MB). Open in system browser.`);
      if (!providedFile) return ensureContent(rel);
      if (IN_TAURI) {
        const bytes = await invoke<ArrayBuffer>("vault_read_bytes", { path: file.path, maxBytes: MAX_TEXT_CACHE_FILE_BYTES, requireComplete: true });
        return new TextDecoder().decode(new Uint8Array(bytes));
      }
      return readTextFile(file.path);
    };
    void read().then(value => {
      if (alive) { setLoaded({ identity, text: value }); setError(""); }
    }).catch(reason => { if (alive) setError(`Could not read HTML: ${String(reason)}`); });
    return () => { alive = false; };
  }, [rel, identity, ensureContent, providedFile, file]);

  useEffect(() => {
    if (!file || !sourceReady || running || (file.size ?? 0) > MAX_TEXT_CACHE_FILE_BYTES) return;
    setError("");
    let alive = true;
    let token: string | undefined;
    const render = async () => {
      let html = await hydrateSavedHtml(text, file.path, urlForPath, readSavedStylesheet, { vaultRoot: root ?? undefined, scripts: false,
        fonts: { readBytes: async path => new Uint8Array(await invoke<ArrayBuffer>("vault_read_bytes", { path, maxBytes: 2 * 1024 * 1024, requireComplete: true })) } });
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
  }, [text, file, active, renderKey, sourceReady, running, root]);

  useEffect(() => {
    if (!running || !scriptConsent || !file || !IN_TAURI) return;
    let alive = true;
    let token: string | undefined;
    setError("");
    void invoke<string>("html_run_session", { path: file.path, online: scriptConsent.online, expectedText: scriptConsent.version.text }).then(path => {
      token = path.split("/")[0];
      if (!alive) { void invoke("html_run_revoke", { token }).catch(() => {}); return; }
      setRunSession({ consent: scriptConsent, url: convertFileSrc("", "mesa-html") + path });
    }).catch(reason => { if (alive) { setRunError({ version: scriptConsent.version, message: String(reason) }); setScriptConsent(null); } });
    return () => { alive = false; if (token) void invoke("html_run_revoke", { token }).catch(() => {}); };
  }, [running, scriptConsent, file]);

  function runScripts(online: boolean) {
    const request = { version: documentVersion, online };
    void confirmAction(`Run this file's code in an isolated frame? It can read files in this folder.${online ? " Online mode also lets it contact HTTPS websites directly and send folder content to them." : " Network access stays blocked."} Permission ends when the file changes or closes.`, { okLabel: online ? "Run scripts online" : "Run scripts offline" }).then(ok => {
      if (ok) { setRunError(null); setApproved(null); setScriptConsent(request); setSource(false); }
    });
  }

  if (!file) return <div className="editor-empty">File not found.</div>;
  const html = rendered?.key === renderKey ? rendered.html : null;
  return <div className="html-view">
    <div className="html-view-bar">
      <div className="seg">
        <button className={"seg-btn" + (!source ? " on" : "")} aria-pressed={!source} onClick={() => setSource(false)}>Rendered</button>
        <button className={"seg-btn" + (source ? " on" : "")} aria-pressed={source} onClick={() => setSource(true)}>Source</button>
      </div>
      <button className="seg-btn" aria-pressed={active} disabled={running} onClick={() => {
        if (active) { setApproved(null); return; }
        const request = documentVersion;
        void confirmAction("Load online images, styles, and fonts for this file while it is open? These requests can reveal reading activity to websites. Scripts and remote audio/video remain blocked.", { okLabel: "Load online resources" }).then(ok => { if (ok) setApproved(request); });
      }}>{active ? "Disable online resources" : "Enable online resources"}</button>
      <button className="seg-btn" disabled={!IN_TAURI} onClick={() => void invoke("browse_open_saved_html", { path: file.path }).catch(reason => setError(String(reason)))}>Open in system browser</button>
      <button className="seg-btn" disabled={!IN_TAURI || !sourceReady} aria-pressed={running} onClick={() => running ? setScriptConsent(null) : runScripts(false)}>{running ? "Stop scripts" : "Run scripts"}</button>
      {running && <button className="seg-btn" aria-pressed={scriptConsent!.online} onClick={() => scriptConsent!.online ? setScriptConsent({ version: documentVersion, online: false }) : runScripts(true)}>{scriptConsent!.online ? "Disable script network" : "Enable script network"}</button>}
      <span>{running ? `Scripts running · ${scriptConsent!.online ? "online" : "offline"}` : active ? "Online images, styles and fonts · scripts blocked" : "Offline · scripts blocked"}</span>
    </div>
    {error && <div role="alert">{error}</div>}
    {runError?.version === documentVersion && <div role="alert">{runError.message}</div>}
    {source ? <pre className="html-source">{text}</pre> : error ? null : running ? runUrl ? <iframe key={runUrl} className="html-frame" src={runUrl}
      sandbox="allow-scripts" referrerPolicy="no-referrer" allow="" title={file.name} /> : <div className="editor-empty">Starting scripts…</div> : !html ? <div className="editor-empty">Rendering…</div> : <iframe key={`${identity}:${active}`} className="html-frame" srcDoc={html}
      sandbox="" referrerPolicy="no-referrer" title={file.name} />}
  </div>;
}
