// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { payload: unknown }) => unknown;

const h = vi.hoisted(() => {
  const listeners = new Map<string, Handler[]>();
  const unlistened: string[] = [];
  const closeHandlers: Array<(event: { preventDefault(): void }) => Promise<void>> = [];
  const win = {
    onCloseRequested: vi.fn(async (cb: (event: { preventDefault(): void }) => Promise<void>) => {
      closeHandlers.push(cb);
      return () => { unlistened.push("close"); };
    }),
    close: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    setFocus: vi.fn(async () => {}),
  };
  const webview = { setFocus: vi.fn(async () => {}) };
  const defaultListen = async (event: string, handler: Handler) => {
    const list = listeners.get(event) ?? [];
    list.push(handler);
    listeners.set(event, list);
    return () => {
      unlistened.push(event);
      listeners.set(event, (listeners.get(event) ?? []).filter((x) => x !== handler));
    };
  };
  return {
    defaultListen,
    listen: vi.fn(defaultListen),
    flags: { tauri: true },
    listeners,
    unlistened,
    closeHandlers,
    win,
    webview,
    invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined),
    emit: vi.fn(async (_event: string, _payload?: unknown) => {}),
    emitTo: vi.fn(async (_label: string, _event: string, _payload?: unknown) => {}),
    answerViewRequest: vi.fn(async () => {}),
    prune: vi.fn(async () => {}),
    loadRecentVaults: vi.fn(async (): Promise<{ entries: Array<{ id: string; label: string }>; last: string | null }> => ({ entries: [], last: null })),
    resolveRecentVault: vi.fn(async (id: string) => `/resolved/${id}`),
  };
});

vi.mock("../lib/vault", async (original) => {
  const actual = await original<Record<string, unknown>>();
  return { ...actual, get IN_TAURI() { return h.flags.tauri; } };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<object>(),
  invoke: (cmd: string, args?: unknown) => h.invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: Handler) => h.listen(event, handler),
  emit: (event: string, payload?: unknown) => h.emit(event, payload),
  emitTo: (label: string, event: string, payload?: unknown) => h.emitTo(label, event, payload),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => h.win }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => h.webview }));
vi.mock("../lib/viewCapture", () => ({ answerViewRequest: h.answerViewRequest }));
vi.mock("../lib/graphWindowBootstrap", () => ({ pruneGraphWindowBootstraps: h.prune }));
vi.mock("../lib/persistedUi", async (original) => ({
  ...await original<object>(),
  loadRecentVaults: h.loadRecentVaults,
  resolveRecentVault: h.resolveRecentVault,
}));

import { useAppStore, type AppState } from "../store";
import { useMainWindowEffects } from "./useMainWindowEffects";
import { DOCUMENT_CATALOG_EVENT, DOCUMENT_CATALOG_REQUEST_EVENT } from "./DocumentView";
import { AGENT_CONTEXT_EVENT } from "../lib/piSessionBridge";
import { DOCK_WINDOW_EVENT, GLOBAL_AGENT_EVENT } from "../lib/windowDock";
import type { BlockedClose } from "../lib/closeGuard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Props {
  mainWindow?: boolean;
  vaultPath?: string | null;
  unavailableVault?: AppState["unavailableVault"];
  openVault?: AppState["openVault"];
  requestedVault?: string;
  onBlocked?: BlockedClose;
}

const initial = useAppStore.getState();
let host: HTMLDivElement;
let root: Root;
let appRoot: HTMLDivElement | null = null;

function Harness(props: Props & { openVault: AppState["openVault"]; onBlocked: BlockedClose }) {
  const appRootRef = useRef<HTMLDivElement | null>(null);
  useMainWindowEffects({
    mainWindow: props.mainWindow ?? true,
    vaultPath: props.vaultPath === undefined ? "/vault" : props.vaultPath,
    unavailableVault: props.unavailableVault ?? null,
    openVault: props.openVault,
    requestedVault: props.requestedVault ?? "",
    onBlocked: props.onBlocked,
    appRootRef,
  });
  return <div ref={(el) => { appRootRef.current = el; appRoot = el; }} tabIndex={-1} />;
}

const defaults = () => ({
  openVault: vi.fn(async () => {}) as unknown as AppState["openVault"],
  onBlocked: vi.fn(async () => "keep" as const) as BlockedClose,
});

