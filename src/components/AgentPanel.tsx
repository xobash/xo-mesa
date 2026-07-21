import { useEffect, useMemo, useRef, useState } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import {
  buildAgentContext,
  contextPrompt,
  piActivityLaunch,
  piDeepResearchLaunch,
  piStartupArgs,
  type ActivityInfo,
} from "../lib/agent";
import { IN_TAURI } from "../lib/vault";
import { claimKeyboardShortcut, isPlainShiftTab } from "../lib/shortcuts";
import { shouldAcceptTerminalOutput } from "../lib/terminalOutput";
import { detachedWindowPlacement, isWindowTearOffPoint } from "../lib/windowTearOff";
import { setPiSessionSnapshot, registerSharedPiRestart, onSharedPiRestart } from "../lib/piSessionBridge";
import { BrowserHarness } from "./BrowserHarness";
import { DeepResearchPanel, DeepResearchPhaseChip } from "./DeepResearchPanel";

interface TerminalEvent {
  sessionId: string;
  stream: "stdout" | "stderr";
  data: string;
  seq: number;
}

interface TerminalSnapshot {
  data: string;
  seq: number;
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
  outputGeneration: number;
  lastOutputSeq: number;
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
  outputGeneration: 0,
  lastOutputSeq: 0,
};

// Mirror the identity of the locally-tracked session into a plain lib/
// module so store.ts (window pop-out) can read it without importing this
// component module. See src/lib/piSessionBridge.ts.
function publishPiSessionSnapshot(): void {
  setPiSessionSnapshot({
    sessionId: SHARED_PI_SESSION.sessionId,
    vaultPath: SHARED_PI_SESSION.vaultPath,
    contextText: SHARED_PI_SESSION.contextText,
  });
}

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
    // fit() → term.onResize → terminal_resize (see getSharedPiTerminal): the
    // PTY follows automatically whenever the adopting host's size differs.
    SHARED_PI_SESSION.fit?.fit();
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

// xterm.js is the heaviest npm dependency in the startup path and is only
// needed once a Pi surface actually mounts, so it loads on demand (same
// stance as the pdf-lib split in lib/pdfBytes.ts: keep heavyweight engines
// out of the startup bundle). The in-flight promise is cached because the
// terminal is a shared singleton — concurrent mounts (overlay + docked pane)
// must not race two Terminal instances into existence.
let sharedPiTerminalPromise: Promise<Terminal> | null = null;

function getSharedPiTerminal(): Promise<Terminal> {
  if (SHARED_PI_SESSION.terminal) return Promise.resolve(SHARED_PI_SESSION.terminal);
  if (!sharedPiTerminalPromise) {
    sharedPiTerminalPromise = createSharedPiTerminal();
  }
  return sharedPiTerminalPromise;
}

