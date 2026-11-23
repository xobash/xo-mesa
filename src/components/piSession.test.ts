// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Native boundary for the one shared Pi session: every PTY command goes
// through `invoke`, output arrives on a Tauri `Channel`, and xterm is a fake
// that records writes and grid changes.
const native = vi.hoisted(() => {
  type Message = { event: string; payload: unknown };
  class FakeChannel {
    static all: FakeChannel[] = [];
    onmessage: (message: Message) => void = () => undefined;
    constructor() {
      FakeChannel.all.push(this);
    }
  }
  return {
    inTauri: true,
    invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
    FakeChannel,
    focusHandlers: [] as Array<(event: { payload: boolean }) => void>,
    terminals: [] as unknown[],
    fitSize: null as null | { cols: number; rows: number },
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, Channel: native.FakeChannel }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async (handler: (event: { payload: boolean }) => void) => {
      native.focusHandlers.push(handler);
      return () => undefined;
    },
  }),
}));
vi.mock("../lib/vault", () => ({
  get IN_TAURI() {
    return native.inTauri;
  },
}));
vi.mock("../lib/hotkeys", async (original) => ({
  ...(await original<typeof import("../lib/hotkeys")>()),
  IS_MAC: false,
}));
vi.mock("../lib/confirmAction", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("../store", () => {
  let state: Record<string, unknown> = {};
  const api = {
    getState: () => state,
    setState: (patch: Record<string, unknown> | ((s: Record<string, unknown>) => Record<string, unknown>)) => {
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
    },
    reset: (next: Record<string, unknown>) => {
      state = next;
    },
  };
  return { useAppStore: api };
});

class FakeTerminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown>;
  element: HTMLDivElement = document.createElement("div");
  written: string[] = [];
  lines: string[] = [];
  resets = 0;
  focused = 0;
  selection = "";
  keyHandler: (event: KeyboardEvent) => boolean = () => true;
  private dataHandlers: Array<(input: string) => void> = [];
  private resizeHandlers: Array<(size: { cols: number; rows: number }) => void> = [];
  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
    native.terminals.push(this);
  }
  loadAddon(addon: { activate(term: FakeTerminal): void }) {
    addon.activate(this);
  }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler;
  }
  onData(handler: (input: string) => void) {
    this.dataHandlers.push(handler);
  }
  onResize(handler: (size: { cols: number; rows: number }) => void) {
    this.resizeHandlers.push(handler);
  }
  type(input: string) {
    for (const handler of this.dataHandlers) handler(input);
  }
  resize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    for (const handler of this.resizeHandlers) handler({ cols, rows });
  }
  write(data: string, callback?: () => void) {
    this.written.push(data);
    callback?.();
  }
  writeln(data: string) {
    this.lines.push(data);
  }
  reset() {
    this.resets += 1;
    this.written = [];
  }
  focus() {
    this.focused += 1;
  }
  hasSelection() {
    return this.selection !== "";
  }
  getSelection() {
    return this.selection;
  }
  clearSelection() {
    this.selection = "";
  }
}

class FakeFitAddon {
  term: FakeTerminal | null = null;
  fits = 0;
  activate(term: FakeTerminal) {
    this.term = term;
  }
  fit() {
    this.fits += 1;
    if (native.fitSize && this.term) this.term.resize(native.fitSize.cols, native.fitSize.rows);
  }
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: FakeFitAddon }));

type PiSession = typeof import("./piSession");
type Bridge = typeof import("../lib/piSessionBridge");
type Store = { getState(): Record<string, unknown>; reset(next: Record<string, unknown>): void };

const ctx = {
  vaultName: "Vault",
  vaultPath: "/vault",
  activePath: "Notes/a.md",
  activeFilePath: "/vault/Notes/a.md",
  openPaths: ["Notes/a.md", "Notes/b.md"],
  openFilePaths: ["/vault/Notes/a.md", "/vault/Notes/b.md"],
  centerView: "editor",
  rightViews: ["graph", "agent"],
} as unknown as Parameters<PiSession["ensureSharedPiSession"]>[1];

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

