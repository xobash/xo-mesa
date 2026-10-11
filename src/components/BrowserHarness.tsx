import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { resolveNavTarget } from "../lib/agent";
import { IN_TAURI, writeVaultTextFile } from "../lib/vault";
import { archiveWebPage } from "../lib/webArchive";
import { buildReaderHtml } from "../lib/browserReader";

interface BrowsePage {
  finalUrl: string;
  status: number;
  contentType: string;
  frameBlocked: boolean;
  body: string | null;
  truncated?: boolean;
}

export function BrowserHarness({ externalNav, onClose }: {
  externalNav?: { url: string; seq: number } | null;
  onClose?: () => void;
}) {
  const vaultPath = useAppStore(s => s.vaultPath);
  const openVault = useAppStore(s => s.openVault);
  const openFile = useAppStore(s => s.openFile);
  const [input, setInput] = useState("");
  const [url, setUrl] = useState("");
  const [page, setPage] = useState<BrowsePage | null>(null);
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
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
    setUrl(target); setPage(null); setHtml(""); setError(""); setArchiveStatus("");
    if (!target) { setLoading(false); return; }
    setLoading(true);
    try {
      const result = await fetchPage(target);
      if (current !== generation.current) return;
      if (!result.body) throw new Error("This response has no readable text.");
      const document = buildReaderHtml(result.body, result.finalUrl);
      setPage(result); setHtml(document); setUrl(result.finalUrl);
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
      await openVault(root);
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
      {onClose && <button className="browser-nav-btn" aria-label="Close browser" title="Close browser" onClick={onClose}>×</button>}
    </div>
    <div className="agent-browser-frame-slot">
      {html ? <iframe ref={iframe} className="agent-browser-frame" srcDoc={html} sandbox="allow-scripts" referrerPolicy="no-referrer" title="Pi browser reader" />
        : <div className="agent-browser-placeholder"><span>{loading ? "Reading page…" : "Search or enter a URL. Pages are read without running website scripts."}</span></div>}
    </div>
    <div className="agent-browser-status"><span>Read-only page · website scripts and remote resources blocked</span></div>
    {error && <div className="agent-browser-status" role="alert">{error}</div>}
    {archiveStatus && <div className="agent-browser-status" role="status">{archiveStatus}</div>}
  </section>;
}
