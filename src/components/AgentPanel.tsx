import { useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import {
  buildAgentContext,
  contextPrompt,
  piActivityLaunch,
  piStartupArgs,
  type ActivityInfo,
} from "../lib/agent";
import { IN_TAURI } from "../lib/vault";
import { claimKeyboardShortcut, isPlainShiftTab } from "../lib/shortcuts";
import { shouldAcceptTerminalOutput } from "../lib/terminalOutput";
import { Modal } from "./Modal";
import { BrowserHarness } from "./BrowserHarness";

interface TerminalEvent {
  sessionId: string;
  stream: "stdout" | "stderr";
  data: string;
}

interface SharedPiSessionState {
  sessionId: string | null;
  vaultPath: string | null;
  terminal: Terminal | null;
  fit: FitAddon | null;
  outputUnlisten: UnlistenFn | null;
  startPromise: Promise<string> | null;
  startingVaultPath: string | null;
  startingContextText: string | null;
  contextText: string | null;
  userInputSeen: boolean;
  outputGeneration: number;
}

const SHARED_PI_THEME = {
  background: "#050508",
  foreground: "#d8d8d2",
  cursor: "#f7f7f2",
  cursorAccent: "#050508",
  selectionBackground: "#3a3a42",
  black: "#050508",
  red: "#ff6b6b",
  green: "#63e58a",
  yellow: "#f1d779",
  blue: "#7ab7ff",
  magenta: "#d690ff",
  cyan: "#78e9ff",
  white: "#f7f7f2",
  brightBlack: "#8a8a8f",
  brightRed: "#ff8585",
  brightGreen: "#7cff9f",
  brightYellow: "#ffe28c",
  brightBlue: "#94c5ff",
  brightMagenta: "#e3a9ff",
  brightCyan: "#92f2ff",
  brightWhite: "#ffffff",
} as const;

const SHARED_PI_SESSION: SharedPiSessionState = {
  sessionId: null,
  vaultPath: null,
  terminal: null,
  fit: null,
  outputUnlisten: null,
  startPromise: null,
  startingVaultPath: null,
  startingContextText: null,
  contextText: null,
  userInputSeen: false,
  outputGeneration: 0,
};

let sharedPiFontSize = 16;
const sharedPiFontSizeListeners = new Set<(size: number) => void>();

// Every mounted AgentSurface host, in mount order. All Pi surfaces share ONE
// xterm DOM element; whichever surface mounts last adopts it. Without this
// registry the element was simply *stolen*: opening the Steam-overlay Pi
// removed the terminal from a docked workspace Pi pane, and closing the
// overlay left that pane permanently empty (and vice versa). On unmount, a
// surface that currently holds the terminal hands it back to the most
// recently mounted surviving host.
const PI_HOST_STACK: HTMLDivElement[] = [];

function reattachSharedPiTerminal(host: HTMLDivElement): void {
  const term = SHARED_PI_SESSION.terminal;
  if (!term?.element) return;
  host.appendChild(term.element);
  try {
    SHARED_PI_SESSION.fit?.fit();
    const id = SHARED_PI_SESSION.sessionId;
    if (id) {
      void invoke("terminal_resize", {
        sessionId: id,
        cols: term.cols,
        rows: term.rows,
      });
    }
    term.focus();
  } catch {
    /* the adopting host may still be laying out; its own observers catch up */
  }
}

function setSharedPiFontSize(next: number): void {
  sharedPiFontSize = next;
  for (const listener of sharedPiFontSizeListeners) listener(next);
  if (SHARED_PI_SESSION.terminal) {
    SHARED_PI_SESSION.terminal.options.fontSize = next;
  }
  SHARED_PI_SESSION.fit?.fit();
}

function getSharedPiTerminal(): Terminal {
  if (SHARED_PI_SESSION.terminal) return SHARED_PI_SESSION.terminal;

  const term = new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: sharedPiFontSize,
    lineHeight: 1.18,
    macOptionIsMeta: true,
    scrollback: 10000,
    tabStopWidth: 8,
    theme: SHARED_PI_THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "Space") {
      event.preventDefault();
      const store = useAppStore.getState();
      store.setPiOverlayOpen(!store.piOverlayOpen);
      return false;
    }
    // Ctrl+Shift+= (Ctrl++)  → enlarge terminal font
    // Ctrl+-                → shrink terminal font
    // Ctrl+0                → reset to default size
    if (event.ctrlKey && !event.altKey && !event.metaKey) {
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        setSharedPiFontSize(Math.min(36, sharedPiFontSize + 1));
        return false;
      }
      if (event.key === "-") {
        event.preventDefault();
        setSharedPiFontSize(Math.max(8, sharedPiFontSize - 1));
        return false;
      }
      if (event.key === "0") {
        event.preventDefault();
        setSharedPiFontSize(16);
        return false;
      }
    }
    // Guard against key-repeat so holding Shift+Tab doesn't flicker the overlay.
    // Uses the debounced store toggle so the app-shell/overlay listeners can't
    // double-fire on a single press and snap it shut.
    if (isPlainShiftTab(event)) {
      claimKeyboardShortcut(event);
      if (event.repeat) return false;
      useAppStore.getState().toggleOverlay();
      return false;
    }
    // Pi's default reasoning-cycle binding is `shift+tab` (sequence ESC [ Z),
    // but Mesa owns plain Shift+Tab for the Steam overlay. To rotate Pi's
    // thinking level while it's embedded in Mesa, press Ctrl+Shift+Tab
    // (Control, NOT Command — Cmd+Shift+Tab is left to the OS). xterm.js
    // drops modifiers on Tab, so we synthesize the ESC [ Z sequence Pi expects
    // and write it straight to the PTY. Alt+Shift+Tab is also accepted as an
    // alternate path that also works on Windows keyboards.
    if (
      event.shiftKey &&
      event.key === "Tab" &&
      !event.metaKey &&
      (event.ctrlKey || event.altKey)
    ) {
      event.preventDefault();
      if (event.repeat) return false;
      const id = SHARED_PI_SESSION.sessionId;
      if (id) void invoke("terminal_write", { sessionId: id, input: "\u001b[Z" });
      return false;
    }
    return true;
  });
  term.onData((input) => {
    const id = SHARED_PI_SESSION.sessionId;
    if (!id) return;
    SHARED_PI_SESSION.userInputSeen = true;
    void invoke("terminal_write", { sessionId: id, input });
  });

  SHARED_PI_SESSION.terminal = term;
  SHARED_PI_SESSION.fit = fit;
  return term;
}

