import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { archiveRelPath, resolveNavTarget, webSearchUrl } from "../lib/agent";
import { rectsDiffer, rectUsable, roundRect, type HarnessRect } from "../lib/harness";
import { IN_TAURI, writeVaultTextFile } from "../lib/vault";
import { bumpActivityAmount } from "../lib/activity";

// The Pi browser harness. It renders inside a "wing" that slides out from
// BEHIND the Pi agent window (see AgentSurface) — it never covers the
// terminal.
//
// Page loading in the desktop app is NATIVE-first:
//   1. Pages render in a real native child webview (`harness_navigate` /
//      src-tauri/src/harness.rs, Tauri multiwebview) positioned over this
//      component's frame slot. Real JS, real sessions, real Google/YouTube —
//      no more embed-blocked skeletons. An injected reporter streams the
//      rendered DOM back to Mesa so the Pi agent reads exactly what the user
//      sees. The frontend owns the webview's rect (rAF bounds sync below) and
//      its visibility follows the wing.
//   2. If native webview creation fails at runtime, the harness falls back to
//      the legacy two-tier iframe path: `browse_fetch` header check → direct
//      iframe when framing is allowed, sandboxed srcdoc "reader mode" when
//      blocked. The browser demo (no Rust) always uses the legacy path with
//      timer-based block detection.

interface BrowsePage {
  finalUrl: string;
  status: number;
  contentType: string;
  frameBlocked: boolean;
  body: string | null;
}

interface HarnessDiag {
  bounds: [number, number, number, number] | null;
  offset: [number, number];
  titlebarComp: number;
  viewportH: number;
  scale: number;
  innerSize: [number, number];
  outerSize: [number, number];
  innerPos: [number, number];
  outerPos: [number, number];
}

interface HarnessStatus {
  exists: boolean;
  url: string | null;
  title: string | null;
  diag: HarnessDiag | null;
}

const fmtRect = (r: { x: number; y: number; w: number; h: number } | null) =>
  r ? `${r.x},${r.y} ${r.w}×${r.h}` : "—";
const fmtArr = (a: [number, number, number, number] | null) =>
  a ? `${Math.round(a[0])},${Math.round(a[1])} ${Math.round(a[2])}×${Math.round(a[3])}` : "—";