let pi: PiSession;
let bridge: Bridge;
let store: Store;
let nextSession = 0;
let snapshotFor: (sessionId: string) => Promise<unknown>;

function calls(cmd: string) {
  return native.invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args ?? {});
}
function commandOrder() {
  return native.invoke.mock.calls.map(([name]) => name);
}
function channel(index = -1) {
  const all = native.FakeChannel.all;
  return all[index < 0 ? all.length + index : index];
}
function output(sessionId: string, seq: number, data: string, index = -1) {
  channel(index).onmessage({ event: "terminal://output", payload: { sessionId, stream: "stdout", data, seq } });
}
function exit(sessionId: string, code: number | null, index = -1) {
  channel(index).onmessage({ event: "terminal://exit", payload: { sessionId, code } });
}
function key(init: KeyboardEventInit & { type?: string }) {
  return new KeyboardEvent(init.type ?? "keydown", { cancelable: true, ...init });
}

beforeEach(async () => {
  vi.resetModules();
  native.invoke.mockReset();
  native.FakeChannel.all = [];
  native.focusHandlers = [];
  native.terminals = [];
  native.fitSize = null;
  native.inTauri = true;
  nextSession = 0;
  snapshotFor = async () => ({ data: "", seq: 0 });
  native.invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "terminal_start") return `pty-${++nextSession}`;
    if (cmd === "terminal_subscribe") return `sub-${native.FakeChannel.all.length}`;
    if (cmd === "terminal_snapshot") return snapshotFor(String(args?.sessionId));
    return undefined;
  });
  window.history.replaceState(null, "", "/");
  pi = await import("./piSession");
  bridge = await import("../lib/piSessionBridge");
  store = (await import("../store")).useAppStore as unknown as Store;
  store.reset({
    deepResearch: null,
    piOverlayOpen: false,
    toggleOverlay: vi.fn(),
    setPiOverlayOpen: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function terminal(): Promise<FakeTerminal> {
  return (await pi.getSharedPiTerminal()) as unknown as FakeTerminal;
}

async function start(vaultPath = "/vault", contextText = "ctx") {
  const term = await terminal();
  const id = await pi.ensureSharedPiSession(vaultPath, ctx, contextText, term as never);
  await settle();
  return { term, id };
}

describe("shared Pi terminal", () => {
  it("creates one xterm for concurrent surfaces and installs one focus listener", async () => {
    const [a, b] = await Promise.all([pi.getSharedPiTerminal(), pi.getSharedPiTerminal()]);
    expect(a).toBe(b);
    expect(await pi.getSharedPiTerminal()).toBe(a);
    expect(native.terminals).toHaveLength(1);
    expect((a as unknown as FakeTerminal).options).toMatchObject({ fontSize: 16, scrollback: 10000 });
    expect((a as unknown as FakeTerminal).options.linkHandler).toBe(pi.PI_TERMINAL_LINK_HANDLER);
    await settle();
    expect(native.focusHandlers).toHaveLength(1);
  });

  it("installs no focus listener in browser preview mode", async () => {
    native.inTauri = false;
    await terminal();
    await settle();
    expect(native.focusHandlers).toHaveLength(0);
  });

  it("refuses to start or adopt a PTY in browser preview mode", async () => {
    native.inTauri = false;
    const term = await terminal();
    await expect(pi.ensureSharedPiSession("/vault", ctx, "c", term as never)).rejects.toThrow(/Browser preview/);
    await expect(pi.adoptSharedPiSession("pty-9", "/vault", "c", term as never)).rejects.toThrow(/Browser preview/);
    expect(native.invoke).not.toHaveBeenCalled();
  });
});

describe("ensureSharedPiSession", () => {
  it("starts one PTY for concurrent callers with the same vault and context", async () => {
    const term = await terminal();
    const [a, b] = await Promise.all([
      pi.ensureSharedPiSession("/vault", ctx, "ctx", term as never),
      pi.ensureSharedPiSession("/vault", ctx, "ctx", term as never),
    ]);
    expect(a).toBe("pty-1");
    expect(b).toBe("pty-1");
    expect(calls("terminal_start")).toHaveLength(1);
    expect(calls("terminal_start")[0]).toMatchObject({
      cwd: "/vault",
      program: "pi",
      cols: 80,
      rows: 24,
      envs: {
        MESA_VAULT_NAME: "Vault",
        MESA_VAULT_PATH: "/vault",
        MESA_ACTIVE_PATH: "Notes/a.md",
        MESA_OPEN_PATHS: "Notes/a.md\nNotes/b.md",
        MESA_RIGHT_VIEWS: "graph,agent",
        MESA_CONTEXT: "ctx",
      },
    });
    expect((calls("terminal_start")[0].envs as Record<string, string>).MESA_DEEP_RESEARCH).toBeUndefined();
    expect(bridge.getPiSessionSnapshot()).toMatchObject({ sessionId: "pty-1", vaultPath: "/vault", contextText: "ctx" });
  });

  it("marks the session for an active Deep Research run", async () => {
    store.reset({ ...store.getState(), deepResearch: { phase: "researching", runId: "run-7" } });
    await start();
    expect(calls("terminal_start")[0].envs).toMatchObject({ MESA_DEEP_RESEARCH: "1", MESA_DEEP_RESEARCH_RUN_ID: "run-7" });
  });

  it("does not mark a finished Deep Research run", async () => {
    store.reset({ ...store.getState(), deepResearch: { phase: "done", runId: "run-7" } });
    await start();
    expect((calls("terminal_start")[0].envs as Record<string, string>).MESA_DEEP_RESEARCH).toBeUndefined();
  });

  it("keeps the live session when only the context changes", async () => {
    await start("/vault", "first");
    const id = await pi.ensureSharedPiSession("/vault", ctx, "second", (await terminal()) as never);
    expect(id).toBe("pty-1");
    expect(calls("terminal_start")).toHaveLength(1);
    expect(calls("terminal_stop")).toHaveLength(0);
  });

  it("waits for a different in-flight start, then reuses it for the same vault", async () => {
    const gate = deferred<string>();
    native.invoke.mockImplementation(async (cmd) => {
      if (cmd === "terminal_start") return gate.promise;
      if (cmd === "terminal_subscribe") return "sub";
      if (cmd === "terminal_snapshot") return { data: "", seq: 0 };
      return undefined;
    });
    const term = await terminal();
    const first = pi.ensureSharedPiSession("/vault", ctx, "a", term as never);
    const second = pi.ensureSharedPiSession("/vault", ctx, "b", term as never);
    gate.resolve("pty-x");
    await expect(first).resolves.toBe("pty-x");
    await expect(second).resolves.toBe("pty-x");
    expect(calls("terminal_start")).toHaveLength(1);
  });

  it("re-evaluates after a superseded start fails", async () => {
    let attempt = 0;
    native.invoke.mockImplementation(async (cmd) => {
      if (cmd === "terminal_start") {
        attempt += 1;
        if (attempt === 1) throw new Error("spawn failed");
        return "pty-retry";
      }
      if (cmd === "terminal_subscribe") return "sub";
      if (cmd === "terminal_snapshot") return { data: "", seq: 0 };
      return undefined;
    });
    const term = await terminal();
    const first = pi.ensureSharedPiSession("/vault", ctx, "a", term as never);
    const second = pi.ensureSharedPiSession("/vault", ctx, "b", term as never);
    await expect(first).rejects.toThrow("spawn failed");
    await expect(second).resolves.toBe("pty-retry");
    expect(calls("terminal_start")).toHaveLength(2);
  });

  it("stops the old PTY and its subscription before starting for another vault", async () => {
    await start("/vault-a");
    const id = await pi.ensureSharedPiSession("/vault-b", ctx, "ctx", (await terminal()) as never);
    expect(id).toBe("pty-2");
    expect(calls("terminal_unsubscribe")[0]).toEqual({ sessionId: "pty-1", subscriptionId: "sub-1" });
    expect(calls("terminal_stop")).toEqual([{ sessionId: "pty-1" }]);
    const order = commandOrder();
    expect(order.lastIndexOf("terminal_stop")).toBeLessThan(order.lastIndexOf("terminal_start"));
    expect(calls("terminal_start")[1]).toMatchObject({ cwd: "/vault-b" });
  });

  it("still starts the new vault when stopping the old PTY fails", async () => {
    await start("/vault-a");
    native.invoke.mockImplementation(async (cmd) => {
      if (cmd === "terminal_stop") throw new Error("gone");
      if (cmd === "terminal_start") return "pty-b";
      if (cmd === "terminal_subscribe") return "sub-b";
      if (cmd === "terminal_snapshot") return { data: "", seq: 0 };
      return undefined;
    });
    await expect(pi.ensureSharedPiSession("/vault-b", ctx, "ctx", (await terminal()) as never)).resolves.toBe("pty-b");
  });
});

describe("output subscription and replay", () => {
  it("subscribes before the snapshot and replays it without pushing replay sizes to the PTY", async () => {
    native.fitSize = { cols: 100, rows: 30 };
    snapshotFor = async () => ({
      data: "ignored",
      seq: 3,
      events: [
        { kind: "resize", cols: 60, rows: 20 },
        { kind: "output", data: "hello " },
        { kind: "resize", cols: 1, rows: 1 },
        { kind: "output", data: "world" },
      ],
    });
    const { term } = await start();
    await settle();
    const order = commandOrder();
    expect(order.indexOf("terminal_subscribe")).toBeLessThan(order.indexOf("terminal_snapshot"));
    expect(term.written).toEqual(["hello ", "world"]);
    // The synthetic 60x20 replay grid never reaches the PTY; the reconciled fit size does.
    const resizes = calls("terminal_resize");
    expect(resizes).not.toContainEqual({ sessionId: "pty-1", cols: 60, rows: 20 });
    expect(resizes[resizes.length - 1]).toEqual({ sessionId: "pty-1", cols: 100, rows: 30 });
  });

  it("buffers live output during replay and drops bytes the snapshot already holds", async () => {
    const snap = deferred<unknown>();
    snapshotFor = () => snap.promise;
    const term = await terminal();
    const started = pi.ensureSharedPiSession("/vault", ctx, "ctx", term as never);
    await settle();
    expect(calls("terminal_snapshot")).toHaveLength(1);
    output("pty-1", 2, "old");
    output("pty-1", 5, "new");
    expect(term.written).toEqual([]);
    snap.resolve({ data: "snapshot", seq: 3 });
    await started;
    await settle();
    expect(term.written).toEqual(["snapshot", "new"]);
    output("pty-1", 5, "duplicate");
    output("pty-1", 6, "live");
    expect(term.written).toEqual(["snapshot", "new", "live"]);
  });

  it("ignores output for another session", async () => {
    const { term } = await start();
    output("pty-other", 10, "foreign");
    expect(term.written).toEqual([]);
  });

  it("drains buffered output when the snapshot is unavailable", async () => {
    const snap = deferred<unknown>();
    snapshotFor = () => snap.promise;
    const term = await terminal();
    const started = pi.ensureSharedPiSession("/vault", ctx, "ctx", term as never);
    await settle();
    output("pty-1", 1, "buffered");
    snap.reject(new Error("session gone"));
    await started;
    await settle();
    expect(term.written).toEqual(["buffered"]);
  });

  it("holds an exit behind replay, then retires the session and tells surfaces", async () => {
    const snap = deferred<unknown>();
    snapshotFor = () => snap.promise;
    const exits: Array<number | null> = [];
    bridge.onSharedPiExit((code) => exits.push(code));
    const term = await terminal();
    const started = pi.ensureSharedPiSession("/vault", ctx, "ctx", term as never);
    await settle();
    output("pty-1", 1, "last words");
    exit("pty-1", 2);
    expect(exits).toEqual([]);
    snap.resolve({ data: "", seq: 0 });
    await started;
    await settle();
    expect(term.written).toEqual(["last words"]);
    expect(term.lines).toEqual([expect.stringContaining("Pi exited (code 2)")]);
    expect(exits).toEqual([2]);
    expect(bridge.getPiSessionSnapshot().sessionId).toBeNull();
    expect(calls("terminal_unsubscribe")).toEqual([{ sessionId: "pty-1", subscriptionId: "sub-1" }]);
    // The next surface spawns a fresh session instead of reusing the dead one.
    await expect(pi.ensureSharedPiSession("/vault", ctx, "ctx", term as never)).resolves.toBe("pty-2");
  });

  it("ignores an exit for a stale session", async () => {
    const exits: Array<number | null> = [];
    bridge.onSharedPiExit((code) => exits.push(code));
    const { term } = await start();
    exit("pty-old", null);
    expect(exits).toEqual([]);
    expect(term.lines).toEqual([]);
    expect(bridge.getPiSessionSnapshot().sessionId).toBe("pty-1");
  });

  it("ignores messages on a channel replaced by a newer subscription", async () => {
    const { term } = await start("/vault-a");
    await pi.ensureSharedPiSession("/vault-b", ctx, "ctx", term as never);
    await settle();
    output("pty-1", 99, "stale channel", 0);
    output("pty-2", 1, "fresh", 1);
    expect(term.written).toEqual(["fresh"]);
  });

  it("unsubscribes a subscription that resolves after the listener was superseded", async () => {
    const sub = deferred<string>();
    native.invoke.mockImplementation(async (cmd) => {
      if (cmd === "terminal_subscribe") return sub.promise;
      return undefined;
    });
    const term = await terminal();
    const adopted = pi.adoptSharedPiSession("pty-a", "/vault", "ctx", term as never);
    await settle();
    // A restart disposes the listener while subscribe is still in flight.
    const restart = bridge.requestSharedPiRestart();
    await settle();
    sub.resolve("sub-late");
    await adopted;
    await restart;
    expect(calls("terminal_unsubscribe")).toContainEqual({ sessionId: "pty-a", subscriptionId: "sub-late" });
    expect(calls("terminal_snapshot")).toHaveLength(0);
  });
});

describe("adoption and resize ownership", () => {
  it("adopts an existing PTY with the launch handoff token and its own grid", async () => {
    window.history.replaceState(null, "", "/?piHandoff=token-123");
    const term = await terminal();
    term.cols = 120;
    term.rows = 40;
    snapshotFor = async () => ({ data: "history", seq: 7 });
    await expect(pi.adoptSharedPiSession("pty-main", "/vault", "ctx", term as never)).resolves.toBe("pty-main");
    await settle();
    expect(calls("terminal_attach")[0]).toEqual({ sessionId: "pty-main", handoffToken: "token-123", cols: 120, rows: 40 });
    expect(calls("terminal_start")).toHaveLength(0);
    expect(term.written).toEqual(["history"]);
    expect(bridge.getPiSessionSnapshot()).toMatchObject({ sessionId: "pty-main", cols: 120, rows: 40 });
    output("pty-main", 7, "old");
    output("pty-main", 8, "next");
    expect(term.written).toEqual(["history", "next"]);
    // An adopted session is live: the same vault reuses it rather than spawning.
    await expect(pi.ensureSharedPiSession("/vault", ctx, "ctx", term as never)).resolves.toBe("pty-main");
  });

  it("claims resize ownership only with a live session", async () => {
    const term = await terminal();
    await pi.claimSharedPiResizeOwnership(term as never);
    pi.queueSharedPiResize(term as never);
    await settle();
    expect(native.invoke).not.toHaveBeenCalled();
    await start();
    native.invoke.mockClear();
    term.cols = 90;
    term.rows = 33;
    await pi.claimSharedPiResizeOwnership(term as never);
    expect(calls("terminal_attach")).toEqual([{ sessionId: "pty-1", cols: 90, rows: 33 }]);
  });

  it("re-claims ownership when its window gains focus, not when it loses it", async () => {
    const { term } = await start();
    native.invoke.mockClear();
    native.focusHandlers[0]({ payload: false });
    await settle();
    expect(calls("terminal_attach")).toHaveLength(0);
    native.focusHandlers[0]({ payload: true });
    await settle();
    expect(calls("terminal_attach")).toEqual([{ sessionId: "pty-1", cols: term.cols, rows: term.rows }]);
  });

  it("collapses a resize burst to the newest grid", async () => {
    const { term } = await start();
    native.invoke.mockClear();
    term.resize(81, 25);
    term.resize(82, 26);
    term.resize(83, 27);
    await settle();
    const resizes = calls("terminal_resize");
    expect(resizes[resizes.length - 1]).toEqual({ sessionId: "pty-1", cols: 83, rows: 27 });
    expect(resizes).not.toContainEqual({ sessionId: "pty-1", cols: 82, rows: 26 });
    expect(bridge.getPiSessionSnapshot()).toMatchObject({ cols: 83, rows: 27 });
  });

  it("sends no resize while no session is live", async () => {
    const term = await terminal();
    term.resize(70, 20);
    await settle();
    expect(calls("terminal_resize")).toHaveLength(0);
  });
});

describe("host stack", () => {
  it("hands the xterm element to the latest surviving host on unmount", async () => {
    const term = await terminal();
    const a = document.createElement("div");
    const b = document.createElement("div");
    const c = document.createElement("div");
    pi.registerSharedPiHost(a);
    pi.registerSharedPiHost(b);
    pi.registerSharedPiHost(c);
    c.appendChild(term.element);
    pi.releaseSharedPiHost(b);
    expect(c.contains(term.element)).toBe(true);
    pi.releaseSharedPiHost(c);
    expect(a.contains(term.element)).toBe(true);
    expect(term.focused).toBe(1);
  });

  it("leaves the element alone when the last host unmounts", async () => {
    const term = await terminal();
    const a = document.createElement("div");
    pi.registerSharedPiHost(a);
    a.appendChild(term.element);
    pi.releaseSharedPiHost(a);
    expect(a.contains(term.element)).toBe(true);
    expect(term.focused).toBe(0);
  });
});

describe("restart and stop", () => {
  it("restarts only a live session and notifies mounted surfaces", async () => {
    const restarts = vi.fn();
    bridge.onSharedPiRestart(restarts);
    await expect(bridge.requestSharedPiRestart()).resolves.toBe(false);
    expect(restarts).not.toHaveBeenCalled();
    await start();
    await expect(bridge.requestSharedPiRestart()).resolves.toBe(true);
    expect(calls("terminal_stop")).toEqual([{ sessionId: "pty-1" }]);
    expect(restarts).toHaveBeenCalledTimes(1);
    expect(bridge.getPiSessionSnapshot().sessionId).toBeNull();
  });

  it("survives a listener cleanup failure while stopping", async () => {
    await start();
    native.invoke.mockImplementation(async (cmd) => {
      if (cmd === "terminal_unsubscribe") throw new Error("channel closed");
      return undefined;
    });
    await expect(bridge.requestSharedPiRestart()).resolves.toBe(true);
    expect(calls("terminal_stop")).toEqual([{ sessionId: "pty-1" }]);
  });
});

describe("terminal keys and input", () => {
  it("writes typed input only to a live session", async () => {
    const term = await terminal();
    term.type("lost");
    expect(calls("terminal_write")).toHaveLength(0);
    await start();
    term.type("ls\r");
    expect(calls("terminal_write")).toEqual([{ sessionId: "pty-1", input: "ls\r" }]);
  });

  it("drops keystrokes a just-exited session refuses instead of leaving them unhandled", async () => {
    const term = await terminal();
    await start();
    // A refused write whose promise records whether the caller handles its rejection.
    const writes: { handled: boolean }[] = [];
    native.invoke.mockImplementation((cmd) => {
      if (cmd !== "terminal_write") return Promise.resolve(undefined);
      const write = { handled: false };
      writes.push(write);
      const then = (ok?: unknown, fail?: unknown) => { write.handled ||= typeof fail === "function"; return Promise.reject(new Error("session ended")).then(ok as never, fail as never); };
      const refused = { then, catch: (fail: unknown) => then(undefined, fail) };
      return refused as unknown as Promise<unknown>;
    });
    term.type("x");
    term.keyHandler(key({ key: "Tab", shiftKey: true, ctrlKey: true }));
    await Promise.resolve();
    expect(writes).toEqual([{ handled: true }, { handled: true }]);
  });

  it("changes the shared font size within 8..36 and tells listeners", async () => {
    const term = await terminal();
    const sizes: number[] = [];
    const listener = (size: number) => sizes.push(size);
    pi.addSharedPiFontSizeListener(listener);
    const bigger = key({ key: "=", ctrlKey: true });
    expect(term.keyHandler(bigger)).toBe(false);
    expect(bigger.defaultPrevented).toBe(true);
    expect(pi.getSharedPiFontSize()).toBe(17);
    expect(term.options.fontSize).toBe(17);
    for (let i = 0; i < 30; i += 1) term.keyHandler(key({ key: "+", ctrlKey: true }));
    expect(pi.getSharedPiFontSize()).toBe(36);
    term.keyHandler(key({ key: "0", ctrlKey: true }));
    expect(pi.getSharedPiFontSize()).toBe(16);
    for (let i = 0; i < 20; i += 1) term.keyHandler(key({ key: "-", ctrlKey: true }));
    expect(pi.getSharedPiFontSize()).toBe(8);
    pi.removeSharedPiFontSizeListener(listener);
    term.keyHandler(key({ key: "0", ctrlKey: true }));
    expect(sizes[sizes.length - 1]).toBe(8);
    expect(pi.getSharedPiFontSize()).toBe(16);
  });

  it("does not treat Ctrl+Alt font chords as font changes", async () => {
    const term = await terminal();
    expect(term.keyHandler(key({ key: "=", ctrlKey: true, altKey: true }))).toBe(true);
    expect(pi.getSharedPiFontSize()).toBe(16);
  });

  it("sends Pi its back-tab sequence for Ctrl+Shift+Tab, once per press", async () => {
    const term = await terminal();
    await start();
    expect(term.keyHandler(key({ key: "Tab", shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(term.keyHandler(key({ key: "Tab", shiftKey: true, altKey: true, repeat: true }))).toBe(false);
    expect(calls("terminal_write")).toEqual([{ sessionId: "pty-1", input: "\u001b[Z" }]);
    // Command+Shift+Tab stays with the OS.
    expect(term.keyHandler(key({ key: "Tab", shiftKey: true, metaKey: true }))).toBe(true);
  });

  it("toggles the overlay on plain Shift+Tab and keeps it from Pi", async () => {
    const term = await terminal();
    const toggleOverlay = store.getState().toggleOverlay as ReturnType<typeof vi.fn>;
    expect(term.keyHandler(key({ key: "Tab", code: "Tab", shiftKey: true }))).toBe(false);
    expect(toggleOverlay).toHaveBeenCalledTimes(1);
    expect(term.keyHandler(key({ key: "a" }))).toBe(true);
  });

  it("copies a selection on Ctrl+C off macOS and clears it only after the write", async () => {
    const term = await terminal();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    term.selection = "selected text";
    expect(term.keyHandler(key({ key: "c", code: "KeyC", ctrlKey: true }))).toBe(false);
    await settle();
    expect(writeText).toHaveBeenCalledWith("selected text");
    expect(term.selection).toBe("");
    // Without a selection Ctrl+C is SIGINT for Pi.
    expect(term.keyHandler(key({ key: "c", code: "KeyC", ctrlKey: true }))).toBe(true);
  });

  it("reports a failed copy through status and keeps the selection", async () => {
    const term = await terminal();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
    });
    term.selection = "keep me";
    term.keyHandler(key({ key: "c", code: "KeyC", ctrlKey: true }));
    await settle();
    expect(String(store.getState().status)).toContain("denied");
    expect(term.selection).toBe("keep me");
  });

  it("lets the webview paste on Ctrl+V", async () => {
    const term = await terminal();
    const paste = key({ key: "v", code: "KeyV", ctrlKey: true });
    expect(term.keyHandler(paste)).toBe(false);
    expect(paste.defaultPrevented).toBe(false);
  });

  it("toggles the Pi overlay on Ctrl+Shift+Space only in browser preview", async () => {
    native.inTauri = false;
    const term = await terminal();
    const setPiOverlayOpen = store.getState().setPiOverlayOpen as ReturnType<typeof vi.fn>;
    expect(term.keyHandler(key({ code: "Space", key: " ", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(setPiOverlayOpen).toHaveBeenCalledWith(true);
  });
});