async function createSharedPiTerminal(): Promise<Terminal> {
  // NOTE: xterm.css stays statically imported in main.tsx — it must sit
  // BEFORE styles.css in the cascade (Mesa's .xterm-host overrides win by
  // order at equal specificity, e.g. viewport overflow-y). Only the JS is
  // deferred; the stylesheet is ~2 kB gzipped.
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);

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
    void invoke("terminal_write", { sessionId: id, input });
  });
  // THE "double text" fix: keep the PTY in lockstep with xterm for EVERY
  // cols/rows change. Pi's TUI redraws its streaming block with cursor-up +
  // rewrite arithmetic based on the PTY's size; when that drifts from what
  // xterm actually renders, logical lines wrap into more physical lines than
  // Pi accounts for, the cursor-up count falls short, and stale partial lines
  // survive above the rewritten block — the doubled text. Previously only the
  // host ResizeObserver propagated size to the PTY, so font-size changes
  // (Ctrl+±, which refit xterm without resizing the host) desynced the two.
  // onResize fires on every real dimension change from any path — one
  // authoritative propagation point.
  term.onResize(({ cols, rows }) => {
    const id = SHARED_PI_SESSION.sessionId;
    if (id) void invoke("terminal_resize", { sessionId: id, cols, rows });
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
  SHARED_PI_SESSION.lastOutputSeq = 0;
  publishPiSessionSnapshot();
}

// Deep Research (and any future feature that changes Pi's launch config) asks
// the store to restart the shared session so it respawns with the new
// extension/env. We stop the live session; the next mounted Pi surface's
// session effect respawns it via ensureSharedPiSession, which reads the
// current store state (including an active Deep Research run) for env/args.
registerSharedPiRestart(async () => {
  if (!SHARED_PI_SESSION.sessionId) return false;
  await stopSharedPiSession();
  return true;
});

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

// Replace whatever output listener is currently wired up with a fresh one
// bound to the session id SHARED_PI_SESSION carries *right now*. Shared by
// every path that starts pointing the shared terminal at a (new or adopted)
// backend session, so the accept/reject generation logic in
// shouldAcceptTerminalOutput only has one implementation to stay correct.
async function attachSharedPiOutputListener(): Promise<void> {
  await disposeSharedPiOutputListener();
  const outputGeneration = SHARED_PI_SESSION.outputGeneration;
  const pending: TerminalEvent[] = [];
  let replaying = true;
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
      if (event.payload.seq <= SHARED_PI_SESSION.lastOutputSeq) return;
      if (replaying) {
        pending.push(event.payload);
        return;
      }
      SHARED_PI_SESSION.lastOutputSeq = event.payload.seq;
      SHARED_PI_SESSION.terminal?.write(event.payload.data);
    }
  );

  const sessionId = SHARED_PI_SESSION.sessionId;
  if (sessionId) {
    try {
      const snapshot = await invoke<TerminalSnapshot>("terminal_snapshot", { sessionId });
      SHARED_PI_SESSION.terminal?.reset();
      SHARED_PI_SESSION.terminal?.write(snapshot.data);
      SHARED_PI_SESSION.lastOutputSeq = snapshot.seq;
    } catch {
      // If the session disappears between attach and replay, draining the
      // already-buffered live events still preserves the best available view.
    }
  }
  replaying = false;
  for (const event of pending) {
    if (event.seq <= SHARED_PI_SESSION.lastOutputSeq) continue;
    SHARED_PI_SESSION.lastOutputSeq = event.seq;
    SHARED_PI_SESSION.terminal?.write(event.data);
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

  // Never silently kill a live Pi session just because the context text
  // drifted (the user switched files). Relaunching here would (a) drop the
  // whole conversation the moment the user clicks another note, and (b) shed
  // any session-scoped env a feature injected at launch — e.g. Deep
  // Research's read-only write-block would silently turn off mid-run. The
  // live session keeps the context it started with until the user explicitly
  // restarts Pi; a fresh context is only used when a brand-new session spawns.
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
    // Deep Research: while a run is active, ALSO load the deep-research
    // extension + mark the run so its fail-safe write/edit block engages for
    // the whole session. Read from the store (not props) so every Pi surface
    // sees the same active run.
    const dr = useAppStore.getState().deepResearch;
    const drActive =
      dr && (dr.phase === "planning" || dr.phase === "researching" || dr.phase === "synthesizing")
        ? dr
        : null;
    const { env: drEnv, args: drArgs } = piDeepResearchLaunch(activity, drActive?.runId ?? "");
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
      ...drEnv,
    };
    const id = await invoke<string>("terminal_start", {
      cwd: vaultPath,
      program: "pi",
      args: [...piStartupArgs(contextText), ...activityArgs, ...drArgs],
      envs,
      rows: terminal.rows,
      cols: terminal.cols,
    });
    SHARED_PI_SESSION.sessionId = id;
    SHARED_PI_SESSION.vaultPath = vaultPath;
    SHARED_PI_SESSION.contextText = contextText;
    SHARED_PI_SESSION.lastOutputSeq = 0;
    publishPiSessionSnapshot();
    await attachSharedPiOutputListener();
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

