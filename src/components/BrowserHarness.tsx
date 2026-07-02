import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { archiveRelPath, webSearchUrl } from "../lib/agent";
import { IN_TAURI, writeVaultTextFile } from "../lib/vault";
import { bumpActivityAmount } from "../lib/activity";

// The Pi browser harness. It renders inside a "wing" that slides out from
// BEHIND the Pi agent window (see AgentSurface) — it never covers the
// terminal.
//
// Page loading is two-tier in the desktop app:
//   1. Mesa first fetches the page natively (Rust `browse_fetch`, no CORS) and
//      reads the response headers. If the site allows framing, the iframe
//      loads the real URL — full fidelity.
//   2. If the site forbids framing (X-Frame-Options / CSP frame-ancestors —
//      google.com, github.com, most login pages; previously a silent white
//      rectangle), Mesa renders the fetched HTML in a sandboxed srcdoc
//      "reader mode": a <base> tag resolves the page's own assets, and an
//      injected interceptor forwards link clicks / GET form submits back to
//      the harness so navigation keeps working. Reader-mode frames get NO
//      `allow-same-origin`, so page scripts stay isolated from Mesa.
// In the browser demo (no Rust), the harness falls back to a plain iframe
// with timer-based block detection.

interface BrowsePage {
  finalUrl: string;
  status: number;
  contentType: string;
  frameBlocked: boolean;
  body: string | null;
}

type FrameMode = "start" | "direct" | "reader";

function browserStartHtml(): string {
  return `<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: #050508;
    color: #d8d8d2;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main {
    max-width: 420px;
    padding: 28px;
    border: 1px solid rgba(255,255,255,.14);
    background: rgba(255,255,255,.035);
  }
  h1 { margin: 0 0 10px; font-size: 18px; }
  p { margin: 0; color: rgba(216,216,210,.68); line-height: 1.5; }
</style>
<main>
  <h1>Pi browser</h1>
  <p>Search or enter a URL in the bar above. Mesa keeps this pane quiet until Pi or the user needs the web.</p>
</main>`;
}

/** Interceptor injected into reader-mode pages: forwards link clicks and GET
 * form submissions to the harness via postMessage so navigation works even
 * though the page itself can never re-frame its destination. */
const READER_BRIDGE = `<script>
(function () {
  function go(url) { parent.postMessage({ __mesaBrowse: { url: String(url) } }, "*"); }
  document.addEventListener("click", function (e) {
    var el = e.target;
    var a = el && el.closest ? el.closest("a[href]") : null;
    if (!a || !a.href) return;
    e.preventDefault();
    go(a.href);
  }, true);
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || !f.action) return;
    e.preventDefault();
    try {
      var url = new URL(f.action);
      if ((f.method || "get").toLowerCase() === "get") {
        var qs = new URLSearchParams();
        var data = new FormData(f);
        data.forEach(function (v, k) { if (typeof v === "string") qs.append(k, v); });
        url.search = qs.toString();
      }
      go(url.href);
    } catch (err) { /* unresolvable form target — ignore */ }
  }, true);
})();
</${"script"}>`;

/** Prepare fetched HTML for the sandboxed reader iframe: resolve relative
 * URLs via <base>, drop meta-CSP (it would block our bridge script), and
 * inject the navigation bridge. */
