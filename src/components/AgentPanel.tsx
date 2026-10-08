import { useEffect, useMemo, useRef, useState } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { Channel, invoke } from "@tauri-apps/api/core";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import {
  buildAgentContext,
  contextPrompt,
  type AgentContext,
} from "../lib/agent";
import { IN_TAURI } from "../lib/vault";
import {
  claimKeyboardShortcut,
  claimPlainShiftTabToggle,
  isPlainShiftTab,
  isWindowTransferShortcut,
} from "../lib/shortcuts";
import { keyboardWinPatch } from "../lib/overlayWins";
import { shouldAcceptTerminalOutput } from "../lib/terminalOutput";
import { createLatestTerminalResizeQueue } from "../lib/terminalResize";
import {
  replayTerminalSnapshot,
  createTerminalReplayGate,
  type TerminalSnapshot,
} from "../lib/terminalReplay";
import { piExitMessage, retireExitedPiSession, type PiExitEvent } from "../lib/piExit";
import { detachedWindowPlacement, isWindowTearOffPoint } from "../lib/windowTearOff";
import {
  setPiSessionSnapshot,
  registerSharedPiRestart,
  onSharedPiRestart,
  onSharedPiExit,
  notifySharedPiExit,
} from "../lib/piSessionBridge";
import { BrowserHarness } from "./BrowserHarness";
import { DeepResearchPanel } from "./DeepResearchPanel";
import { DeepResearchPhaseChip } from "./DeepResearchPhaseChip";

interface TerminalEvent {
  sessionId: string;
  stream: "stdout" | "stderr";
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

// One in-flight resize IPC per renderer realm. FitAddon/ResizeObserver can
// report several sizes in one frame; collapsing the burst prevents an older
// async command from landing after the newest dimensions.
const SHARED_PI_RESIZE_QUEUE = createLatestTerminalResizeQueue(
  async ({ sessionId, cols, rows }) => {
    await invoke("terminal_resize", { sessionId, cols, rows });
  }
);

function queueSharedPiResize(term: Terminal): void {
  const sessionId = SHARED_PI_SESSION.sessionId;
  if (!sessionId) return;
  SHARED_PI_RESIZE_QUEUE.enqueue({
    sessionId,
    cols: term.cols,
    rows: term.rows,
  });
}

async function claimSharedPiResizeOwnership(term: Terminal): Promise<void> {
  const sessionId = SHARED_PI_SESSION.sessionId;
  if (!sessionId) return;
  await invoke("terminal_attach", {
    sessionId,
    cols: term.cols,
    rows: term.rows,
  });
}

let resizeFocusListenerInstalled = false;
// While a snapshot replays, `replayTerminalSnapshot` drives `terminal.resize()`
// itself to reproduce the PTY's historical grid timeline; those synthetic sizes
// must not be pushed back to the live PTY. Replay is async and spans many
// frames, though, so a REAL resize (host layout settling, font change) can land
// in the same window — see `reconcileSharedPiSizeAfterReplay`.
let replayingTerminalSnapshot = false;

// Always reconcile PTY dimensions after replay, even when fit() leaves the xterm grid unchanged.
function reconcileSharedPiSizeAfterReplay(term: Terminal): void {
  try {
    SHARED_PI_SESSION.fit?.fit();
  } catch {
    /* the host may still be laying out; its ResizeObserver catches up */
  }
  queueSharedPiResize(term);
}

async function installSharedPiResizeFocusListener(term: Terminal): Promise<void> {
  if (resizeFocusListenerInstalled || !IN_TAURI) return;
  resizeFocusListenerInstalled = true;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) void claimSharedPiResizeOwnership(term);
    });
  } catch {
    resizeFocusListenerInstalled = false;
  }
}

// Mirror the identity of the locally-tracked session into a plain lib/
// module so store.ts (window pop-out) can read it without importing this
// component module. See src/lib/piSessionBridge.ts.
function publishPiSessionSnapshot(): void {
  setPiSessionSnapshot({
    sessionId: SHARED_PI_SESSION.sessionId,
    vaultPath: SHARED_PI_SESSION.vaultPath,
    contextText: SHARED_PI_SESSION.contextText,
    cols: SHARED_PI_SESSION.terminal?.cols ?? 80,
    rows: SHARED_PI_SESSION.terminal?.rows ?? 24,
  });
}

