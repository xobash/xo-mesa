// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createStore, type StoreApi } from "zustand";

// Native window boundary: windows created, their async creation events, the
// app event bus and PTY handoff commands.
const native = vi.hoisted(() => {
  type Handler = (event: { payload?: unknown }) => void;
  class FakeWindow {
    static existing = new Map<string, FakeWindow>();
    static created: FakeWindow[] = [];
    static throwOnCreate: Error | null = null;
    static listenError: Error | null = null;
    static getByLabel = async (label: string) => FakeWindow.existing.get(label) ?? null;
    label: string;
    options: Record<string, unknown>;
    handlers = new Map<string, Handler>();
    focused = 0;
    closed = 0;
    focusError: Error | null = null;
    constructor(label: string, options: Record<string, unknown>) {
      if (FakeWindow.throwOnCreate) throw FakeWindow.throwOnCreate;
      this.label = label;
      this.options = options;
      FakeWindow.created.push(this);
    }
    once(event: string, handler: Handler) {
      if (FakeWindow.listenError) return Promise.reject(FakeWindow.listenError);
      this.handlers.set(event, handler);
      return Promise.resolve(() => undefined);
    }
    fire(event: string, payload?: unknown) {
      this.handlers.get(event)?.({ payload });
    }
    async setFocus() {
      this.focused += 1;
      if (this.focusError) throw this.focusError;
    }
    async close() {
      this.closed += 1;
    }
  }
  return {
    inTauri: true,
    FakeWindow,
    invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
    emitTo: vi.fn<(target: string, event: string, payload: unknown) => Promise<void>>(),
    listeners: new Map<string, Array<(event: { payload: unknown }) => void>>(),
    unlistened: 0,
  };
});

vi.mock("../lib/vault", async (original) => {
  const actual = await original<typeof import("../lib/vault")>();
  return {
    ...actual,
    get IN_TAURI() {
      return native.inTauri;
    },
  };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: native.invoke,
}));
vi.mock("@tauri-apps/api/event", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/event")>()),
  emitTo: native.emitTo,
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    const list = native.listeners.get(event) ?? [];
    list.push(handler);
    native.listeners.set(event, list);
    return () => {
      native.unlistened += 1;
      native.listeners.set(event, (native.listeners.get(event) ?? []).filter((h) => h !== handler));
    };
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: native.FakeWindow }));
vi.mock("../lib/graphWindowBootstrap", () => ({
  saveGraphWindowBootstrap: async () => true,
  discardGraphWindowBootstrap: async () => undefined,
}));

import { useAppStore, type AppState } from "../store";
import { createWorkspaceController } from "./workspace";
import { AGENT_CONTEXT_EVENT, AGENT_WINDOW_READY_EVENT, setPiSessionSnapshot } from "../lib/piSessionBridge";

type FakeWindow = InstanceType<typeof native.FakeWindow>;
let state: StoreApi<AppState>;
let actions: ReturnType<typeof createWorkspaceController>["actions"];
let commitSettings: Mock<(settings: AppState["settings"]) => void>;

function setup(patch: Partial<AppState> = {}) {
  const initial = useAppStore.getInitialState();
  state = createStore<AppState>(() => ({
    ...initial,
    vaultPath: "/vault",
    vaultName: "Vault",
    theme: "void",
    selectFile: vi.fn(async (rel: string) => {
      state.setState({ activePath: rel });
    }) as unknown as AppState["selectFile"],
    setSetting: vi.fn((key: string, value: unknown) => {
      state.setState({ settings: { ...state.getState().settings, [key]: value } });
    }) as unknown as AppState["setSetting"],
    openDeepResearch: vi.fn() as unknown as AppState["openDeepResearch"],
    setDeepResearchSurface: vi.fn((surface: string | null) => state.setState({ deepResearchSurface: surface })) as unknown as AppState["setDeepResearchSurface"],
    ...patch,
  }));
  commitSettings = vi.fn((settings: AppState["settings"]) => {
    state.setState({ settings });
  });
  actions = createWorkspaceController({ get: state.getState, set: state.setState, commitSettings }).actions;
}

