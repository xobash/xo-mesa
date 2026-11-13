import { useEffect, useMemo, useRef, useState } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { useAppStore } from "../store";
import {
  buildAgentContext,
  contextPrompt,
  type AgentContext,
} from "../lib/agent";
import { IN_TAURI } from "../lib/vault";
import { claimKeyboardShortcut, isWindowTransferShortcut } from "../lib/shortcuts";
import { piExitMessage } from "../lib/piExit";
import { onSharedPiRestart, onSharedPiExit } from "../lib/piSessionBridge";
import {
  SHARED_PI_SESSION,
  addSharedPiFontSizeListener,
  adoptSharedPiSession,
  claimSharedPiResizeOwnership,
  ensureSharedPiSession,
  getSharedPiFontSize,
  getSharedPiTerminal,
  queueSharedPiResize,
  registerSharedPiHost,
  releaseSharedPiHost,
  removeSharedPiFontSizeListener,
} from "./piSession";
import { PiFloatingWindow } from "./PiFloatingWindow";
import { BrowserHarness } from "./BrowserHarness";
import { DeepResearchPanel } from "./DeepResearchPanel";
import { DeepResearchPhaseChip } from "./DeepResearchPhaseChip";

let nextAgentSurfaceHostId = 0;

export function AgentSurface({
  embedded = false,
  browserSlideOut = false,
  attachSessionId = null,
  vaultPathOverride = null,
  contextOverride = null,
  windowTitle,
  nativeDragRegion = false,
  onSessionReady,
  onTitleBarPointerDown,
  onTitleBarKeyDown,
  titleBarHint,
  onPlaceInWorkspace,
  onClose,
}: {
  embedded?: boolean;
  /** When true (floating Pi windows), the browser harness slides out from
   * BEHIND the Pi window to its right — the window keeps its size and the
   * terminal is never covered or squeezed. When false (workspace pane /
   * popped-out OS window, where nothing exists beyond the surface's edge),
   * the harness opens as an inline sibling instead. */
  browserSlideOut?: boolean;
  /** Existing PTY session to adopt once during setup; do not spawn a replacement. */
  attachSessionId?: string | null;
  /** Authoritative vault path carried in the detached launch URL. A popout
   * must be able to adopt the existing PTY before its separate store finishes
   * the full vault scan; gating on that scan can make the native window time
   * out before it ever becomes usable. */
  vaultPathOverride?: string | null;
  /** Live context mirrored from the main workspace into a detached renderer.
   * The detached store is a separate JS realm and its launch-time `sel` would
   * otherwise remain stale after the user changes notes in Mesa. */
  contextOverride?: AgentContext | null;
  /** Optional outer-window title. When supplied, the terminal status and Pi
   * tools become the actual title bar instead of a second toolbar beneath it. */
  windowTitle?: string;
  /** Marks the combined Pi toolbar as a Tauri drag region in a decorated
   * detached window. Buttons remain interactive because Tauri drag regions
   * apply only to the element carrying the attribute. */
  nativeDragRegion?: boolean;
  /** Fired after this realm has adopted/started the PTY and subscribed to its
   * sequenced output. Used to make tear-out an acknowledged handoff. */
  onSessionReady?: (sessionId: string) => void | Promise<void>;
  onTitleBarPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onTitleBarKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  titleBarHint?: string;
  onPlaceInWorkspace?: () => void;
  onClose?: () => void;
}) {
  const vaultName = useAppStore((s) => s.vaultName);
  const storeVaultPath = useAppStore((s) => s.vaultPath);
  const vaultPath = vaultPathOverride ?? storeVaultPath;
  const activePath = useAppStore((s) => s.activePath);
  const openTabs = useAppStore((s) => s.openTabs);
  // Primitive and field selectors: research progress and unrelated settings
  // commits must not re-render the Pi surface.
  const centerView = useAppStore((s) => s.settings.centerView);
  const rightStack = useAppStore((s) => s.settings.rightStack);
  const piBrowse = useAppStore((s) => s.piBrowse);
  const deepResearchSurface = useAppStore((s) => s.deepResearchSurface);
  const setDeepResearchSurface = useAppStore((s) => s.setDeepResearchSurface);
  const [researchHostId] = useState(() => `pi-surface-${++nextAgentSurfaceHostId}`);
  const [sessionId, setSessionId] = useState<string | null>(SHARED_PI_SESSION.sessionId);
  const sessionIdRef = useRef<string | null>(SHARED_PI_SESSION.sessionId);
  // Consumed on the first session-setup pass only — later re-runs (context
  // text changes as the user navigates files) go through the normal
  // ensureSharedPiSession reuse/restart logic.
  const pendingAttachRef = useRef<string | null>(attachSessionId);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Flips once the lazily-loaded shared terminal is attached to this surface;
  // the session effect keys on it because xtermRef alone can't retrigger it.
  const [termReady, setTermReady] = useState(false);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const [terminalSize, setTerminalSize] = useState({ cols: 80, rows: 24 });
  const [fontSize, setFontSize] = useState(getSharedPiFontSize);
  // Bumped when the store asks the shared session to restart (Deep Research),
  // so the session effect below re-runs and respawns Pi with the new launch
  // config instead of leaving the session stopped.
  const [restartTick, setRestartTick] = useState(0);
  useEffect(() => onSharedPiRestart(() => setRestartTick((t) => t + 1)), []);
  const [piExit, setPiExit] = useState<{ code: number | null } | null>(null);
  useEffect(() => onSharedPiExit((code) => setPiExit({ code })), []);
  // Browser harness wing: slides out from behind the Pi window (slide-out
  // contexts) or opens as an inline sibling (workspace / popped-out window).
  const [browserOpen, setBrowserOpen] = useState(false);
  const browserAutoDismissedRef = useRef(false);
  const [browserWidth, setBrowserWidth] = useState(460);
  const browserResizeRef = useRef<{ startX: number; startW: number; sign: 1 | -1 } | null>(
    null
  );
  // Deep Research wing: slides out from behind the Pi window exactly like the
  // browser harness wing (it was "hidden behind" the Pi window). The ⌬ tool
  // toggles it; it drives the same shared `deepResearch` run as the overlay's
  // Research window.
  const researchOpen = deepResearchSurface === researchHostId;
  const [researchWingWidth, setResearchWingWidth] = useState(520);
  const researchRunId = useAppStore((s) => s.deepResearch?.runId);
  const researchStarted = useAppStore((s) => (s.deepResearch?.startedAt ?? 0) > 0);
  const researchResizeRef = useRef<{ startX: number; startW: number; sign: 1 | -1 } | null>(null);
  const researchWingRef = useRef<HTMLDivElement | null>(null);
  const [researchDetachArmed, setResearchDetachArmed] = useState(false);

  useEffect(() => {
    browserAutoDismissedRef.current = false;
  }, [researchRunId]);

  useEffect(
    () => () => {
      if (useAppStore.getState().deepResearchSurface === researchHostId) {
        useAppStore.getState().setDeepResearchSurface(null);
      }
    },
    [researchHostId]
  );

  const localCtx = useMemo(
    () =>
      buildAgentContext({
        vaultName,
        vaultPath,
        activePath,
        openTabs,
        // buildAgentContext reads only centerView and rightStack from settings.
        settings: { ...useAppStore.getState().settings, centerView, rightStack },
      }),
    [vaultName, vaultPath, activePath, openTabs, centerView, rightStack]
  );
  const ctx = contextOverride ?? localCtx;
  const contextText = useMemo(() => contextPrompt(ctx), [ctx]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;
    // Push synchronously on mount: PI_HOST_STACK order must stay mount order
    // even while the xterm chunk is still loading.
    registerSharedPiHost(host);
    let alive = true;
    let disposeSizeSync: (() => void) | null = null;
    void getSharedPiTerminal().then((term) => {
      if (!alive) return; // surface unmounted before the xterm chunk arrived
      term.options.fontSize = getSharedPiFontSize();
      if (!term.element) {
        term.open(host);
      } else if (term.element.parentElement !== host) {
        host.appendChild(term.element);
      }
      term.focus();
      xtermRef.current = term;
      fitRef.current = SHARED_PI_SESSION.fit;
      addSharedPiFontSizeListener(setFontSize);
      setFontSize(getSharedPiFontSize());

      const syncSize = () => {
        try {
          // fit() → term.onResize → terminal_resize: PTY propagation is owned
          // by the shared onResize hook so no resize path can be missed.
          fitRef.current?.fit();
          setTerminalSize({ cols: term.cols, rows: term.rows });
        } catch {
          /* terminal may not be fully mounted yet */
        }
      };
      const resizeObserver = new ResizeObserver(syncSize);
      resizeObserver.observe(host);
      syncSize();
      const raf = window.requestAnimationFrame(syncSize);
      disposeSizeSync = () => {
        window.cancelAnimationFrame(raf);
        resizeObserver.disconnect();
      };
      // Tell the session effect the terminal is attached and ready.
      setTermReady(true);
    });

    return () => {
      alive = false;
      disposeSizeSync?.();
      removeSharedPiFontSizeListener(setFontSize);
      xtermRef.current = null;
      fitRef.current = null;
      // Hand the shared terminal back to the most recent surviving surface
      // (e.g. closing the Mesa overlay restores a docked workspace Pi pane).
      releaseSharedPiHost(host);
    };
  }, []);

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (!IN_TAURI || !vaultPath) {
      term.reset();
      term.writeln(
        IN_TAURI
          ? "Open a vault to start Pi."
          : "Browser preview mode: native Pi terminal is unavailable."
      );
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const toAttach = pendingAttachRef.current;
        pendingAttachRef.current = null;
        const id =
          toAttach && !SHARED_PI_SESSION.sessionId
            ? await adoptSharedPiSession(toAttach, vaultPath, contextText, term)
            : await ensureSharedPiSession(vaultPath, ctx, contextText, term);
        if (!alive) return;
        setSessionId(id);
        setPiExit(null);
        if (term === xtermRef.current) {
          term.focus();
          fitRef.current?.fit();
          if (document.hasFocus()) {
            await claimSharedPiResizeOwnership(term);
          } else {
            queueSharedPiResize(term);
          }
        }
        await onSessionReady?.(id);
      } catch (e) {
        term?.writeln("\x1b[31mpi terminal error:\x1b[0m");
        term?.writeln(String(e));
        term?.writeln("");
        term?.writeln("Mesa tried to launch `pi` in a native PTY.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [termReady, vaultPath, contextText, restartTick, onSessionReady, ctx]);

  // When the embedded Pi agent uses its `browse` tool, Mesa mirrors the
  // navigation here — pop the wing open so the user can watch the agent work.
  useEffect(() => {
    if (!piBrowse) return;
    const host = terminalHostRef.current;
    const terminalElement = SHARED_PI_SESSION.terminal?.element;
    // Several Pi hosts can remain mounted for safe handoff, but only the host
    // that currently owns the shared xterm may react by opening chrome.
    if (!host || !terminalElement || !host.contains(terminalElement)) return;
    if (browserAutoDismissedRef.current) return;
    setBrowserOpen(true);
  }, [piBrowse, termReady]);

  // Wing width resize: drag the wing's outer edge. `sign` maps drag direction
  // to width change (+1: dragging right widens — slide-out wing; -1: dragging
  // left widens — inline wing's left edge).
  useEffect(() => {
    if (!browserOpen) return;
    const onMove = (e: MouseEvent) => {
      const rs = browserResizeRef.current;
      if (!rs) return;
      e.preventDefault();
      const dx = (e.clientX - rs.startX) * rs.sign;
      setBrowserWidth(Math.max(320, Math.min(900, rs.startW + dx)));
    };
    const onUp = () => {
      browserResizeRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [browserOpen]);

  const startBrowserResize = (sign: 1 | -1) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    browserResizeRef.current = { startX: e.clientX, startW: browserWidth, sign };
  };

  useEffect(() => {
    if (!researchOpen) return;
    const onMove = (e: MouseEvent) => {
      const rs = researchResizeRef.current;
      if (!rs) return;
      e.preventDefault();
      const dx = (e.clientX - rs.startX) * rs.sign;
      setResearchWingWidth(Math.max(380, Math.min(960, rs.startW + dx)));
    };
    const onUp = () => {
      researchResizeRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [researchOpen]);

  const startResearchResize = (sign: 1 | -1) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    researchResizeRef.current = { startX: e.clientX, startW: researchWingWidth, sign };
  };
  const detachResearch = (rect: DOMRect, dx = 0, dy = 0) => {
    void useAppStore.getState().openResearchWindow({
      x: Math.round(Math.max(4, Math.min(rect.left + dx, Math.max(4, window.innerWidth - 80)))),
      y: Math.round(Math.max(56, Math.min(rect.top + dy, Math.max(56, window.innerHeight - 96)))),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  };
  const startResearchDetach = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const rect = researchWingRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    let detached = false;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const moved = Math.hypot(dx, dy) >= 10;
      detached = detached || moved;
      setResearchDetachArmed(moved);
    };
    const finish = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      document.body.style.userSelect = prevUserSelect;
      setResearchDetachArmed(false);
      if (!detached) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      detachResearch(rect, dx, dy);
    };
    const cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      document.body.style.userSelect = prevUserSelect;
      setResearchDetachArmed(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  };

  const browserNestedInResearch = browserOpen && researchOpen && !browserSlideOut;

  return (
    <div className={"agent-surface terminal-first" + (embedded ? " embedded" : "")}>
      <section className="agent-terminal-pane" data-native-webview-occluder="">
        {piExit && (
          <div className="pi-exit-banner" role="status">
            {piExitMessage(piExit.code)}{" "}
            <button type="button" onClick={() => { setPiExit(null); setRestartTick((t) => t + 1); }}>Restart Pi</button>
          </div>
        )}
        <div
          className={"pi-terminal-chrome" + (windowTitle ? " window-titlebar" : "")}
          data-tauri-drag-region={nativeDragRegion ? "" : undefined}
          tabIndex={windowTitle && (onTitleBarPointerDown || onTitleBarKeyDown) ? 0 : undefined}
          aria-label={windowTitle && titleBarHint ? `${windowTitle} window. ${titleBarHint}` : undefined}
          title={windowTitle && titleBarHint ? titleBarHint : undefined}
          onKeyDown={(event) => {
            if (event.target === event.currentTarget) onTitleBarKeyDown?.(event);
          }}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            onTitleBarPointerDown?.(event);
          }}
        >
          <div
            className="pi-terminal-heading"
            data-tauri-drag-region={nativeDragRegion ? "" : undefined}
          >
            {windowTitle && (
              <span
                className="pi-terminal-window-title"
                data-tauri-drag-region={nativeDragRegion ? "" : undefined}
              >
                {windowTitle}
              </span>
            )}
            <span
              className="pi-terminal-title"
              data-tauri-drag-region={nativeDragRegion ? "" : undefined}
            >
              {windowTitle ? "External process · " : "Pi external process · "}
              {terminalSize.cols}×{terminalSize.rows} · {fontSize}px
            </span>
            {titleBarHint && <span className="pi-window-hint" aria-hidden="true">{titleBarHint}</span>}
          </div>
          <div className="agent-actions pi-tools">
            <button
              className={"pi-tool" + (researchOpen ? " on" : "")}
              onClick={() => {
                // Prepare the one shared run without opening a duplicate
                // Mesa overlay research window; this button owns the wing.
                useAppStore.getState().openDeepResearch(false);
                setDeepResearchSurface(researchOpen ? null : researchHostId);
              }}
              title={researchOpen ? "Close Deep Research" : "Open Deep Research"}
              aria-label={researchOpen ? "Close Deep Research" : "Open Deep Research"}
              aria-pressed={researchOpen}
            >
              ⌬
            </button>
            {onPlaceInWorkspace && (
              <button
                className="pi-tool"
                onClick={onPlaceInWorkspace}
                title="Place Pi in workspace"
                aria-label="Place Pi in workspace"
              >
                ⌗
              </button>
            )}
            <button
              className="pi-tool"
              onClick={() => {
                if (browserOpen) {
                  browserAutoDismissedRef.current = true;
                  setBrowserOpen(false);
                } else {
                  browserAutoDismissedRef.current = false;
                  setBrowserOpen(true);
                }
              }}
              title={browserOpen ? "Close browser harness" : "Open browser harness"}
              aria-label={browserOpen ? "Close browser harness" : "Open browser harness"}
              aria-pressed={browserOpen}
            >
              ⌕
            </button>
            {onClose && (
              <button
                className="pi-tool"
                onClick={onClose}
                title="Close Pi agent"
                aria-label="Close Pi agent"
              >
                ×
              </button>
            )}
          </div>
        </div>

        <div className="agent-context">
          <div>Context</div>
          <div>{ctx.activePath ?? "no active file"}</div>
          <div>{ctx.centerView} / {ctx.rightViews.length ? ctx.rightViews.join(", ") : "none"}</div>
        </div>

        <div
          ref={terminalHostRef}
          className="agent-terminal-output native-pi-terminal xterm-host"
          role="application"
          aria-label="Pi terminal"
          onClick={() => xtermRef.current?.focus()}
        />
      </section>

      {browserOpen && !browserNestedInResearch && (
        <div
          className={"agent-browser-wing" + (browserSlideOut ? " slide" : " inline")}
          style={{ width: browserWidth }}
        >
          {!browserSlideOut && (
            <div
              className="agent-browser-wing-resize left"
              onMouseDown={startBrowserResize(-1)}
              aria-hidden="true"
            />
          )}
          <BrowserHarness
            externalNav={piBrowse}
            onClose={() => {
              browserAutoDismissedRef.current = true;
              setBrowserOpen(false);
            }}
          />
          {browserSlideOut && (
            <div
              className="agent-browser-wing-resize right"
              onMouseDown={startBrowserResize(1)}
              aria-hidden="true"
            />
          )}
        </div>
      )}

      {researchOpen && (
        <div
          ref={researchWingRef}
          data-native-webview-occluder=""
          className={
            "dr-wing" +
            (!researchStarted
              ? " initial"
              : browserSlideOut
                ? " slide"
                : " inline") +
            (researchDetachArmed ? " tear-off-armed" : "")
          }
          style={!researchStarted
            ? undefined
            : browserSlideOut
              ? { width: researchWingWidth, left: `calc(100% + ${browserOpen ? browserWidth : 0}px)` }
              : { width: researchWingWidth }}
        >
          {!browserSlideOut && (
            <div
              className="agent-browser-wing-resize left"
              onMouseDown={startResearchResize(-1)}
              aria-hidden="true"
            />
          )}
          <div
            className="dr-wing-bar"
            onPointerDown={startResearchDetach}
            tabIndex={0}
            aria-label="Deep Research window. Drag to separate, or press Control or Command plus Shift plus Enter."
            title="Drag to separate · Ctrl/Cmd+Shift+Enter"
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (!isWindowTransferShortcut(event)) return;
              claimKeyboardShortcut(event.nativeEvent);
              const rect = researchWingRef.current?.getBoundingClientRect();
              if (rect) detachResearch(rect);
            }}
          >
            <span className="dr-wing-title">Deep Research</span>
            <DeepResearchPhaseChip />
            <span className="dr-window-hint" aria-hidden="true">Drag or Ctrl/Cmd+Shift+Enter to separate</span>
            <button className="pi-tool" onClick={() => setDeepResearchSurface(null)} aria-label="Close Deep Research">
              ×
            </button>
          </div>
          <DeepResearchPanel piSurfaceAvailable />
          {browserNestedInResearch && (
            <div className="dr-browser-nested" aria-label="Research browser">
              <BrowserHarness
                externalNav={piBrowse}
                onClose={() => {
                  browserAutoDismissedRef.current = true;
                  setBrowserOpen(false);
                }}
              />
            </div>
          )}
          {browserSlideOut && (
            <div
              className="agent-browser-wing-resize right"
              onMouseDown={startResearchResize(1)}
              aria-hidden="true"
            />
          )}
        </div>
      )}
    </div>
  );
}