type FrameMode = "start" | "native" | "direct" | "reader";

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
 * inject the navigation bridge. (Legacy/demo path only.) */
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
  // Legacy-path back/forward stacks; in native mode history lives in the real
  // webview (`harness_history`) and these stay untouched.
  const [historyBack, setHistoryBack] = useState<string[]>([]);
  const [historyForward, setHistoryForward] = useState<string[]>([]);
  const [frameBlocked, setFrameBlocked] = useState(false);
  // null = native untried · true = native webview live · false = fell back to
  // the legacy iframe path for the rest of the session.
  const [nativeOk, setNativeOk] = useState<boolean | null>(IN_TAURI ? null : false);
  // Calibration mode: dashed outline on the intended slot rect + a diagnostics
  // row with the native side's numbers and placement nudge buttons. Click the
  // status line to toggle. TEMPORARILY default-on while the macOS webview
  // placement offset is being calibrated on a live build.
  const [debugCal, setDebugCal] = useState(true);
  const [diag, setDiag] = useState<HarnessDiag | null>(null);
  const lastSentRef = useRef<HarnessRect | null>(null);
  const frameLoadedRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameSlotRef = useRef<HTMLDivElement | null>(null);
  const lastPageRef = useRef<BrowsePage | null>(null);
  const loadSeqRef = useRef(0);
  const modeRef = useRef<FrameMode>("start");
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const measureSlot = (): HarnessRect | null => {
    const el = frameSlotRef.current;
    if (!el) return null;
    const rect = roundRect(el.getBoundingClientRect());
    return rectUsable(rect) ? rect : null;
  };

  /** The wing mounts + slides open in the same beat as agent-driven
   * navigations; wait a few frames for a usable rect instead of parking the
   * native webview at a made-up one. */
  const measureSlotSoon = async (): Promise<HarnessRect> => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const rect = measureSlot();
      if (rect) return rect;
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve())
      );
    }
    return { x: 0, y: 0, w: 480, h: 480 };
  };

  // --- legacy iframe path (browser demo + native-failure fallback) ---------
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

  // --- native webview path (desktop default) -------------------------------
  const nativeNavigate = async (url: string) => {
    setLoadError("");
    if (!url) {
      setMode("start");
      void invoke("harness_visibility", { visible: false }).catch(() => {});
      return;
    }
    const rect = await measureSlotSoon();
    lastSentRef.current = rect;
    try {
      await invoke("harness_navigate", { url, ...rect, viewportH: window.innerHeight });
      setNativeOk(true);
      setMode("native");
    } catch (e) {
      // Multiwebview unavailable on this platform/build — legacy path for the
      // rest of the session, and tell the user why fidelity dropped.
      setNativeOk(false);
      setLoadError(`native webview unavailable: ${String(e)}`);
      await loadUrl(url);
    }
  };

  const navigate = (rawValue = "", opts?: { skipHistory?: boolean }) => {
    const next = resolveNavTarget(rawValue);
    const useNative = IN_TAURI && nativeOk !== false;
    if (
      !useNative &&
      !opts?.skipHistory &&
      browserUrl &&
      next !== browserUrl
    ) {
      setHistoryBack((h) => [...h, browserUrl]);
      setHistoryForward([]);
    }
    setBrowserUrl(next);
    setBrowserInput("");
    if (useNative) void nativeNavigate(next);
    else void loadUrl(next);
  };

  const goBack = () => {
    if (mode === "native") {
      void invoke("harness_history", { direction: "back" }).catch(() => {});
      return;
    }
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
    if (mode === "native") {
      void invoke("harness_history", { direction: "forward" }).catch(() => {});
      return;
    }
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
    if (mode === "native") {
      void invoke("harness_history", { direction: "reload" }).catch(() => {});
      return;
    }
    if (browserUrl) void loadUrl(browserUrl);
  };

  const goHome = () => {
    if (mode !== "native" && browserUrl) {
      setHistoryBack((h) => [...h, browserUrl]);
      setHistoryForward([]);
    }
    setBrowserUrl("");
    setBrowserInput("");
    if (mode === "native") {
      setMode("start");
      void invoke("harness_visibility", { visible: false }).catch(() => {});
    } else {
      void loadUrl("");
    }
  };

  // Adopt a still-live native webview when the wing reopens: restore the
  // address bar and keep the page instead of resetting to the start card.
  useEffect(() => {
    if (!IN_TAURI) return;
    let alive = true;
    void invoke<HarnessStatus>("harness_status")
      .then((status) => {
        if (!alive || !status.exists) return;
        if (status.url) setBrowserUrl(status.url);
        setNativeOk(true);
        setMode("native");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Native mode: the webview's visibility follows the wing (mount/unmount).
  useEffect(() => {
    if (mode !== "native") return;
    void invoke("harness_visibility", { visible: true }).catch(() => {});
    return () => {
      void invoke("harness_visibility", { visible: false }).catch(() => {});
    };
  }, [mode]);

  // Native mode: follow the frame slot's on-screen rect every frame (wing
  // slide animation, overlay window drags, pane resizes). Pushes only when
  // the rounded rect actually changes.
  useEffect(() => {
    if (mode !== "native") return;
    let raf = 0;
    let last: HarnessRect | null = null;
    const tick = () => {
      const el = frameSlotRef.current;
      if (el) {
        const rect = roundRect(el.getBoundingClientRect());
        if (rectUsable(rect) && rectsDiffer(last, rect)) {
          last = rect;
          lastSentRef.current = rect;
          void invoke("harness_bounds", { ...rect, viewportH: window.innerHeight }).catch(() => {});
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [mode]);

  // Native mode: the real webview reports where it actually is (redirects,
  // link clicks inside the page, SPA pushState moves) via `mesa://harness-nav`
  // — keep the address bar honest.
  useEffect(() => {
    if (!IN_TAURI) return;
    let unlisten: (() => void) | null = null;
    let alive = true;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const un = await listen<{ url?: string }>("mesa://harness-nav", (ev) => {
          const url = ev.payload?.url;
          if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
          if (modeRef.current === "native") setBrowserUrl(url);
        });
        if (!alive) un();
        else unlisten = un;
      } catch {
        /* @tauri-apps/api/event unavailable */
      }
    })();
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // Calibration mode: poll the native side's view of the placement so the
  // diagnostics row can show both coordinate systems side by side.
  useEffect(() => {
    if (mode !== "native" || !debugCal || !IN_TAURI) return;
    let alive = true;
    const poll = () => {
      void invoke<HarnessStatus>("harness_status")
        .then((s) => {
          if (alive) setDiag(s.diag ?? null);
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [mode, debugCal]);

  // Calibration nudge: shift the native webview by (dx, dy) logical px (or
  // reset), then re-push the last rect so the change applies immediately.
  const nudge = async (dx: number, dy: number, reset = false) => {
    try {
      await invoke("harness_nudge", { dx, dy, reset });
      const rect = lastSentRef.current ?? (await measureSlotSoon());
      await invoke("harness_bounds", { ...rect, viewportH: window.innerHeight });
      const s = await invoke<HarnessStatus>("harness_status");
      setDiag(s.diag ?? null);
    } catch {
      /* calibration is best-effort */
    }
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
      // Legacy path already fetched the body — reuse it.
      html = cached.body;
    } else if (IN_TAURI) {
      // Native mode keeps no fetched body around; grab one now through the
      // shared native client (works even for sites the webview cannot fetch).
      try {
        const page = await invoke<BrowsePage>("browse_fetch", { url: target });
        html = page.body ?? "";
        if (!html) throw new Error(`no text body (${page.contentType || "unknown"})`);
      } catch (e) {
        html = `<!doctype html>
<meta charset="utf-8">
<title>Archived link</title>
<h1>Archived link</h1>
<p><a href="${target}">${target}</a></p>
<p>Mesa could not fetch the page body. Error: ${String(e)}</p>`;
      }
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
  const legacyNav = mode !== "native";

  return (
    <section className="agent-browser">
      <div className="agent-browser-bar">
        <div className="browser-nav-group">
          <button
            className="browser-nav-btn"
            onClick={goBack}
            disabled={legacyNav && historyBack.length === 0}
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
            disabled={legacyNav && historyForward.length === 0}
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
      <div
        ref={frameSlotRef}
        className={
          "agent-browser-frame-slot" +
          (debugCal && mode === "native" ? " debug" : "")
        }
      >
        {mode === "native" && !showStart ? (
          // The native webview paints OVER this placeholder; it only shows
          // through for the first frames while the page spins up.
          <div className="agent-browser-native-host" aria-hidden="true">
            <span>Loading page in the native webview…</span>
          </div>
        ) : (
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
        )}
      </div>
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
      {(mode === "reader" || mode === "native" || loading || loadError || archiveStatus) && (
        <div
          className="agent-browser-status"
          onClick={() => setDebugCal((v) => !v)}
          title="Click to toggle placement calibration"
        >
          {loading
            ? "Loading…"
            : loadError
              ? `Fetch failed: ${loadError}`
              : mode === "reader"
                ? "Reader view — this site blocks embedding; use ⧉ for the full site."
                : mode === "native"
                  ? "Live page — real native webview; Pi reads exactly what you see."
                  : archiveStatus}
          {(mode === "reader" || mode === "native") && archiveStatus
            ? ` · ${archiveStatus}`
            : ""}
        </div>
      )}
      {debugCal && mode === "native" && (
        <div
          className="agent-browser-calib"
          onClick={(e) => e.stopPropagation()}
        >
          <span>
            {`slot ${fmtRect(lastSentRef.current)} · native ${fmtArr(diag?.bounds ?? null)}`}
            {diag
              ? ` · off ${Math.round(diag.offset[0])},${Math.round(diag.offset[1])}` +
                ` (tb ${Math.round(diag.titlebarComp)}, vh ${Math.round(diag.viewportH)})` +
                ` · in ${Math.round(diag.innerSize[0])}×${Math.round(diag.innerSize[1])}` +
                ` out ${Math.round(diag.outerSize[0])}×${Math.round(diag.outerSize[1])}` +
                ` · ipos ${Math.round(diag.innerPos[0])},${Math.round(diag.innerPos[1])}` +
                ` opos ${Math.round(diag.outerPos[0])},${Math.round(diag.outerPos[1])}` +
                ` · s${diag.scale}`
              : " · waiting for native diag…"}
          </span>
          <span className="agent-browser-calib-buttons">
            <button onClick={() => void nudge(0, -6)} title="Move webview up 6px">▲</button>
            <button onClick={() => void nudge(0, 6)} title="Move webview down 6px">▼</button>
            <button onClick={() => void nudge(-6, 0)} title="Move webview left 6px">◀</button>
            <button onClick={() => void nudge(6, 0)} title="Move webview right 6px">▶</button>
            <button onClick={() => void nudge(0, 0, true)} title="Reset nudge">0</button>
          </span>
        </div>
      )}
    </section>
  );
}