async function mount(props: Props = {}) {
  const full = { ...defaults(), ...props };
  await act(async () => root.render(<Harness {...full} />));
  return full;
}

function fire(event: string, payload: unknown) {
  const list = h.listeners.get(event) ?? [];
  expect(list.length).toBeGreaterThan(0);
  return Promise.all(list.map((fn) => fn({ payload })));
}

const waitListening = (event: string) =>
  vi.waitFor(() => expect(h.listeners.get(event)?.length ?? 0).toBeGreaterThan(0));

const invoked = (cmd: string) => h.invoke.mock.calls.filter(([c]) => c === cmd);

beforeEach(() => {
  h.flags.tauri = true;
  h.listeners.clear();
  h.unlistened.length = 0;
  h.closeHandlers.length = 0;
  vi.clearAllMocks();
  h.listen.mockImplementation(h.defaultListen);
  h.invoke.mockImplementation(async () => undefined);
  localStorage.setItem("mesa:toured", "1");
  useAppStore.setState(initial, true);
  useAppStore.setState({
    vaultPath: "/vault",
    vaultName: "Vault",
    activePath: null,
    openTabs: [],
    files: [],
    status: "",
    keyboardFocus: { region: "center", rightIndex: 0 },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  useAppStore.setState(initial, true);
});

describe("main-window guard", () => {
  it("a detached window registers no listener, guard or context publish", async () => {
    const openVault = vi.fn(async () => {}) as unknown as AppState["openVault"];
    useAppStore.setState({ vaultPath: null });
    await mount({ mainWindow: false, vaultPath: null, openVault });
    await act(async () => { await Promise.resolve(); });
    expect(h.listen).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.win.onCloseRequested).not.toHaveBeenCalled();
    expect(h.prune).not.toHaveBeenCalled();
    expect(openVault).not.toHaveBeenCalled();
    const setPalette = vi.fn();
    useAppStore.setState({ setPalette });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, metaKey: true, cancelable: true })); });
    expect(setPalette).not.toHaveBeenCalled();
  });

  it("unmount releases every native listener and arms then disarms the quit guard", async () => {
    await mount();
    await Promise.all([DOCUMENT_CATALOG_REQUEST_EVENT, "mesa://view-request", "mesa://quit-requested", DOCK_WINDOW_EVENT, GLOBAL_AGENT_EVENT, "mesa://update-status"].map(waitListening));
    await vi.waitFor(() => expect(h.closeHandlers).toHaveLength(1));
    await vi.waitFor(() => expect(invoked("quit_guard_arm")).toHaveLength(1));
    await act(async () => root.unmount());
    expect(new Set(h.unlistened)).toEqual(new Set([
      DOCUMENT_CATALOG_REQUEST_EVENT, "mesa://view-request", "mesa://quit-requested", DOCK_WINDOW_EVENT, GLOBAL_AGENT_EVENT, "close",
      "mesa://update-status",
    ]));
    expect(invoked("quit_guard_disarm")).toHaveLength(1);
    root = createRoot(host);
  });

  it("a listener that registers after unmount is released at once", async () => {
    const pending: Array<() => void> = [];
    h.listen.mockImplementation((name: string) => new Promise<() => void>((resolve) => {
      pending.push(() => resolve(() => { h.unlistened.push(name); }));
    }));
    await mount();
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(h.unlistened.filter((name) => name !== "close")).toEqual([]);
    for (const resolve of pending) resolve();
    await vi.waitFor(() => expect(h.unlistened).toEqual(expect.arrayContaining([
      DOCUMENT_CATALOG_REQUEST_EVENT, "mesa://view-request", "mesa://quit-requested", DOCK_WINDOW_EVENT,
    ])));
    // The quit guard was never armed for a window that is already gone.
    expect(invoked("quit_guard_arm")).toHaveLength(0);
  });
});