let sharedPiFontSize = 16;
const sharedPiFontSizeListeners = new Set<(size: number) => void>();

// The latest mounted host owns the shared xterm element; unmount returns it to the latest surviving host.
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

// Load xterm on demand and share its in-flight promise across concurrent Pi surfaces.
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
    if (
      !IN_TAURI &&
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      event.code === "Space"
    ) {
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
    // Claim one toggle for the current Tab press. The shared latch stays
    // claimed if Shift is released first, regardless of release order.
    if (event.type === "keydown" && isPlainShiftTab(event)) {
      claimKeyboardShortcut(event);
      if (claimPlainShiftTabToggle(event)) useAppStore.getState().toggleOverlay();
      return false;
    }
    // Mesa owns Shift+Tab. Ctrl+Shift+Tab and Alt+Shift+Tab send Pi its ESC [ Z binding;
    // Command+Shift+Tab remains with the OS.
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
  // Serialize grid changes through the resize queue; native resize ownership rejects obsolete surfaces.
  term.onResize(({ cols, rows }) => {
    if (replayingTerminalSnapshot) return;
    const id = SHARED_PI_SESSION.sessionId;
    if (id) SHARED_PI_RESIZE_QUEUE.enqueue({ sessionId: id, cols, rows });
    publishPiSessionSnapshot();
  });

  SHARED_PI_SESSION.terminal = term;
  SHARED_PI_SESSION.fit = fit;
  void installSharedPiResizeFocusListener(term);
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
  const sessionId = SHARED_PI_SESSION.sessionId;
  if (!sessionId) return;
  const gate = createTerminalReplayGate<TerminalEvent, PiExitEvent>(payload => {
    if (!shouldAcceptTerminalOutput({ eventSessionId: payload.sessionId, activeSessionId: SHARED_PI_SESSION.sessionId, eventGeneration: outputGeneration, activeGeneration: SHARED_PI_SESSION.outputGeneration })) return;
    if (payload.seq <= SHARED_PI_SESSION.lastOutputSeq) return;
    SHARED_PI_SESSION.lastOutputSeq = payload.seq;
    SHARED_PI_SESSION.terminal?.write(payload.data);
  }, exit => {
    if (outputGeneration !== SHARED_PI_SESSION.outputGeneration || !retireExitedPiSession(SHARED_PI_SESSION, exit)) return;
    void disposeSharedPiOutputListener();
    SHARED_PI_SESSION.terminal?.writeln(`\r\n\x1b[33m${piExitMessage(exit.code)}\x1b[0m`);
    publishPiSessionSnapshot(); notifySharedPiExit(exit.code);
  });
  const channel = new Channel<{ event: string; payload: TerminalEvent | PiExitEvent }>();
  channel.onmessage = message => {
    if (outputGeneration !== SHARED_PI_SESSION.outputGeneration) return;
    if (message.event === "terminal://exit") gate.exit(message.payload as PiExitEvent);
    else if (message.event === "terminal://output") gate.output(message.payload as TerminalEvent);
  };
  const subscriptionId = await invoke<string>("terminal_subscribe", { sessionId, onEvent: channel });
  if (outputGeneration !== SHARED_PI_SESSION.outputGeneration) {
    await invoke("terminal_unsubscribe", { sessionId, subscriptionId });
    return;
  }
  SHARED_PI_SESSION.outputUnlisten = async () => { await invoke("terminal_unsubscribe", { sessionId, subscriptionId }); };

  if (sessionId) {
    try {
      const snapshot = await invoke<TerminalSnapshot>("terminal_snapshot", { sessionId });
      if (outputGeneration !== SHARED_PI_SESSION.outputGeneration) return;
      const terminal = SHARED_PI_SESSION.terminal;
      if (terminal) {
        replayingTerminalSnapshot = true;
        try {
          await replayTerminalSnapshot(terminal, snapshot);
        } finally {
          replayingTerminalSnapshot = false;
          reconcileSharedPiSizeAfterReplay(terminal);
        }
      }
      if (outputGeneration !== SHARED_PI_SESSION.outputGeneration) return;
      SHARED_PI_SESSION.lastOutputSeq = snapshot.seq;
    } catch {
      // If the session disappears between attach and replay, draining the
      // already-buffered live events still preserves the best available view.
    }
  }
  gate.complete();
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

  // Changing context must not restart the live session or discard its conversation and launch configuration.
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
    // Deep Research: while a run is active, ALSO load the deep-research
    // extension + mark the run so its fail-safe write/edit block engages for
    // the whole session. Read from the store (not props) so every Pi surface
    // sees the same active run.
    const dr = useAppStore.getState().deepResearch;
    const drActive =
      dr && (dr.phase === "planning" || dr.phase === "researching" || dr.phase === "synthesizing")
        ? dr
        : null;
    const drEnv = drActive ? { MESA_DEEP_RESEARCH: "1", MESA_DEEP_RESEARCH_RUN_ID: drActive.runId } : {};
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
      ...drEnv,
    };
    const id = await invoke<string>("terminal_start", {
      cwd: vaultPath,
      program: "pi",
      args: [],
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

// Separate Tauri windows have separate module state. Attach this renderer to
// the existing native PTY and claim resize ownership before using it.
async function adoptSharedPiSession(
  sessionId: string,
  vaultPath: string,
  contextText: string,
  terminal: Terminal
): Promise<string> {
  if (!IN_TAURI) {
    throw new Error("Browser preview mode: native Pi terminal is unavailable.");
  }
  await invoke("terminal_attach", {
    sessionId,
    handoffToken: new URLSearchParams(window.location.search).get("piHandoff"),
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
  const settings = useAppStore((s) => s.settings);
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
  const [fontSize, setFontSize] = useState(sharedPiFontSize);
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
  const deepResearch = useAppStore((s) => s.deepResearch);
  const researchResizeRef = useRef<{ startX: number; startW: number; sign: 1 | -1 } | null>(null);
  const researchWingRef = useRef<HTMLDivElement | null>(null);
  const [researchDetachArmed, setResearchDetachArmed] = useState(false);

  useEffect(() => {
    browserAutoDismissedRef.current = false;
  }, [deepResearch?.runId]);

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
        settings,
      }),
    [vaultName, vaultPath, activePath, openTabs, settings]
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
      sharedPiFontSizeListeners.delete(setFontSize);
      xtermRef.current = null;
      fitRef.current = null;
      // Hand the shared terminal back to the most recent surviving surface
      // (e.g. closing the Mesa overlay restores a docked workspace Pi pane).
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
            ((deepResearch?.startedAt ?? 0) <= 0
              ? " initial"
              : browserSlideOut
                ? " slide"
                : " inline") +
            (researchDetachArmed ? " tear-off-armed" : "")
          }
          style={(deepResearch?.startedAt ?? 0) <= 0
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

/** Shared floating Pi chrome: combined toolbar, movement, edge tear-off, and corner resize. */
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
        if ((e.target as Element | null)?.closest?.("[data-escape-layer]")) return;
        claimKeyboardShortcut(e);
        onClose();
      }
    };
    // Capture before xterm so Escape has exactly one owner: closing this
    // floating window must not also send ESC into Pi's TUI.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
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
        void openAgentWindow(
          detachedWindowPlacement({
            screenX: e.screenX,
            screenY: e.screenY,
            grabOffsetX: ds.grabOffsetX,
            grabOffsetY: ds.grabOffsetY,
            width: ds.origW,
            height: ds.origH,
          })
        ).then((opened) => {
          if (opened) onClose();
        });
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

  const handleTitleBarKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (isWindowTransferShortcut(event)) {
      claimKeyboardShortcut(event.nativeEvent);
      void openAgentWindow().then((opened) => {
        if (opened) onClose();
      });
      return;
    }
    const next = keyboardWinPatch(
      { ...win, open: true },
      event.key,
      event.shiftKey,
      { width: window.innerWidth, height: window.innerHeight },
      { width: 420, height: 320 }
    );
    if (!next) return;
    claimKeyboardShortcut(event.nativeEvent);
    setWin((current) => ({ ...current, ...next }));
  };

  return (
    <div className="pi-overlay">
      <div
        className={"pi-overlay-window" + (tearOffArmed ? " tear-off-armed" : "")}
        data-native-webview-occluder=""
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
          onTitleBarKeyDown={handleTitleBarKeyDown}
          titleBarHint="Arrow keys move · Shift+Arrow resizes · Ctrl/Cmd+Shift+Enter separates"
          onClose={onClose}
          onPlaceInWorkspace={onPlaceInWorkspace}
        />
        <div className="pi-overlay-resize" onPointerDown={startResize} aria-hidden="true" />
      </div>
    </div>
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