function lastWindow(): FakeWindow {
  const all = native.FakeWindow.created;
  return all[all.length - 1];
}
function params(win: FakeWindow) {
  return new URLSearchParams(String(win.options.url).replace(/^index\.html\?/, ""));
}
function emitReady(payload: unknown) {
  for (const handler of native.listeners.get(AGENT_WINDOW_READY_EVENT) ?? []) handler({ payload });
}
async function waitForWindow(count = 1) {
  await vi.waitFor(() => expect(native.FakeWindow.created.length).toBe(count));
  return lastWindow();
}

beforeEach(() => {
  native.inTauri = true;
  native.FakeWindow.existing = new Map();
  native.FakeWindow.created = [];
  native.FakeWindow.throwOnCreate = null;
  native.FakeWindow.listenError = null;
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (cmd) => (cmd === "terminal_prepare_handoff" ? "handoff-token" : undefined));
  native.emitTo.mockReset();
  native.emitTo.mockResolvedValue(undefined);
  native.listeners = new Map();
  native.unlistened = 0;
  setPiSessionSnapshot({ sessionId: null, vaultPath: null, cols: 80, rows: 24 });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  setup();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("openDocWindow", () => {
  it("opens a native document window carrying the note, vault and theme", async () => {
    await actions.openDocWindow("Notes/My Plan.md");
    const win = lastWindow();
    expect(win.label).toMatch(/^doc-Notes_My_Plan_md-/);
    expect(params(win).get("doc")).toBe("Notes/My Plan.md");
    expect(params(win).get("vault")).toBe("/vault");
    expect(params(win).get("theme")).toBe("void");
    expect(win.options).toMatchObject({ title: "My Plan", width: 760, height: 860, theme: "dark" });
    expect(state.getState().popoutDoc).toBeNull();
  });

  it("restores the document inside Mesa when native creation fails later", async () => {
    await actions.openDocWindow("a.md");
    lastWindow().fire("tauri://error", "WebView2 missing");
    expect(state.getState()).toMatchObject({ popoutDoc: "a.md", status: "Document window could not open; restored inside Mesa." });
  });

  it("reports a creation listener that cannot register instead of rejecting unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    native.FakeWindow.listenError = new Error("event API unavailable");
    try {
      await actions.openDocWindow("a.md");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("could not register"), native.FakeWindow.listenError);
      expect(lastWindow().label).toMatch(/^doc-a_md-/);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("falls back to the in-app document popout when the window cannot be constructed", async () => {
    native.FakeWindow.throwOnCreate = new Error("no webview");
    await actions.openDocWindow("a.md");
    expect(state.getState().popoutDoc).toBe("a.md");
  });

  it("uses the in-app popout in browser preview", async () => {
    native.inTauri = false;
    await actions.openDocWindow("a.md");
    expect(native.FakeWindow.created).toHaveLength(0);
    expect(state.getState().popoutDoc).toBe("a.md");
  });
});

describe("openAgentWindow", () => {
  beforeEach(() => {
    setPiSessionSnapshot({ sessionId: "pty-1", vaultPath: "/vault", cols: 100, rows: 30 });
  });

  it("hands the live PTY to a new window and keeps the source until adoption", async () => {
    setup({ activePath: "Notes/a.md" });
    const result = actions.openAgentWindow({ x: 10, y: 20, width: 300, height: 200 });
    const win = await waitForWindow();
    expect(native.invoke).toHaveBeenCalledWith("terminal_prepare_handoff", { sessionId: "pty-1", targetLabel: win.label });
    const url = params(win);
    expect(url.get("agent")).toBe("1");
    expect(url.get("piSession")).toBe("pty-1");
    expect(url.get("piHandoff")).toBe("handoff-token");
    expect(url.get("agentLabel")).toBe(win.label);
    expect(url.get("sel")).toBe("Notes/a.md");
    expect(win.options).toMatchObject({ x: 10, y: 20, width: 520, height: 360, visible: true, title: "Pi agent — Vault" });
    // An acknowledgement for another window, or without a session, is not this handoff.
    emitReady({ label: "agent-other", sessionId: "pty-1" });
    emitReady({ label: win.label });
    await Promise.resolve();
    expect(win.focused).toBe(0);
    emitReady({ label: win.label, sessionId: "pty-1" });
    await expect(result).resolves.toBe(true);
    expect(win.focused).toBe(1);
    expect(native.emitTo).toHaveBeenCalledWith(win.label, AGENT_CONTEXT_EVENT, expect.objectContaining({ vaultPath: "/vault", activePath: "Notes/a.md" }));
    expect(native.unlistened).toBe(1);
    expect(state.getState().agentOpen).toBe(false);
    expect(win.closed).toBe(0);
  });

  it("keeps an adopted window when focus and the context mirror fail", async () => {
    native.emitTo.mockRejectedValue(new Error("capability"));
    const result = actions.openAgentWindow();
    const win = await waitForWindow();
    win.focusError = new Error("focus denied");
    emitReady({ label: win.label, sessionId: "pty-1" });
    await expect(result).resolves.toBe(true);
    expect(win.closed).toBe(0);
    expect(state.getState().status).toBe("");
  });

  it("closes a failed window, reclaims the PTY size and restores Pi inside Mesa", async () => {
    const result = actions.openAgentWindow();
    const win = await waitForWindow();
    win.fire("tauri://error", "creation failed");
    await expect(result).resolves.toBe(false);
    expect(win.closed).toBe(1);
    expect(native.invoke).toHaveBeenCalledWith("terminal_attach", { sessionId: "pty-1", cols: 100, rows: 30, reclaim: true });
    expect(state.getState()).toMatchObject({ agentOpen: true, status: "Pi window creation failed; restored inside Mesa." });
    expect(native.unlistened).toBe(1);
  });

  it("keeps both surfaces when the handoff is never confirmed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = actions.openAgentWindow();
    await vi.advanceTimersByTimeAsync(0);
    const win = lastWindow();
    expect(win).toBeDefined();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toBe(false);
    expect(win.closed).toBe(0);
    expect(state.getState().agentOpen).toBe(false);
    expect(state.getState().status).toBe("Pi handoff was not confirmed; both Pi surfaces were kept open.");
  });

  it("waits for Pi to start, then reports and falls back when it never does", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setPiSessionSnapshot({ sessionId: "pty-other", vaultPath: "/other-vault", cols: 80, rows: 24 });
    const result = actions.openAgentWindow();
    await vi.advanceTimersByTimeAsync(40 * 50);
    await expect(result).resolves.toBe(false);
    expect(native.FakeWindow.created).toHaveLength(0);
    expect(state.getState()).toMatchObject({ agentOpen: true, status: "Pi tear-out failed: Pi is still starting." });
    // The session that does exist (another vault) gets its resize ownership back.
    expect(native.invoke).toHaveBeenCalledWith("terminal_attach", expect.objectContaining({ sessionId: "pty-other", reclaim: true }));
  });

  it("uses a session that finishes starting while it waits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setPiSessionSnapshot({ sessionId: null, vaultPath: null, cols: 80, rows: 24 });
    const result = actions.openAgentWindow();
    await vi.advanceTimersByTimeAsync(120);
    setPiSessionSnapshot({ sessionId: "pty-late", vaultPath: "/vault", cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(60);
    const win = lastWindow();
    expect(params(win).get("piSession")).toBe("pty-late");
    emitReady({ label: win.label, sessionId: "pty-late" });
    await expect(result).resolves.toBe(true);
  });

  it("opens the in-app Pi window in browser preview", async () => {
    native.inTauri = false;
    await expect(actions.openAgentWindow()).resolves.toBe(false);
    expect(state.getState().agentOpen).toBe(true);
    expect(native.invoke).not.toHaveBeenCalled();
  });
});

describe("openResearchWindow", () => {
  it("opens one native Research window and binds the run to it", async () => {
    await expect(actions.openResearchWindow({ x: 1, y: 2, width: 100, height: 100 })).resolves.toBe(true);
    const win = lastWindow();
    expect(state.getState().openDeepResearch).toHaveBeenCalledWith(false);
    expect(params(win).get("research")).toBe("1");
    expect(params(win).get("researchLabel")).toBe(win.label);
    expect(win.options).toMatchObject({ x: 1, y: 2, width: 520, height: 420, title: "Deep Research — Vault" });
    expect(state.getState().deepResearchSurface).toBe(`native:${win.label}`);
    win.fire("tauri://destroyed");
    expect(state.getState().deepResearchSurface).toBeNull();
  });

  it("focuses the existing Research window instead of opening another", async () => {
    const existing = new native.FakeWindow("research-old", {});
    native.FakeWindow.existing.set("research-old", existing);
    native.FakeWindow.created = [];
    setup({ deepResearchSurface: "native:research-old" });
    await expect(actions.openResearchWindow()).resolves.toBe(true);
    expect(existing.focused).toBe(1);
    expect(native.FakeWindow.created).toHaveLength(0);
  });

  it("restores Research inside Mesa when native creation fails", async () => {
    await actions.openResearchWindow();
    lastWindow().fire("tauri://error", "boom");
    expect(state.getState().status).toBe("Deep Research window could not open; restored inside Mesa.");
    expect(state.getState().openDeepResearch).toHaveBeenLastCalledWith(true);
  });

  it("ignores creation events from a window the run no longer uses", async () => {
    await actions.openResearchWindow();
    const win = lastWindow();
    state.setState({ deepResearchSurface: "inline" });
    win.fire("tauri://error", "late");
    win.fire("tauri://destroyed");
    expect(state.getState().status).toBe("");
    expect(state.getState().deepResearchSurface).toBe("inline");
    expect(state.getState().openDeepResearch).not.toHaveBeenCalledWith(true);
  });

  it("reports a tear-out that cannot construct the window", async () => {
    native.FakeWindow.throwOnCreate = new Error("denied");
    await expect(actions.openResearchWindow()).resolves.toBe(false);
    expect(state.getState().status).toBe("Deep Research tear-out failed: Error: denied");
  });

  it("stays inside Mesa in browser preview", async () => {
    native.inTauri = false;
    await expect(actions.openResearchWindow()).resolves.toBe(false);
    expect(state.getState().openDeepResearch).toHaveBeenCalledWith(false);
    expect(native.FakeWindow.created).toHaveLength(0);
  });
});

describe("openPanelWindow", () => {
  it("opens a singleton panel window that follows the active note", async () => {
    setup({ activePath: "Notes/a.md" });
    await actions.openPanelWindow("preview", { x: 5, y: 6, width: 100, height: 100 });
    const win = lastWindow();
    expect(win.label).toBe("panel-preview");
    expect(params(win).get("panel")).toBe("preview");
    expect(params(win).get("sel")).toBe("Notes/a.md");
    expect(win.options).toMatchObject({ title: "Preview", x: 5, y: 6, width: 360, height: 280, theme: "dark" });
  });

  it("keeps the graph window on OS-following chrome", async () => {
    await actions.openPanelWindow("graph");
    const win = lastWindow();
    expect(win.label).toBe("panel-graph");
    expect(win.options.theme).toBeUndefined();
    expect(win.options.backgroundColor).toBeUndefined();
  });

  it("focuses an already open panel window instead of creating another", async () => {
    const existing = new native.FakeWindow("panel-tasks", {});
    native.FakeWindow.existing.set("panel-tasks", existing);
    native.FakeWindow.created = [];
    await actions.openPanelWindow("tasks");
    expect(existing.focused).toBe(1);
    expect(native.FakeWindow.created).toHaveLength(0);
  });

  it("docks the panel into the one side pane, replacing it, when native creation fails", async () => {
    setup({ settings: { ...useAppStore.getInitialState().settings, centerView: "doc", rightStack: ["agent"] } });
    await actions.openPanelWindow("tasks");
    lastWindow().fire("tauri://error", "boom");
    // At most two panes: a second side view would be cut off and never shown.
    expect(state.getState().settings).toMatchObject({ centerView: "doc", rightStack: ["tasks"] });
  });

  it("docks the panel into an empty centre when construction fails, and can retry", async () => {
    setup({ settings: { ...useAppStore.getInitialState().settings, centerView: "empty", rightStack: ["agent"] } });
    native.FakeWindow.throwOnCreate = new Error("denied");
    await actions.openPanelWindow("preview");
    expect(state.getState().settings).toMatchObject({ centerView: "preview", rightStack: [] });
    // The failed attempt released its label, so a later tear-out can open the window.
    native.FakeWindow.throwOnCreate = null;
    await actions.openPanelWindow("preview");
    expect(lastWindow().label).toBe("panel-preview");
  });

  it("does nothing in browser preview", async () => {
    native.inTauri = false;
    await actions.openPanelWindow("graph");
    expect(native.FakeWindow.created).toHaveLength(0);
    expect(state.getState().setSetting).not.toHaveBeenCalled();
  });
});

describe("document split actions", () => {
  function splitSetup(patch: Partial<AppState> = {}) {
    setup({
      activePath: "a.md",
      settings: { ...useAppStore.getInitialState().settings, centerView: "doc", rightStack: [] },
      docSplit: { active: "doc", other: null },
      ...patch,
    });
  }

  it("opens a file beside the current one and keeps the current file in the other pane", async () => {
    splitSetup();
    await actions.openToSide("b.md");
    expect(state.getState().settings).toMatchObject({ centerView: "doc", rightStack: ["doc2"] });
    expect(state.getState().docSplit).toEqual({ active: "doc2", other: "a.md" });
    expect(state.getState().selectFile).toHaveBeenCalledWith("b.md");
  });

  it("moves the live editor back to the other pane on focus", async () => {
    splitSetup({ activePath: "b.md", settings: { ...useAppStore.getInitialState().settings, centerView: "doc", rightStack: ["doc2"] }, docSplit: { active: "doc2", other: "a.md" } });
    await actions.focusDocPane("doc");
    expect(state.getState().docSplit).toEqual({ active: "doc", other: "b.md" });
    expect(state.getState().selectFile).toHaveBeenCalledWith("a.md");
    // Focusing the pane that is already live changes nothing.
    await actions.focusDocPane("doc");
    expect(state.getState().selectFile).toHaveBeenCalledTimes(1);
  });

  it("keeps the split when a dirty PDF editor would be unmounted and the user cancels", async () => {
    const confirmDiscardBinaryEdits = vi.fn(async () => false);
    splitSetup({ activePath: "scan.pdf", dirtyBinaryPaths: ["scan.pdf"], confirmDiscardBinaryEdits: confirmDiscardBinaryEdits as unknown as AppState["confirmDiscardBinaryEdits"] });
    await actions.openToSide("b.md");
    expect(confirmDiscardBinaryEdits).toHaveBeenCalledWith(["scan.pdf"], "Opening another file");
    expect(state.getState().docSplit).toEqual({ active: "doc", other: null });
    expect(commitSettings).not.toHaveBeenCalled();
    expect(state.getState().selectFile).not.toHaveBeenCalled();
  });

  it("opens a dropped file in the region it was dropped on", async () => {
    splitSetup();
    await actions.openFileInRegion("b.md", "right");
    expect(state.getState().settings.rightStack).toEqual(["doc2"]);
    expect(state.getState().docSplit).toEqual({ active: "doc2", other: "a.md" });
    expect(state.getState().selectFile).toHaveBeenCalledWith("b.md");
  });
});