describe("catalog and view-request bridges", () => {
  it("answers only detached document windows that name the open vault", async () => {
    const files = [{ path: "a.md" }] as unknown as AppState["files"];
    useAppStore.setState({ files });
    await mount();
    await waitListening(DOCUMENT_CATALOG_REQUEST_EVENT);
    await fire(DOCUMENT_CATALOG_REQUEST_EVENT, { label: "doc-1", vault: "/vault" });
    await fire(DOCUMENT_CATALOG_REQUEST_EVENT, { label: "graph-1", vault: "/vault" });
    await fire(DOCUMENT_CATALOG_REQUEST_EVENT, { label: "doc-2", vault: "/other" });
    await fire(DOCUMENT_CATALOG_REQUEST_EVENT, null);
    expect(h.emitTo).toHaveBeenCalledTimes(1);
    expect(h.emitTo).toHaveBeenCalledWith("doc-1", DOCUMENT_CATALOG_EVENT, { vault: "/vault", files });
  });

  it("a failed catalog delivery is reported, not thrown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.emitTo.mockRejectedValueOnce(new Error("gone"));
    await mount();
    await waitListening(DOCUMENT_CATALOG_REQUEST_EVENT);
    await fire(DOCUMENT_CATALOG_REQUEST_EVENT, { label: "doc-1", vault: "/vault" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[mesa] document catalog delivery failed:", expect.any(Error)));
    warn.mockRestore();
  });

  it("view requests capture the current document and center view", async () => {
    useAppStore.setState({ activePath: "notes/a.md" });
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, centerView: "doc" } });
    await mount();
    await waitListening("mesa://view-request");
    await fire("mesa://view-request", "req-7");
    await vi.waitFor(() => expect(h.answerViewRequest).toHaveBeenCalledWith("req-7", "notes/a.md", "doc"));
  });
});

describe("Pi context publication", () => {
  it("publishes vault-relative context once per relevant change", async () => {
    useAppStore.setState({ activePath: "notes/a.md", openTabs: ["notes/a.md"] });
    await mount();
    await vi.waitFor(() => expect(invoked("activity_set_context")).toHaveLength(1));
    const first = (invoked("activity_set_context")[0][1] as { context: string }).context;
    expect(first).toContain("Current document: notes/a.md");
    expect(first).not.toContain("/vault/notes");
    await vi.waitFor(() => expect(h.emit).toHaveBeenCalledWith(AGENT_CONTEXT_EVENT, expect.objectContaining({ activePath: "notes/a.md" })));

    // A store change that does not touch context never republishes, and
    // neither does a settings change outside the two views context names.
    act(() => useAppStore.setState({ status: "typing" }));
    act(() => useAppStore.setState((s) => ({ settings: { ...s.settings, rightWidth: s.settings.rightWidth + 40 } })));
    await act(async () => { await Promise.resolve(); });
    expect(invoked("activity_set_context")).toHaveLength(1);
    expect(h.emit.mock.calls.filter(([name]) => name === AGENT_CONTEXT_EVENT)).toHaveLength(1);

    act(() => useAppStore.setState({ activePath: "notes/b.md" }));
    await vi.waitFor(() => expect(invoked("activity_set_context")).toHaveLength(2));
    expect((invoked("activity_set_context")[1][1] as { context: string }).context).toContain("Current document: notes/b.md");

    act(() => useAppStore.setState((s) => ({ settings: { ...s.settings, rightStack: ["graph"] } })));
    await vi.waitFor(() => expect(invoked("activity_set_context")).toHaveLength(3));
    expect((invoked("activity_set_context")[2][1] as { context: string }).context).toContain("side views: graph");
  });

  it("without a vault it clears Pi's context and sends no context event", async () => {
    useAppStore.setState({ vaultPath: null });
    await mount({ vaultPath: null, requestedVault: "/req" });
    await vi.waitFor(() => expect(invoked("activity_set_context")).toEqual([["activity_set_context", { context: "" }]]));
    expect(h.emit).not.toHaveBeenCalledWith(AGENT_CONTEXT_EVENT, expect.anything());
  });

  it("a failed publish is reported", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "activity_set_context") throw new Error("ipc down");
      return undefined;
    });
    await mount();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[mesa] Pi context publish failed:", expect.any(Error)));
    warn.mockRestore();
  });
});