async function stopSharedPiSession(): Promise<void> {
  await disposeSharedPiOutputListener();
  const sessionId = SHARED_PI_SESSION.sessionId;
  if (sessionId) {
    try {
      await invoke("terminal_stop", { sessionId });
    } catch {
      /* ignore stop errors during vault swaps */
    }
  }
  SHARED_PI_SESSION.sessionId = null;
  SHARED_PI_SESSION.vaultPath = null;
  SHARED_PI_SESSION.contextText = null;
  SHARED_PI_SESSION.userInputSeen = false;
}

async function disposeSharedPiOutputListener(): Promise<void> {
  SHARED_PI_SESSION.outputGeneration += 1;
  if (SHARED_PI_SESSION.outputUnlisten) {
    const unlisten = SHARED_PI_SESSION.outputUnlisten;
    SHARED_PI_SESSION.outputUnlisten = null;
    try {
      await (unlisten() as unknown as Promise<void> | void);
    } catch {
      /* ignore stale listener cleanup failures */
    }
  }
}

async function ensureSharedPiSession(
  vaultPath: string,
  ctx: ReturnType<typeof buildAgentContext>,
  contextText: string,
  terminal: Terminal
): Promise<string> {
  if (!IN_TAURI) {
    throw new Error("Browser preview mode: native Pi terminal is unavailable.");
  }

  if (SHARED_PI_SESSION.startPromise) {
    if (
      SHARED_PI_SESSION.startingVaultPath === vaultPath &&
      SHARED_PI_SESSION.startingContextText === contextText
    ) {
      return SHARED_PI_SESSION.startPromise;
    }
    try {
      await SHARED_PI_SESSION.startPromise;
    } catch {
      /* superseded startup failed; re-evaluate below */
    }
    return ensureSharedPiSession(vaultPath, ctx, contextText, terminal);
  }

  if (
    SHARED_PI_SESSION.sessionId &&
    SHARED_PI_SESSION.vaultPath === vaultPath &&
    SHARED_PI_SESSION.contextText !== contextText &&
    !SHARED_PI_SESSION.userInputSeen
  ) {
    await stopSharedPiSession();
  }

  if (SHARED_PI_SESSION.sessionId && SHARED_PI_SESSION.vaultPath === vaultPath) {
    return SHARED_PI_SESSION.sessionId;
  }

  if (SHARED_PI_SESSION.sessionId && SHARED_PI_SESSION.vaultPath !== vaultPath) {
    await stopSharedPiSession();
  }

  SHARED_PI_SESSION.startingVaultPath = vaultPath;
  SHARED_PI_SESSION.startingContextText = contextText;
  SHARED_PI_SESSION.startPromise = (async () => {
    terminal.reset();
    // Start (or reuse) the loopback activity server so Pi's reads/edits/writes
    // light up the living graph. Best-effort: if it fails, Pi still launches —
    // the graph just won't flicker for agent reads. `activity_start` is
    // idempotent, so repeated context restarts don't spawn duplicate servers.
    let activity: ActivityInfo | null = null;
    try {
      activity = await invoke<ActivityInfo>("activity_start");
    } catch {
      activity = null;
    }
    const { env: activityEnv, args: activityArgs } = piActivityLaunch(activity);
    const envs = {
      MESA_VAULT_NAME: ctx.vaultName,
      MESA_VAULT_PATH: ctx.vaultPath ?? "",
      MESA_ACTIVE_PATH: ctx.activePath ?? "",
      MESA_ACTIVE_FILE_PATH: ctx.activeFilePath ?? "",
      MESA_OPEN_PATHS: ctx.openPaths.join("\n"),
      MESA_OPEN_FILE_PATHS: ctx.openFilePaths.join("\n"),
      MESA_CENTER_VIEW: ctx.centerView,
      MESA_RIGHT_VIEWS: ctx.rightViews.join(","),
      MESA_CONTEXT: contextText,
      ...activityEnv,
    };
    const id = await invoke<string>("terminal_start", {
      cwd: vaultPath,
      program: "pi",
      args: [...piStartupArgs(contextText), ...activityArgs],
      envs,
      rows: terminal.rows,
      cols: terminal.cols,
    });
    SHARED_PI_SESSION.sessionId = id;
    SHARED_PI_SESSION.vaultPath = vaultPath;
    SHARED_PI_SESSION.contextText = contextText;
    SHARED_PI_SESSION.userInputSeen = false;
    await disposeSharedPiOutputListener();
    const outputGeneration = SHARED_PI_SESSION.outputGeneration;
    SHARED_PI_SESSION.outputUnlisten = await listen<TerminalEvent>(
      "terminal://output",
      (event) => {
        if (
          !shouldAcceptTerminalOutput({
            eventSessionId: event.payload.sessionId,
            activeSessionId: SHARED_PI_SESSION.sessionId,
            eventGeneration: outputGeneration,
            activeGeneration: SHARED_PI_SESSION.outputGeneration,
          })
        ) {
          return;
        }
        SHARED_PI_SESSION.terminal?.write(event.payload.data);
      }
    );
    return id;
  })();

  try {
    return await SHARED_PI_SESSION.startPromise;
  } finally {
    SHARED_PI_SESSION.startPromise = null;
    SHARED_PI_SESSION.startingVaultPath = null;
    SHARED_PI_SESSION.startingContextText = null;
  }
}