// Reattach to a Pi session that is already running in the Rust backend but
// unknown to *this* window's SHARED_PI_SESSION module state — the situation
// every time Pi is popped into its own OS window, since a Tauri
// WebviewWindow is a separate JS realm and gets a fresh copy of every
// module-level singleton. `terminal_start` always spawns a brand-new `pi`
// process, so calling it here (as the pre-fix code effectively did, by
// having no other option) is exactly what silently orphaned the original
// session and started a second, contextless one.
//
// Instead: probe the session is still alive with a harmless `terminal_resize`
// (fails if the backend has no such session — e.g. it was independently
// stopped), then point this window's shared terminal at it, same as the tail
// of ensureSharedPiSession's spawn path minus the spawn.
async function adoptSharedPiSession(
  sessionId: string,
  vaultPath: string,
  contextText: string,
  terminal: Terminal
): Promise<string> {
  if (!IN_TAURI) {
    throw new Error("Browser preview mode: native Pi terminal is unavailable.");
  }
  await invoke("terminal_resize", {
    sessionId,
    cols: terminal.cols,
    rows: terminal.rows,
  });

  SHARED_PI_SESSION.sessionId = sessionId;
  SHARED_PI_SESSION.vaultPath = vaultPath;
  SHARED_PI_SESSION.contextText = contextText;
  SHARED_PI_SESSION.lastOutputSeq = 0;
  publishPiSessionSnapshot();
  await attachSharedPiOutputListener();
  return sessionId;
}