describe("close and quit guards", () => {
  const withSaves = (flushSave: () => Promise<void>) =>
    useAppStore.setState({ flushSave, dirtyBinaryPaths: [], textSaveState: { ...useAppStore.getState().textSaveState, pending: 0 } });

  it("a close request flushes saves, then hides when native says main can hide", async () => {
    const flushSave = vi.fn(async () => {});
    withSaves(flushSave);
    h.invoke.mockImplementation(async (cmd: string) => (cmd === "main_close_hides" ? true : undefined));
    await mount();
    await vi.waitFor(() => expect(h.closeHandlers).toHaveLength(1));
    const preventDefault = vi.fn();
    await act(async () => { await h.closeHandlers[0]({ preventDefault }); });
    expect(preventDefault).toHaveBeenCalled();
    expect(flushSave).toHaveBeenCalled();
    expect(h.win.hide).toHaveBeenCalledTimes(1);
    expect(invoked("quit_after_save")).toHaveLength(0);
  });

  it("a close request quits when main cannot hide", async () => {
    withSaves(vi.fn(async () => {}));
    h.invoke.mockImplementation(async (cmd: string) => (cmd === "main_close_hides" ? false : undefined));
    await mount();
    await vi.waitFor(() => expect(h.closeHandlers).toHaveLength(1));
    await act(async () => { await h.closeHandlers[0]({ preventDefault: () => {} }); });
    expect(h.win.hide).not.toHaveBeenCalled();
    expect(invoked("quit_after_save")).toHaveLength(1);
  });

  it("a failed flush keeps the window, reports and asks the blocked-close handler", async () => {
    withSaves(vi.fn(async () => { throw new Error("disk changed"); }));
    const onBlocked = vi.fn(async () => "keep" as const);
    await mount({ onBlocked });
    await vi.waitFor(() => expect(h.closeHandlers).toHaveLength(1));
    await act(async () => { await h.closeHandlers[0]({ preventDefault: () => {} }); });
    expect(useAppStore.getState().status).toMatch(/^Close stopped: .*disk changed/);
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(h.win.hide).not.toHaveBeenCalled();
    expect(invoked("quit_after_save")).toHaveLength(0);
  });

  it("Quit saves text first, then quits", async () => {
    const flushSave = vi.fn(async () => {});
    withSaves(flushSave);
    await mount();
    await waitListening("mesa://quit-requested");
    await act(async () => { await fire("mesa://quit-requested", null); });
    expect(flushSave).toHaveBeenCalled();
    expect(useAppStore.getState().status).toBe("Text saved. Closing Mesa…");
    expect(invoked("quit_after_save")).toHaveLength(1);
  });

  it("Quit with a dirty PDF stops, and quits only when the user discards", async () => {
    useAppStore.setState({ flushSave: vi.fn(async () => {}), dirtyBinaryPaths: ["doc.pdf"] });
    const onBlocked = vi.fn<BlockedClose>(async () => "keep");
    await mount({ onBlocked });
    await waitListening("mesa://quit-requested");
    await act(async () => { await fire("mesa://quit-requested", null); });
    expect(useAppStore.getState().status).toMatch(/^Quit stopped: .*doc\.pdf/);
    expect(invoked("quit_after_save")).toHaveLength(0);

    onBlocked.mockResolvedValueOnce("discard");
    await act(async () => { await fire("mesa://quit-requested", null); });
    expect(onBlocked).toHaveBeenCalledTimes(2);
    expect(invoked("quit_after_save")).toHaveLength(1);
  });

  it("a second Quit while the first is saving is ignored", async () => {
    let release!: () => void;
    const flushSave = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    withSaves(flushSave);
    await mount();
    await waitListening("mesa://quit-requested");
    const first = fire("mesa://quit-requested", null);
    await act(async () => { await fire("mesa://quit-requested", null); });
    expect(flushSave).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().status).toBe("Saving text before Quit…");
    await act(async () => { release(); await first; });
    expect(invoked("quit_after_save")).toHaveLength(1);
  });

  it("a quit guard that cannot arm is reported", async () => {
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "quit_guard_arm") throw new Error("no native");
      return undefined;
    });
    await mount();
    await vi.waitFor(() => expect(useAppStore.getState().status).toBe("Quit safety failed to start: Error: no native"));
  });
});