export function AgentSurface({
  embedded = false,
  browserSlideOut = false,
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
  onPlaceInWorkspace?: () => void;
  onClose?: () => void;
}) {
  const vaultName = useAppStore((s) => s.vaultName);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const activePath = useAppStore((s) => s.activePath);
  const openTabs = useAppStore((s) => s.openTabs);
  const settings = useAppStore((s) => s.settings);
  const piBrowse = useAppStore((s) => s.piBrowse);
  const [sessionId, setSessionId] = useState<string | null>(SHARED_PI_SESSION.sessionId);
  const sessionIdRef = useRef<string | null>(SHARED_PI_SESSION.sessionId);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const [terminalSize, setTerminalSize] = useState({ cols: 80, rows: 24 });
  const [fontSize, setFontSize] = useState(sharedPiFontSize);
  // Browser harness wing: slides out from behind the Pi window (slide-out
  // contexts) or opens as an inline sibling (workspace / popped-out window).
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserWidth, setBrowserWidth] = useState(460);
  const browserResizeRef = useRef<{ startX: number; startW: number; sign: 1 | -1 } | null>(
    null
  );

  const ctx = useMemo(
    () =>
      buildAgentContext({
        vaultName,
        vaultPath,
        activePath,
        openTabs,
        settings,
      }),
    [vaultName, vaultPath, activePath, openTabs, settings]
  );
  const contextText = useMemo(() => contextPrompt(ctx), [ctx]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;
    PI_HOST_STACK.push(host);
    const term = getSharedPiTerminal();
    term.options.fontSize = sharedPiFontSize;
    if (!term.element) {
      term.open(host);
    } else if (term.element.parentElement !== host) {
      host.appendChild(term.element);
    }
    term.focus();
    xtermRef.current = term;
    fitRef.current = SHARED_PI_SESSION.fit;
    sharedPiFontSizeListeners.add(setFontSize);
    setFontSize(sharedPiFontSize);

    const syncSize = () => {
      try {
        fitRef.current?.fit();
        const next = { cols: term.cols, rows: term.rows };
        setTerminalSize(next);
        const id = SHARED_PI_SESSION.sessionId;
        if (id) {
          void invoke("terminal_resize", {
            sessionId: id,
            cols: next.cols,
            rows: next.rows,
          });
        }
      } catch {
        /* terminal may not be fully mounted yet */
      }
    };
    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(host);
    const raf = window.requestAnimationFrame(syncSize);

    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      sharedPiFontSizeListeners.delete(setFontSize);
      xtermRef.current = null;
      fitRef.current = null;
      // Hand the shared terminal back to the most recent surviving surface
      // (e.g. closing the Steam overlay restores a docked workspace Pi pane).
      const idx = PI_HOST_STACK.lastIndexOf(host);
      if (idx >= 0) PI_HOST_STACK.splice(idx, 1);
      const el = SHARED_PI_SESSION.terminal?.element;
      if (el && host.contains(el)) {
        const survivor = PI_HOST_STACK[PI_HOST_STACK.length - 1];
        if (survivor) reattachSharedPiTerminal(survivor);
      }
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
        const id = await ensureSharedPiSession(vaultPath, ctx, contextText, term);
        if (!alive) return;
        setSessionId(id);
        if (term === xtermRef.current) {
          term.focus();
          fitRef.current?.fit();
          void invoke("terminal_resize", {
            sessionId: id,
            cols: term.cols,
            rows: term.rows,
          });
        }
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
  }, [vaultPath, contextText]);

  // When the embedded Pi agent uses its `browse` tool, Mesa mirrors the
  // navigation here — pop the wing open so the user can watch the agent work.
  useEffect(() => {
    if (piBrowse) setBrowserOpen(true);
  }, [piBrowse]);

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

  return (
    <div className={"agent-surface terminal-first" + (embedded ? " embedded" : "")}>
      <section className="agent-terminal-pane">
        <div className="pi-terminal-chrome">
          <div className="pi-terminal-title">Pi terminal · {terminalSize.cols}×{terminalSize.rows} · {fontSize}px</div>
          <div className="agent-actions pi-tools">
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
              onClick={() => setBrowserOpen((v) => !v)}
              title={browserOpen ? "Close browser harness" : "Open browser harness"}
              aria-label={browserOpen ? "Close browser harness" : "Open browser harness"}
            >
              ⌕
            </button>
            {onClose && (
              <button
                className="pi-tool"
                onClick={onClose}
                title="Close"
                aria-label="Close"
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

      {browserOpen && (
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
            onClose={() => setBrowserOpen(false)}
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
    </div>
  );
}

export function AgentPanel() {
  const open = useAppStore((s) => s.agentOpen);
  const setOpen = useAppStore((s) => s.setAgentOpen);
  const openAgentWindow = useAppStore((s) => s.openAgentWindow);
  if (!open) return null;
  return (
    <Modal onClose={() => setOpen(false)} className="agent-modal">
      <header className="modal-head">
        <span>Pi agent</span>
        <div className="dock-actions">
          <button
            className="dock-btn"
            onClick={() => {
              setOpen(false);
              void openAgentWindow();
            }}
          >
            Pop out
          </button>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
            ×
          </button>
        </div>
      </header>
      <AgentSurface browserSlideOut />
    </Modal>
  );
}

export function AgentOverlay() {
  const open = useAppStore((s) => s.piOverlayOpen);
  const setOpen = useAppStore((s) => s.setPiOverlayOpen);
  const moveViewToRight = useAppStore((s) => s.moveViewToRight);

  // --- draggable + resizable floating window state -----------------------
  const [win, setWin] = useState({
    x: 0,
    y: 0,
    w: 0, // 0 = use CSS defaults
    h: 0,
  });
  const [initialized, setInitialized] = useState(false);
  const dragState = useRef<{
    mode: "move" | "resize" | null;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  }>({ mode: null, startX: 0, startY: 0, origX: 0, origY: 0, origW: 0, origH: 0 });

  // Center the window on first open.
  useEffect(() => {
    if (!open || initialized) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(720, Math.floor(vw * 0.8));
    const h = Math.min(680, Math.floor(vh * 0.8));
    setWin({
      x: Math.round((vw - w) / 2),
      y: Math.round((vh - h) / 2),
      w,
      h,
    });
    setInitialized(true);
  }, [open, initialized]);

  // Reset position when the overlay is closed so it re-centers next time.
  useEffect(() => {
    if (!open) setInitialized(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // Global mousemove/up for dragging and resizing.
  useEffect(() => {
    if (!open) return;
    const onMove = (e: MouseEvent) => {
      const ds = dragState.current;
      if (!ds.mode) return;
      e.preventDefault();
      const dx = e.clientX - ds.startX;
      const dy = e.clientY - ds.startY;
      if (ds.mode === "move") {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const nx = Math.max(-ds.origW + 80, Math.min(vw - 80, ds.origX + dx));
        const ny = Math.max(0, Math.min(vh - 48, ds.origY + dy));
        setWin((w) => ({ ...w, x: nx, y: ny }));
      } else if (ds.mode === "resize") {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const nw = Math.max(420, Math.min(vw - ds.origX, ds.origW + dx));
        const nh = Math.max(320, Math.min(vh - ds.origY, ds.origH + dy));
        setWin((w) => ({ ...w, w: nw, h: nh }));
      }
    };
    const onUp = () => {
      dragState.current.mode = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [open]);

  const startMove = (e: React.MouseEvent) => {
    // Don't start dragging if clicking on a button.
    if ((e.target as HTMLElement).closest("button")) return;
    dragState.current = {
      mode: "move",
      startX: e.clientX,
      startY: e.clientY,
      origX: win.x,
      origY: win.y,
      origW: win.w,
      origH: win.h,
    };
  };

  const startResize = (e: React.MouseEvent) => {
    e.stopPropagation();
    dragState.current = {
      mode: "resize",
      startX: e.clientX,
      startY: e.clientY,
      origX: win.x,
      origY: win.y,
      origW: win.w,
      origH: win.h,
    };
  };

  if (!open) return null;
  return (
    <div className="pi-overlay">
      <div
        className="pi-overlay-window"
        style={
          initialized
            ? {
                left: win.x,
                top: win.y,
                width: win.w,
                height: win.h,
                transform: "none",
              }
            : undefined
        }
      >
        <div className="pi-overlay-drag" onMouseDown={startMove}>
          <span className="pi-overlay-drag-title">Pi Agent</span>
        </div>
        <AgentSurface
          embedded
          browserSlideOut
          onClose={() => setOpen(false)}
          onPlaceInWorkspace={() => {
            moveViewToRight("agent");
            setOpen(false);
          }}
        />
        <div className="pi-overlay-resize" onMouseDown={startResize} />
      </div>
    </div>
  );
}