/** The floating Pi window around the shared surface; "place in workspace" docks Pi and closes the window. */
function floatingPi(onClose: () => void, moveViewToRight: (view: "agent") => void) {
  return (
    <PiFloatingWindow onClose={onClose}>
      {(titleBar) => (
        <AgentSurface
          embedded
          browserSlideOut
          windowTitle="Pi agent"
          {...titleBar}
          onClose={onClose}
          onPlaceInWorkspace={() => {
            moveViewToRight("agent");
            onClose();
          }}
        />
      )}
    </PiFloatingWindow>
  );
}

/** Fallback Pi surface yields to the dedicated overlay so only one floating window is visible. */
export function AgentPanel() {
  const open = useAppStore((s) => s.agentOpen);
  const piOverlayOpen = useAppStore((s) => s.piOverlayOpen);
  const setOpen = useAppStore((s) => s.setAgentOpen);
  const moveViewToRight = useAppStore((s) => s.moveViewToRight);
  useEffect(() => {
    if (open && piOverlayOpen) setOpen(false);
  }, [open, piOverlayOpen, setOpen]);
  if (!open || piOverlayOpen) return null;
  return floatingPi(() => setOpen(false), moveViewToRight);
}

/** The dedicated Ctrl/Cmd+Left Shift+Space Pi overlay. */
export function AgentOverlay() {
  const open = useAppStore((s) => s.piOverlayOpen);
  const setOpen = useAppStore((s) => s.setPiOverlayOpen);
  const moveViewToRight = useAppStore((s) => s.moveViewToRight);
  if (!open) return null;
  return floatingPi(() => setOpen(false), moveViewToRight);
}