export function buildReaderHtml(rawHtml: string, baseUrl: string): string {
  const safeBase = baseUrl.replace(/"/g, "%22");
  let html = rawHtml
    // meta CSP inside the document would block the injected bridge script.
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "")
    // a page's own <base> would fight ours; ours must win.
    .replace(/<base\s[^>]*>/gi, "");
  const inject = `<base href="${safeBase}">${READER_BRIDGE}`;
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}${inject}`);
  } else {
    html = inject + html;
  }
  return html;
}

export function BrowserHarness({
  externalNav,
  onClose,
}: {
  /** Navigation pushed from outside (the Pi agent's `browse` tool). `seq`
   *  bumps per request so repeating a URL still re-navigates. */
  externalNav?: { url: string; seq: number } | null;
  onClose?: () => void;
}) {
  const vaultPath = useAppStore((s) => s.vaultPath);
  const openVault = useAppStore((s) => s.openVault);
  const openFile = useAppStore((s) => s.openFile);

  const [browserInput, setBrowserInput] = useState("");
  const [browserUrl, setBrowserUrl] = useState("");
  const [mode, setMode] = useState<FrameMode>("start");
  const [readerHtml, setReaderHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [archiveStatus, setArchiveStatus] = useState("");
  // Back/forward stacks; browserUrl holds the current page.
  const [historyBack, setHistoryBack] = useState<string[]>([]);
  const [historyForward, setHistoryForward] = useState<string[]>([]);
  const [frameBlocked, setFrameBlocked] = useState(false);
  const frameLoadedRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const lastPageRef = useRef<BrowsePage | null>(null);
  const loadSeqRef = useRef(0);

  const loadUrl = async (url: string) => {
    setLoadError("");
    setFrameBlocked(false);
    lastPageRef.current = null;
    if (!url) {
      setMode("start");
      setReaderHtml("");
      return;
    }
    if (!IN_TAURI) {
      // Browser demo: direct iframe + timer-based block detection (below).
      setMode("direct");
      return;
    }
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const page = await invoke<BrowsePage>("browse_fetch", { url });
      if (seq !== loadSeqRef.current) return; // superseded by a newer navigation
      lastPageRef.current = page;
      const isHtml =
        page.contentType.includes("html") || page.contentType === "";
      if (!page.frameBlocked || !isHtml || !page.body) {
        // Site allows framing (or is a binary the webview can embed):
        // load it directly for full fidelity.
        setMode("direct");
      } else {
        setMode("reader");
        setReaderHtml(buildReaderHtml(page.body, page.finalUrl));
      }
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      // Native fetch failed (offline, DNS, TLS…). Try the plain iframe so the
      // webview can have a go, and surface the error.
      setMode("direct");
      setLoadError(String(e));
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  };

  const navigate = (rawValue = "", opts?: { skipHistory?: boolean }) => {
    const raw = rawValue.trim();
    const next = raw ? (/^https?:\/\//i.test(raw) ? raw : webSearchUrl(raw)) : "";
    if (!opts?.skipHistory && browserUrl && next !== browserUrl) {
      setHistoryBack((h) => [...h, browserUrl]);
      setHistoryForward([]);
    }
    setBrowserUrl(next);
    setBrowserInput("");
    void loadUrl(next);
  };

  const goBack = () => {
    setHistoryBack((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setHistoryForward((f) => [...f, browserUrl]);
      setBrowserUrl(prev);
      void loadUrl(prev);
      return h.slice(0, -1);
    });
  };

  const goForward = () => {
    setHistoryForward((f) => {
      if (f.length === 0) return f;
      const next = f[f.length - 1];
      setHistoryBack((h) => [...h, browserUrl]);
      setBrowserUrl(next);
      void loadUrl(next);
      return f.slice(0, -1);
    });
  };

  const reloadBrowser = () => {
    if (browserUrl) void loadUrl(browserUrl);
  };

  const goHome = () => {
    if (browserUrl) {
      setHistoryBack((h) => [...h, browserUrl]);
      setHistoryForward([]);
    }
    setBrowserUrl("");
    setBrowserInput("");
    void loadUrl("");
  };

  // Follow the Pi agent's browse tool: navigate whenever a new request lands.
  const lastExternalSeqRef = useRef(0);
  useEffect(() => {
    if (!externalNav || externalNav.seq === lastExternalSeqRef.current) return;
    lastExternalSeqRef.current = externalNav.seq;
    navigate(externalNav.url);
    // navigate() is recreated per render but only state setters are captured;
    // keying on seq keeps this to exactly one navigation per agent request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalNav]);

  // Reader-mode pages postMessage link clicks / form submits back to us.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const url = (e.data as { __mesaBrowse?: { url?: unknown } } | null)
        ?.__mesaBrowse?.url;
      if (typeof url !== "string") return;
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (!/^https?:\/\//i.test(url)) return;
      navigate(url);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  const archive = async () => {
    if (!vaultPath) {
      setArchiveStatus("Open a vault before archiving.");
      return;
    }
    const target = browserUrl || webSearchUrl(browserInput);
    if (!target) {
      setArchiveStatus("Open a page before archiving.");
      return;
    }
    setArchiveStatus("Archiving...");
    const rel = archiveRelPath(target);
    let html = "";
    const cached = lastPageRef.current;
    if (cached?.body && cached.finalUrl && IN_TAURI) {
      // Reuse the natively fetched body — works even for sites that block
      // webview fetch entirely.
      html = cached.body;
    } else {
      try {
        const res = await fetch(target);
        html = await res.text();
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      } catch (e) {
        html = `<!doctype html>