export function AgentSurface({
  embedded = false,
  browserSlideOut = false,
  attachSessionId = null,
  windowTitle,
  onTitleBarPointerDown,
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
  /** A Pi session id carried in from another Mesa window that already had
   * one running (currently: the window Pi was popped out of — see
   * `openAgentWindow` in store.ts). Consumed once, on the first session-setup
   * pass: reattaches to that backend session via `adoptSharedPiSession`
   * instead of `ensureSharedPiSession` spawning a brand-new `pi` process,
   * which is what silently dropped the conversation before this existed. */
  attachSessionId?: string | null;
  /** Optional outer-window title. When supplied, the terminal status and Pi
   * tools become the actual title bar instead of a second toolbar beneath it. */
  windowTitle?: string;
  onTitleBarPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
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
  const [fontSize, setFontSize] = useState(sharedPiFontSize);
  // Bumped when the store asks the shared session to restart (Deep Research),
  // so the session effect below re-runs and respawns Pi with the new launch
  // config instead of leaving the session stopped.
  const [restartTick, setRestartTick] = useState(0);
  useEffect(() => onSharedPiRestart(() => setRestartTick((t) => t + 1)), []);
  // Browser harness wing: slides out from behind the Pi window (slide-out
  // contexts) or opens as an inline sibling (workspace / popped-out window).
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserWidth, setBrowserWidth] = useState(460);
  const browserResizeRef = useRef<{ startX: number; startW: number; sign: 1 | -1 } | null>(
    null
  );
  // Deep Research wing: slides out from behind the Pi window exactly like the
  // browser harness wing (it was "hidden behind" the Pi window). The ⌬ tool
  // toggles it; it drives the same shared `deepResearch` run as the overlay's
  // Research window.
  const [researchOpen, setResearchOpen] = useState(false);
  const [researchWingWidth, setResearchWingWidth] = useState(520);
  const researchResizeRef = useRef<{ startX: number; startW: number; sign: 1 | -1 } | null>(null);

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
    // Push synchronously on mount: PI_HOST_STACK order must stay mount order
    // even while the xterm chunk is still loading.
    PI_HOST_STACK.push(host);
    let alive = true;
    let disposeSizeSync: (() => void) | null = null;
    void getSharedPiTerminal().then((term) => {
      if (!alive) return; // surface unmounted before the xterm chunk arrived
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
        const toAttach = pendingAttachRef.current;
        pendingAttachRef.current = null;
        const id =
          toAttach && !SHARED_PI_SESSION.sessionId
            ? await adoptSharedPiSession(toAttach, vaultPath, contextText, term).catch(
                (e) => {
                  console.warn(
                    "[mesa] could not reattach the Pi session handed off from the previous window, starting a new one:",
                    e
                  );
                  return ensureSharedPiSession(vaultPath, ctx, contextText, term);
                }
              )
            : await ensureSharedPiSession(vaultPath, ctx, contextText, term);
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
  }, [termReady, vaultPath, contextText, restartTick]);

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

  return (
    <div className={"agent-surface terminal-first" + (embedded ? " embedded" : "")}>
      <section className="agent-terminal-pane">
        <div
          className={"pi-terminal-chrome" + (windowTitle ? " window-titlebar" : "")}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            onTitleBarPointerDown?.(event);
          }}
        >
          <div className="pi-terminal-heading">
            {windowTitle && <span className="pi-terminal-window-title">{windowTitle}</span>}
            <span className="pi-terminal-title">
              {windowTitle ? "Terminal · " : "Pi terminal · "}
              {terminalSize.cols}×{terminalSize.rows} · {fontSize}px
            </span>
          </div>
          <div className="agent-actions pi-tools">
            <button
              className={"pi-tool" + (researchOpen ? " on" : "")}
              onClick={() => {
                // Prepare the one shared run without opening a duplicate
                // Steam-overlay research window; this button owns the wing.
                useAppStore.getState().openDeepResearch(false);
                setResearchOpen((v) => !v);
              }}
              title="Deep Research"
              aria-label="Deep Research"
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

      {researchOpen && (
        <div
          className={"dr-wing" + (browserSlideOut ? " slide" : " inline")}
          style={browserSlideOut ? { width: researchWingWidth, left: `calc(100% + ${browserOpen ? browserWidth : 0}px)` } : { width: researchWingWidth }}
        >
          {!browserSlideOut && (
            <div
              className="agent-browser-wing-resize left"
              onMouseDown={startResearchResize(-1)}
              aria-hidden="true"
            />
          )}
          <div className="dr-wing-bar">
            <span className="dr-wing-title">Deep Research</span>
            <DeepResearchPhaseChip />
            <button className="pi-tool" onClick={() => setResearchOpen(false)} aria-label="Close Deep Research">
              ×
            </button>
          </div>
          <DeepResearchPanel piSurfaceAvailable />
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

/**
 * The one floating Pi window implementation. Every in-window floating Pi
 * surface (the dedicated Ctrl/Cmd+Left Shift+Space overlay AND the fallback
 * window `agentOpen` opens, e.g. when Deep Research needs a Pi surface or a
 * native pop-out fails) renders THIS component, so they cannot drift apart:
 * one combined title bar (Pi label, terminal status, research/workspace/
 * browser/close tools), drag to move, drag to a workspace edge to tear off
 * into a native OS window, resize from the corner. Mounted only while open.
 */
function PiFloatingWindow({
  onClose,
  onPlaceInWorkspace,
}: {
  onClose: () => void;
  onPlaceInWorkspace: () => void;
}) {
  const openAgentWindow = useAppStore((s) => s.openAgentWindow);

  // --- draggable + resizable floating window state -----------------------
  const [win, setWin] = useState({
    x: 0,
    y: 0,
    w: 0, // 0 = use CSS defaults
    h: 0,
  });
  const [initialized, setInitialized] = useState(false);
  const [tearOffArmed, setTearOffArmed] = useState(false);
  const dragState = useRef<{
    mode: "move" | "resize" | null;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
    grabOffsetX: number;
    grabOffsetY: number;
  }>({
    mode: null,
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
    origW: 0,
    origH: 0,
    grabOffsetX: 0,
    grabOffsetY: 0,
  });

  // Center the window on mount (the component only exists while open, so a
  // reopened window re-centers naturally).
  useEffect(() => {
    if (initialized) return;
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
  }, [initialized]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Pointer capture keeps the drag alive as it crosses the webview edge, which
  // is what makes release-to-native-window tear-off possible.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const ds = dragState.current;
      if (!ds.mode) return;
      e.preventDefault();
      const dx = e.clientX - ds.startX;
      const dy = e.clientY - ds.startY;
      if (ds.mode === "move") {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        setTearOffArmed(isWindowTearOffPoint(e.clientX, e.clientY, vw, vh));
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
    const onUp = (e: PointerEvent) => {
      const ds = dragState.current;
      const detach =
        ds.mode === "move" &&
        isWindowTearOffPoint(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
      dragState.current.mode = null;
      setTearOffArmed(false);
      if (detach) {
        onClose();
        void openAgentWindow(
          detachedWindowPlacement({
            screenX: e.screenX,
            screenY: e.screenY,
            grabOffsetX: ds.grabOffsetX,
            grabOffsetY: ds.grabOffsetY,
            width: ds.origW,
            height: ds.origH,
          })
        );
      }
    };
    const onCancel = () => {
      dragState.current.mode = null;
      setTearOffArmed(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [openAgentWindow, onClose]);

  const startMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // Don't start dragging if clicking on a button.
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort across system webviews */
    }
    setTearOffArmed(false);
    dragState.current = {
      mode: "move",
      startX: e.clientX,
      startY: e.clientY,
      origX: win.x,
      origY: win.y,
      origW: win.w,
      origH: win.h,
      grabOffsetX: e.clientX - win.x,
      grabOffsetY: e.clientY - win.y,
    };
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    dragState.current = {
      mode: "resize",
      startX: e.clientX,
      startY: e.clientY,
      origX: win.x,
      origY: win.y,
      origW: win.w,
      origH: win.h,
      grabOffsetX: 0,
      grabOffsetY: 0,
    };
  };

  return (
    <div className="pi-overlay">
      <div
        className={"pi-overlay-window" + (tearOffArmed ? " tear-off-armed" : "")}
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
        <AgentSurface
          embedded
          browserSlideOut
          windowTitle="Pi agent"
          onTitleBarPointerDown={startMove}
          onClose={onClose}
          onPlaceInWorkspace={onPlaceInWorkspace}
        />
        <div className="pi-overlay-resize" onPointerDown={startResize} />
      </div>
    </div>
  );
}

/**
 * Fallback floating Pi window (`agentOpen`): opened when a feature needs a
 * mounted Pi surface in this window (Deep Research without one, a failed
 * native pop-out). Renders the exact same PiFloatingWindow as the dedicated
 * overlay; when the dedicated overlay is (or becomes) open it yields to it so
 * there is never a second identical window.
 */
export function AgentPanel() {
  const open = useAppStore((s) => s.agentOpen);
  const piOverlayOpen = useAppStore((s) => s.piOverlayOpen);
  const setOpen = useAppStore((s) => s.setAgentOpen);
  const moveViewToRight = useAppStore((s) => s.moveViewToRight);
  useEffect(() => {
    if (open && piOverlayOpen) setOpen(false);
  }, [open, piOverlayOpen, setOpen]);
  if (!open || piOverlayOpen) return null;
  return (
    <PiFloatingWindow
      onClose={() => setOpen(false)}
      onPlaceInWorkspace={() => {
        moveViewToRight("agent");
        setOpen(false);
      }}
    />
  );
}

/** The dedicated Ctrl/Cmd+Left Shift+Space Pi overlay. */
export function AgentOverlay() {
  const open = useAppStore((s) => s.piOverlayOpen);
  const setOpen = useAppStore((s) => s.setPiOverlayOpen);
  const moveViewToRight = useAppStore((s) => s.moveViewToRight);
  if (!open) return null;
  return (
    <PiFloatingWindow
      onClose={() => setOpen(false)}
      onPlaceInWorkspace={() => {
        moveViewToRight("agent");
        setOpen(false);
      }}
    />
  );
}