describe("startup", () => {
  it("prunes stale graph bootstraps and loads sync secrets only when sync needs them", async () => {
    const loadSyncSecrets = vi.fn(async () => {});
    useAppStore.setState({ loadSyncSecrets, settings: { ...useAppStore.getState().settings, syncEnabled: false, syncToken: "", peers: [] } });
    await mount();
    expect(h.prune).toHaveBeenCalledTimes(1);
    expect(loadSyncSecrets).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(host);
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, syncEnabled: true } });
    await mount();
    expect(loadSyncSecrets).toHaveBeenCalledTimes(1);
  });

  it("opens a requested vault directly", async () => {
    useAppStore.setState({ vaultPath: null });
    const { openVault } = await mount({ vaultPath: null, requestedVault: "/req" });
    expect(openVault).toHaveBeenCalledWith("/req");
    expect(h.loadRecentVaults).not.toHaveBeenCalled();
  });

  it("otherwise publishes recents and reopens the last vault", async () => {
    useAppStore.setState({ vaultPath: null });
    h.loadRecentVaults.mockResolvedValueOnce({ entries: [{ id: "r1", label: "Notes" }], last: "r1" });
    const { openVault } = await mount({ vaultPath: null });
    await vi.waitFor(() => expect(openVault).toHaveBeenCalledWith("/resolved/r1"));
    expect(useAppStore.getState().recentVaults).toEqual([{ id: "r1", label: "Notes" }]);
  });

  it("unreadable recents leave a notice and open nothing", async () => {
    useAppStore.setState({ vaultPath: null });
    h.loadRecentVaults.mockRejectedValueOnce(new Error("broken"));
    const { openVault } = await mount({ vaultPath: null });
    await vi.waitFor(() => expect(useAppStore.getState().status).toBe("Recent vaults could not be loaded. Select a vault folder to continue."));
    expect(openVault).not.toHaveBeenCalled();
  });

  it("does not reopen anything when a vault is already open", async () => {
    const { openVault } = await mount();
    expect(openVault).not.toHaveBeenCalled();
    expect(h.loadRecentVaults).not.toHaveBeenCalled();
  });

  it("focuses the native window, the webview and the app root after the first frame", async () => {
    // Vitest serves the real window module to this effect's Promise.all
    // import, so the native focus call is observed at the IPC boundary.
    const nativeInvoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined);
    const tauriWindow = window as unknown as { __TAURI_INTERNALS__?: unknown };
    tauriWindow.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      invoke: nativeInvoke,
      transformCallback: () => 0,
    };
    const windowFocusCalls = () =>
      h.win.setFocus.mock.calls.length + nativeInvoke.mock.calls.filter(([cmd]) => cmd === "plugin:window|set_focus").length;
    const webviewFocusCalls = () =>
      h.webview.setFocus.mock.calls.length + nativeInvoke.mock.calls.filter(([cmd]) => cmd === "plugin:webview|set_webview_focus").length;
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.push(cb); return frames.length; });
    try {
      await mount();
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      // Nothing is focused before the first renderer frame.
      expect(windowFocusCalls()).toBe(0);
      act(() => frames[0](0));
      await vi.waitFor(() => expect(webviewFocusCalls()).toBe(1));
      expect(windowFocusCalls()).toBe(1);
      expect(document.activeElement).toBe(appRoot);
      // One short retry covers a late native activation.
      await vi.waitFor(() => expect(webviewFocusCalls()).toBe(2));
      expect(windowFocusCalls()).toBe(2);
    } finally {
      delete tauriWindow.__TAURI_INTERNALS__;
    }
  });
});

describe("unavailable vault retry", () => {
  const unavailable = { root: "/nas/vault", reason: "vault root is unavailable" } as AppState["unavailableVault"];

  it("retries on focus and every 5 s while visible and idle; stops on unmount", async () => {
    vi.useFakeTimers();
    useAppStore.setState({ vaultPath: null, loading: false });
    const { openVault } = await mount({ vaultPath: null, unavailableVault: unavailable, requestedVault: "/x" });
    vi.mocked(openVault).mockClear();
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(openVault).toHaveBeenCalledWith("/nas/vault");
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(openVault).toHaveBeenCalledTimes(2);
    useAppStore.setState({ loading: true });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(openVault).toHaveBeenCalledTimes(2);
    useAppStore.setState({ loading: false });
    await act(async () => root.unmount());
    root = createRoot(host);
    act(() => { vi.advanceTimersByTime(20_000); window.dispatchEvent(new Event("focus")); });
    expect(openVault).toHaveBeenCalledTimes(2);
  });

  it("a folder never selected in Mesa is not retried", async () => {
    vi.useFakeTimers();
    useAppStore.setState({ vaultPath: null });
    const { openVault } = await mount({
      vaultPath: null,
      requestedVault: "/x",
      unavailableVault: { root: "/v", reason: "vault folder has not been selected in Mesa" } as AppState["unavailableVault"],
    });
    vi.mocked(openVault).mockClear();
    act(() => { window.dispatchEvent(new Event("focus")); vi.advanceTimersByTime(10_000); });
    expect(openVault).not.toHaveBeenCalled();
  });
});

