import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { resolveNavTarget } from "../lib/agent";
import { IN_TAURI, writeVaultTextFile } from "../lib/vault";
import { archiveWebPage } from "../lib/webArchive";
import { buildReaderDocument, buildReaderHtml } from "../lib/browserReader";

interface BrowsePage {
  finalUrl: string;
  status: number;
  contentType: string;
  subresourceToken?: string;
  body: string | null;
  truncated?: boolean;
  fragment?: string;
}

function isHtmlPage(page: BrowsePage): boolean {
  const mime = page.contentType.split(";")[0].trim().toLowerCase();
  return mime === "text/html" || mime === "application/xhtml+xml" || (!mime && /^\s*(?:<!doctype\b|<html\b)/i.test(page.body ?? ""));
}
function readerMarkup(page: BrowsePage): string {
  const body = page.body ?? "";
  if (isHtmlPage(page)) return body;
  let pretty = body;
  if (/json/i.test(page.contentType) && body.length < 1024 * 1024) {
    try { pretty = JSON.stringify(JSON.parse(body), null, 2); } catch { /* display original text */ }
  }
  const escaped = pretty.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:13px ui-monospace,monospace">${escaped}</pre>`;
}

export function BrowserHarness({ externalNav, onClose }: {
  externalNav?: { url: string; seq: number } | null;
  onClose?: () => void;
}) {
  const textOnly = useAppStore(s => s.settings.browserTextOnly);
  const setSetting = useAppStore(s => s.setSetting);
  const vaultPath = useAppStore(s => s.vaultPath);
  const registerVaultFile = useAppStore(s => s.registerVaultFile);
  const openFile = useAppStore(s => s.openFile);
  const [input, setInput] = useState("");
  const [url, setUrl] = useState("");
  const [page, setPage] = useState<BrowsePage | null>(null);
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [styleFailures, setStyleFailures] = useState(0);
  const [archiveStatus, setArchiveStatus] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [position, setPosition] = useState(-1);
  const generation = useRef(0);
  const iframe = useRef<HTMLIFrameElement>(null);
  const latestExternal = useRef(0);
  const archiveBusy = useRef(false);

  async function fetchPage(target: string): Promise<BrowsePage> {
    if (IN_TAURI) return invoke<BrowsePage>("browse_fetch", { url: target });
    // Browser demo has no native network broker; it never embeds remote pages.
    throw new Error("Web reading requires the desktop app.");
  }

  async function load(target: string) {
    const current = ++generation.current;
    setUrl(target); setPage(null); setHtml(""); setError(""); setArchiveStatus(""); setStyleFailures(0);
    if (!target) { setLoading(false); return; }
    setLoading(true);
    try {
      const result = await fetchPage(target);
      if (current !== generation.current) {
        if (result.subresourceToken) void invoke("browse_resource_session", { token: result.subresourceToken }).catch(() => {});
        return;
      }
      if (!result.body) {
        if (result.subresourceToken) void invoke("browse_resource_session", { token: result.subresourceToken }).catch(() => {});
        throw new Error("This response has no readable text.");
      }
      result.fragment = new URL(target).hash.slice(1);
      const document = buildReaderHtml(readerMarkup(result), result.finalUrl, result.fragment);
      const visibleUrl = new URL(result.finalUrl); visibleUrl.hash = result.fragment;
      setPage(result); setHtml(document); setUrl(visibleUrl.href);
      if (result.truncated) setError("Page preview was cut off at 4 MB.");
    } catch (reason) {
      if (current === generation.current) setError(String(reason));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  function navigate(value: string) {
    const target = resolveNavTarget(value);
    if (!target) return;
    setHistory(previous => [...previous.slice(0, position + 1), target]);
    setPosition(position + 1); setInput(""); void load(target);
  }
  const latestNavigate = useRef(navigate);
  latestNavigate.current = navigate;

  function move(next: number) {
    if (next < 0 || next >= history.length) return;
    setPosition(next); void load(history[next]);
  }

  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    if (!page?.body || !page.subresourceToken) return;
    let alive = true;
    setStyleFailures(0);
    setHtml(buildReaderHtml(readerMarkup(page), page.finalUrl, page.fragment));
    if (!textOnly && isHtmlPage(page)) {
      const token = page.subresourceToken;
      void buildReaderDocument(page.body, page.finalUrl, { token, proxyBase: convertFileSrc("", "mesa-web"),
        fetchStylesheet: url => invoke<{ css: string; finalUrl: string }>("browse_fetch_stylesheet", { token, url }),
        onStats: stats => { if (alive) setStyleFailures(stats.failed + stats.timedOut); } }, page.fragment)
        .then(document => { if (alive) setHtml(document); }).catch(reason => { if (alive) setError(String(reason)); });
    }
    return () => { alive = false; };
  }, [page, textOnly]);
  useEffect(() => {
    const token = page?.subresourceToken;
    return () => { if (token) void invoke("browse_resource_session", { token }).catch(() => {}); };
  }, [page]);
  useEffect(() => {
    if (!externalNav || externalNav.seq === latestExternal.current) return;
    latestExternal.current = externalNav.seq;
    navigate(externalNav.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Sequence owns one navigation per request.
  }, [externalNav]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow) return;
      const target = (event.data as { __mesaBrowse?: { url?: unknown } } | null)?.__mesaBrowse?.url;
      if (typeof target === "string" && /^https?:\/\//i.test(target)) latestNavigate.current(target);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  async function archive() {
    if (archiveBusy.current) return;
    if (!vaultPath || !url || !page) { setArchiveStatus("Open a vault and a page before archiving."); return; }
    archiveBusy.current = true;
    const root = vaultPath;
    const request = generation.current;
    setArchiveStatus("Archiving…");
    try {
      const result = await archiveWebPage(url, {
        fetchPage,
        writeText: async (rel, text) => {
          if (useAppStore.getState().vaultPath !== root || request !== generation.current) throw new Error("Page or vault changed before archive.");
          await writeVaultTextFile(root, rel, text, { expectedMissing: true });
        },
      }, { cachedPage: page });
      if (useAppStore.getState().vaultPath !== root) return;
      await registerVaultFile(result.relPath);
      if (useAppStore.getState().vaultPath !== root) return;
      await openFile(result.relPath);
      if (request === generation.current) setArchiveStatus(`Archived to ${result.relPath}`);
    } catch (reason) { if (request === generation.current) setArchiveStatus(`Archive failed: ${String(reason)}`); }
    finally { archiveBusy.current = false; }
  }

  return <section className="agent-browser">
    <div className="agent-browser-bar">
      <div className="browser-nav-group">
        <button className="browser-nav-btn" aria-label="Back" title="Back" disabled={position <= 0} onClick={() => move(position - 1)}>←</button>
        <button className="browser-nav-btn" aria-label="Forward" title="Forward" disabled={position + 1 >= history.length} onClick={() => move(position + 1)}>→</button>
        <button className="browser-nav-btn" aria-label="Reload" title="Reload" disabled={!url} onClick={() => void load(url)}>↻</button>
        <button className="browser-nav-btn" aria-label="Home" title="Home" onClick={() => void load("")}>⌂</button>
      </div>
      <input className="text-input browser-url-input" aria-label="Search or page URL" placeholder={url || "Search the web or enter a URL"} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") navigate(input); }} />
      <button className="browser-nav-btn" aria-label="Read page" title="Read page" onClick={() => navigate(input)}>→</button>
      <button className="browser-nav-btn" aria-label="Archive page to vault" title="Archive page to vault" disabled={!page} onClick={() => void archive()}>↓</button>
      <button className="browser-nav-btn" aria-pressed={textOnly} onClick={() => setSetting("browserTextOnly", !textOnly)}>Text only</button>
      <button className="browser-nav-btn" disabled={!url || !IN_TAURI} onClick={() => void openUrl(url).catch(reason => setError(String(reason)))}>Open in system browser</button>
      {onClose && <button className="browser-nav-btn" aria-label="Close browser" title="Close browser" onClick={onClose}>×</button>}
    </div>
    <div className="agent-browser-frame-slot">
      {html ? <iframe ref={iframe} className="agent-browser-frame" srcDoc={html} sandbox="allow-scripts" referrerPolicy="no-referrer" title="Pi browser reader" />
        : <div className="agent-browser-placeholder"><span>{loading ? "Reading page…" : "Search or enter a URL. Pages are read without running website scripts."}</span></div>}
    </div>
    <div className="agent-browser-status"><span>{textOnly ? "Read-only page · text only · website scripts blocked" : "Read-only page · website scripts blocked · styles and images via Mesa"}{page && page.status >= 400 ? ` · HTTP ${page.status}` : ""}</span></div>
    {styleFailures > 0 && <div className="agent-browser-status" role="status">Some styles did not load ({styleFailures}) · Reload to retry</div>}
    {error && <div className="agent-browser-status" role="alert">{error}</div>}
    {archiveStatus && <div className="agent-browser-status" role="status">{archiveStatus}</div>}
  </section>;
}
