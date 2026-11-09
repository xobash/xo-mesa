/**
 * The renderer's one shared Pi session: xterm instance, PTY start/adopt/stop,
 * sequenced output subscription and resize ownership. Module state is per
 * webview realm; every Pi surface in a realm uses it, and nothing here ever
 * spawns a second Pi process for a live session.
 */
import type { FitAddon } from "@xterm/addon-fit";
import type { ILinkHandler, Terminal } from "@xterm/xterm";
import { Channel, invoke } from "@tauri-apps/api/core";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import type { buildAgentContext } from "../lib/agent";
import { IN_TAURI } from "../lib/vault";
import { IS_MAC } from "../lib/hotkeys";
import { copyTerminalSelection, terminalClipboardKey, windowsPtyOption } from "../lib/terminalPlatform";
import { confirmAction } from "../lib/confirmAction";
import {
  claimKeyboardShortcut,
  claimPlainShiftTabToggle,
  isPlainShiftTab,
} from "../lib/shortcuts";
import { shouldAcceptTerminalOutput } from "../lib/terminalOutput";
import { createLatestTerminalResizeQueue } from "../lib/terminalResize";
import {
  replayTerminalSnapshot,
  createTerminalReplayGate,
  type TerminalSnapshot,
} from "../lib/terminalReplay";
import { piExitMessage, retireExitedPiSession, type PiExitEvent } from "../lib/piExit";
import {
  setPiSessionSnapshot,
  registerSharedPiRestart,
  notifySharedPiExit,
} from "../lib/piSessionBridge";

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

// Fixed terminal ANSI palette, independent of the Mesa theme. This is the one
// deliberate raw-hex palette outside the style tokens.
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

export const SHARED_PI_SESSION: SharedPiSessionState = {
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

export function queueSharedPiResize(term: Terminal): void {
  const sessionId = SHARED_PI_SESSION.sessionId;
  if (!sessionId) return;
  SHARED_PI_RESIZE_QUEUE.enqueue({
    sessionId,
    cols: term.cols,
    rows: term.rows,
  });
}

export async function claimSharedPiResizeOwnership(term: Terminal): Promise<void> {
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
// frames, though, so a real resize (host layout settling, font change) can land
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

export function getSharedPiFontSize(): number {
  return sharedPiFontSize;
}

export function addSharedPiFontSizeListener(listener: (size: number) => void): void {
  sharedPiFontSizeListeners.add(listener);
}

export function removeSharedPiFontSizeListener(listener: (size: number) => void): void {
  sharedPiFontSizeListeners.delete(listener);
}

// The latest mounted host owns the shared xterm element; unmount returns it to the latest surviving host.
const PI_HOST_STACK: HTMLDivElement[] = [];

/** Pushed synchronously on mount so stack order stays mount order while the xterm chunk loads. */
export function registerSharedPiHost(host: HTMLDivElement): void {
  PI_HOST_STACK.push(host);
}

/** Removes an unmounting host; if it held the shared xterm element, the latest surviving host adopts it. */
export function releaseSharedPiHost(host: HTMLDivElement): void {
  const idx = PI_HOST_STACK.lastIndexOf(host);
  if (idx >= 0) PI_HOST_STACK.splice(idx, 1);
  const el = SHARED_PI_SESSION.terminal?.element;
  if (el && host.contains(el)) {
    const survivor = PI_HOST_STACK[PI_HOST_STACK.length - 1];
    if (survivor) reattachSharedPiTerminal(survivor);
  }
}

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

/**
 * OSC 8 terminal links open only http(s) pages, in Mesa's reader after confirmation;
 * xterm's default would open any target in a new webview window.
 */
export const PI_TERMINAL_LINK_HANDLER: ILinkHandler = {
  allowNonHttpProtocols: false,
  activate(event, uri) {
    event?.preventDefault?.();
    let url: URL;
    try { url = new URL(uri); } catch { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    const href = url.href;
    void confirmAction(`Open ${href} in Mesa's reader? This contacts that website.`, { okLabel: "Read page" })
      .then((ok) => {
        if (ok) useAppStore.setState((s) => ({ piBrowse: { url: href, seq: (s.piBrowse?.seq ?? 0) + 1 } }));
      });
  },
};

// Load xterm on demand and share its in-flight promise across concurrent Pi surfaces.
let sharedPiTerminalPromise: Promise<Terminal> | null = null;

export function getSharedPiTerminal(): Promise<Terminal> {
  if (SHARED_PI_SESSION.terminal) return Promise.resolve(SHARED_PI_SESSION.terminal);
  if (!sharedPiTerminalPromise) {
    sharedPiTerminalPromise = createSharedPiTerminal();
  }
  return sharedPiTerminalPromise;
}

async function createSharedPiTerminal(): Promise<Terminal> {
  // NOTE: xterm.css stays statically imported in main.tsx — it must sit
  // before the Mesa stylesheet in the cascade (Mesa's .xterm-host overrides win by
  // order at equal specificity, e.g. viewport overflow-y). Only the JS is
  // deferred; the stylesheet is ~2 kB gzipped.
  const [{ Terminal }, { FitAddon }, windowsPty] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    windowsPtyOption(navigator),
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
    linkHandler: PI_TERMINAL_LINK_HANDLER,
    macOptionIsMeta: true,
    scrollback: 10000,
    tabStopWidth: 8,
    theme: SHARED_PI_THEME,
    windowsPty,
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
    // Off macOS, Ctrl+C with a selection copies and Ctrl+V pastes. Skipping
    // Ctrl+V lets the webview's native paste reach xterm's textarea.
    const clipboard = terminalClipboardKey(event, term.hasSelection(), IS_MAC);
    if (clipboard === "copy") {
      event.preventDefault();
      // The selection clears only after the write, so the next Ctrl+C is SIGINT
      // and a failed copy stays selected with a status message.
      void copyTerminalSelection(term, navigator.clipboard).then((failure) => {
        if (failure) useAppStore.setState({ status: failure });
      });
      return false;
    }
    if (clipboard === "paste") return false;
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

export async function ensureSharedPiSession(
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
    // Deep Research: while a run is active, also load the deep-research
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
export async function adoptSharedPiSession(
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