describe("auto-sync", () => {
  it("syncs after the base delay, reschedules, and stops when sync turns off", async () => {
    vi.useFakeTimers();
    const syncAll = vi.fn(async () => {});
    useAppStore.setState({
      syncAll,
      syncBusy: false,
      syncReport: null,
      settings: {
        ...useAppStore.getState().settings,
        syncEnabled: true,
        syncToken: "ref",
        syncAutoMinutes: 1,
        peers: [{ id: "p" }] as unknown as AppState["settings"]["peers"],
      },
    });
    await mount();
    await act(async () => { vi.advanceTimersByTime(59_999); });
    expect(syncAll).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(syncAll).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(syncAll).toHaveBeenCalledTimes(2);
    // A busy store skips the sync but keeps the schedule.
    useAppStore.setState({ syncBusy: true });
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(syncAll).toHaveBeenCalledTimes(2);
    useAppStore.setState({ syncBusy: false });
    await act(async () => {
      useAppStore.setState({ settings: { ...useAppStore.getState().settings, syncEnabled: false } });
    });
    await act(async () => { vi.advanceTimersByTime(10 * 60_000); });
    expect(syncAll).toHaveBeenCalledTimes(2);
  });

  it("never schedules without peers", async () => {
    vi.useFakeTimers();
    const syncAll = vi.fn(async () => {});
    useAppStore.setState({
      syncAll,
      settings: { ...useAppStore.getState().settings, syncEnabled: true, syncToken: "ref", syncAutoMinutes: 1, peers: [] },
    });
    await mount();
    await act(async () => { vi.advanceTimersByTime(10 * 60_000); });
    expect(syncAll).not.toHaveBeenCalled();
  });
});

describe("dock bridge", () => {
  it("restores each docked surface in main", async () => {
    const moveViewToRight = vi.fn();
    const moveViewToCenter = vi.fn();
    const openDeepResearch = vi.fn();
    const openFile = vi.fn(async () => {});
    const selectFile = vi.fn(async () => {});
    const setKeyboardFocus = vi.fn();
    useAppStore.setState({
      moveViewToRight, moveViewToCenter, openDeepResearch, openFile, selectFile, setKeyboardFocus,
      settings: { ...useAppStore.getState().settings, rightStack: ["agent"] },
    });
    await mount();
    await waitListening(DOCK_WINDOW_EVENT);

    await fire(DOCK_WINDOW_EVENT, { kind: "agent" });
    expect(moveViewToRight).toHaveBeenLastCalledWith("agent");
    expect(setKeyboardFocus).toHaveBeenLastCalledWith({ region: "right", rightIndex: 0 });

    await fire(DOCK_WINDOW_EVENT, { kind: "research" });
    expect(openDeepResearch).toHaveBeenCalledWith(true);

    await fire(DOCK_WINDOW_EVENT, { kind: "doc", relPath: " notes/a.md " });
    expect(openFile).toHaveBeenCalledWith("notes/a.md");
    expect(moveViewToCenter).toHaveBeenLastCalledWith("doc");
    expect(setKeyboardFocus).toHaveBeenLastCalledWith({ region: "center", rightIndex: 0 });

    await fire(DOCK_WINDOW_EVENT, { kind: "panel", view: "preview", relPath: "notes/b.md" });
    expect(selectFile).toHaveBeenCalledWith("notes/b.md");
    expect(moveViewToRight).toHaveBeenLastCalledWith("preview");
    // "preview" is not in the stack, so focus falls back to index 0.
    expect(setKeyboardFocus).toHaveBeenLastCalledWith({ region: "right", rightIndex: 0 });

    const calls = moveViewToRight.mock.calls.length;
    await fire(DOCK_WINDOW_EVENT, { kind: "doc", relPath: "   " });
    await fire(DOCK_WINDOW_EVENT, { kind: "bogus" });
    expect(moveViewToRight).toHaveBeenCalledTimes(calls);
    expect(openFile).toHaveBeenCalledTimes(1);
  });

  it("the global agent shortcut toggles the Pi overlay", async () => {
    useAppStore.setState({ piOverlayOpen: false });
    await mount();
    await waitListening(GLOBAL_AGENT_EVENT);
    await act(async () => { await fire(GLOBAL_AGENT_EVENT, null); });
    expect(useAppStore.getState().piOverlayOpen).toBe(true);
    await act(async () => { await fire(GLOBAL_AGENT_EVENT, null); });
    expect(useAppStore.getState().piOverlayOpen).toBe(false);
  });
});