<meta charset="utf-8">
<title>Archived link</title>
<h1>Archived link</h1>
<p><a href="${target}">${target}</a></p>
<p>Mesa could not fetch the page body from this webview. Error: ${String(e)}</p>`;
      }
    }
    await writeVaultTextFile(vaultPath, rel, html);
    bumpActivityAmount(rel, 1.2, "create", "Pi archived a web page");
    await openVault(vaultPath);
    await openFile(rel);
    setArchiveStatus(`Archived ${rel}`);
  };

  const openBrowserExternally = async () => {
    const target = browserUrl || webSearchUrl(browserInput);
    if (!target) return;
    if (IN_TAURI) {
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        new WebviewWindow(`browser-${Date.now().toString(36)}`, {
          url: target,
          title: "Pi browser",
          width: 1100,
          height: 760,
          resizable: true,
        });
        return;
      } catch {
        /* fallback to browser tab below */
      }
    }
    window.open(target, "_blank", "noopener,noreferrer");
  };

  // Demo-mode block detection: no native fetch to consult, so if the frame
  // hasn't loaded shortly after navigation, assume the site refused framing.
  useEffect(() => {
    if (IN_TAURI || mode !== "direct" || !browserUrl) return;
    frameLoadedRef.current = false;
    setFrameBlocked(false);
    const timer = window.setTimeout(() => {
      if (!frameLoadedRef.current) setFrameBlocked(true);
    }, 2400);
    return () => window.clearTimeout(timer);
  }, [mode, browserUrl]);

  const showStart = mode === "start" || !browserUrl;

  return (
    <section className="agent-browser">
      <div className="agent-browser-bar">
        <div className="browser-nav-group">
          <button
            className="browser-nav-btn"
            onClick={goBack}
            disabled={historyBack.length === 0}
            title="Back"
            aria-label="Back"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 3L5 8L10 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            className="browser-nav-btn"
            onClick={goForward}
            disabled={historyForward.length === 0}
            title="Forward"
            aria-label="Forward"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            className="browser-nav-btn"
            onClick={reloadBrowser}
            title="Reload"
            aria-label="Reload"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M13 8a5 5 0 1 1-1.46-3.54M13 2v3h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            className="browser-nav-btn"
            onClick={goHome}
            title="Home"
            aria-label="Home"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.5 7L8 2.5L13.5 7M4 6.5V13.5H12V6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
        <input
          className="text-input browser-url-input"
          value={browserInput}
          placeholder={browserUrl || "Search the web or enter a URL"}
          onChange={(e) => setBrowserInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate(browserInput);
          }}
        />
        <button
          className="browser-nav-btn"
          onClick={() => void openBrowserExternally()}
          title="Open in a separate webview window"
          aria-label="Open in a separate webview window"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6.5 3H3v10h10V9.5M9.5 3H13v3.5M13 3L7.5 8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <button
          className="browser-nav-btn"
          onClick={() => void archive()}
          title="Archive page to vault"
          aria-label="Archive page to vault"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 3.5h12v2.5H2zM3 6.5v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6.5M6.5 9h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        {onClose && (
          <button
            className="browser-nav-btn"
            onClick={onClose}
            title="Close browser"
            aria-label="Close browser"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </button>
        )}
      </div>
      <iframe
        ref={iframeRef}
        className="agent-browser-frame"
        src={!showStart && mode === "direct" ? browserUrl : undefined}
        srcDoc={
          showStart
            ? browserStartHtml()
            : mode === "reader"
              ? readerHtml
              : undefined
        }
        title="Pi browser harness"
        // Reader mode renders untrusted remote HTML from our own origin
        // (srcdoc), so it must NOT get allow-same-origin — that combination
        // would hand page scripts access to Mesa itself.
        sandbox={
          mode === "reader"
            ? "allow-scripts allow-forms allow-popups"
            : "allow-same-origin allow-scripts allow-popups allow-forms allow-modals"
        }
        onLoad={() => {
          frameLoadedRef.current = true;
          setFrameBlocked(false);
        }}
        onError={() => setFrameBlocked(true)}
      />
      {frameBlocked && (
        <div className="agent-browser-fallback">
          <div>
            <strong>This page will not render inside the harness.</strong>
            <span>
              Some websites block embedded browsers. Open it in a separate
              Mesa webview or archive the URL.
            </span>
          </div>
          <button className="btn" onClick={() => void openBrowserExternally()}>
            Open webview
          </button>
        </div>
      )}
      {(mode === "reader" || loading || loadError || archiveStatus) && (
        <div className="agent-browser-status">
          {loading
            ? "Loading…"
            : loadError
              ? `Fetch failed: ${loadError}`
              : mode === "reader"
                ? "Reader view — this site blocks embedding; use ⧉ for the full site."
                : archiveStatus}
          {mode === "reader" && archiveStatus ? ` · ${archiveStatus}` : ""}
        </div>
      )}
    </section>
  );
}
