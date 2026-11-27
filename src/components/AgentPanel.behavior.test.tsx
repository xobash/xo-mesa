// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ tauri: true }));
const pi = vi.hoisted(() => {
  const session = { sessionId: null as string | null, terminal: null as unknown, fit: null as unknown };
  return {
    session,
    terminal: null as null | Promise<unknown>,
    ensure: vi.fn(),
    adopt: vi.fn(),
    claim: vi.fn(),
    queue: vi.fn(),
    register: vi.fn(),
    release: vi.fn(),
    addFont: vi.fn(),
    removeFont: vi.fn(),
  };
});

vi.mock("../lib/vault", async (original) => ({
  ...(await original<typeof import("../lib/vault")>()),
  get IN_TAURI() {
    return flags.tauri;
  },
}));
vi.mock("./piSession", () => ({
  SHARED_PI_SESSION: pi.session,
  addSharedPiFontSizeListener: pi.addFont,
  adoptSharedPiSession: pi.adopt,
  claimSharedPiResizeOwnership: pi.claim,
  ensureSharedPiSession: pi.ensure,
  getSharedPiFontSize: () => 13,
  getSharedPiTerminal: () => pi.terminal ?? new Promise(() => {}),
  queueSharedPiResize: pi.queue,
  registerSharedPiHost: pi.register,
  releaseSharedPiHost: pi.release,
  removeSharedPiFontSizeListener: pi.removeFont,
}));
vi.mock("./PiFloatingWindow", () => ({
  PiFloatingWindow: ({ children }: { children: (bar: object) => React.ReactNode }) => (
    <div data-testid="pi-floating">{children({ onTitleBarPointerDown: () => {}, onTitleBarKeyDown: () => {}, titleBarHint: "hint" })}</div>
  ),
}));
vi.mock("./BrowserHarness", () => ({
  BrowserHarness: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="browser-harness">
      <button type="button" onClick={onClose}>harness close</button>
    </div>
  ),
}));
vi.mock("./DeepResearchPanel", () => ({ DeepResearchPanel: () => <div data-testid="dr-panel" /> }));
vi.mock("./DeepResearchPhaseChip", () => ({ DeepResearchPhaseChip: () => null }));

import { AgentOverlay, AgentPanel, AgentSurface } from "./AgentPanel";
import { useAppStore } from "../store";
import { notifySharedPiExit, registerSharedPiRestart, requestSharedPiRestart } from "../lib/piSessionBridge";
import type { DeepResearchRunState } from "../storeTypes";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeTerm {
  options: { fontSize?: number };
  element: HTMLElement | null;
  cols: number;
  rows: number;
  open: (host: HTMLElement) => void;
  focus: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  writeln: ReturnType<typeof vi.fn>;
}

function fakeTerm(): FakeTerm {
  const term: FakeTerm = {
    options: {},
    element: null,
    cols: 101,
    rows: 31,
    open(target) {
      term.element = document.createElement("div");
      term.element.className = "xterm";
      target.appendChild(term.element);
    },
    focus: vi.fn(),
    reset: vi.fn(),
    writeln: vi.fn(),
  };
  return term;
}

const initial = useAppStore.getState();
let host: HTMLDivElement;
let root: Root;
let term: FakeTerm;
const fit = { fit: vi.fn() };

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
};
const button = (label: string) => {
  const found = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`missing button ${label}`);
  return found;
};
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });

beforeEach(() => {
  flags.tauri = true;
  for (const fn of [pi.ensure, pi.adopt, pi.claim, pi.queue, pi.register, pi.release, pi.addFont, pi.removeFont, fit.fit]) fn.mockReset();
  pi.ensure.mockResolvedValue("s-1");
  pi.adopt.mockResolvedValue("s-adopted");
  pi.claim.mockResolvedValue(undefined);
  pi.session.sessionId = null;
  pi.session.fit = fit;
  term = fakeTerm();
  pi.session.terminal = term;
  pi.terminal = Promise.resolve(term);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  useAppStore.setState({ vaultPath: "/vault", vaultName: "Vault", activePath: "Notes/A.md", openTabs: ["Notes/A.md"], piBrowse: null, deepResearchSurface: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.style.userSelect = "";
  useAppStore.setState(initial, true);
});

describe("AgentSurface session setup", () => {
  it("does not start Pi outside the native shell and says why", async () => {
    flags.tauri = false;
    act(() => root.render(<AgentSurface />));
    await flush();
    expect(pi.ensure).not.toHaveBeenCalled();
    expect(term.writeln).toHaveBeenCalledWith("Browser preview mode: native Pi terminal is unavailable.");
  });

  it("asks for a vault before starting Pi", async () => {
    useAppStore.setState({ vaultPath: null });
    act(() => root.render(<AgentSurface />));
    await flush();
    expect(pi.ensure).not.toHaveBeenCalled();
    expect(term.writeln).toHaveBeenCalledWith("Open a vault to start Pi.");
  });

  it("starts the one shared session with vault-relative context and reports readiness", async () => {
    const ready = vi.fn();
    act(() => root.render(<AgentSurface onSessionReady={ready} />));
    await flush();
    expect(pi.register).toHaveBeenCalledWith(host.querySelector(".xterm-host"));
    expect(pi.ensure).toHaveBeenCalledTimes(1);
    const [vaultPath, ctx, contextText] = pi.ensure.mock.calls[0];
    expect(vaultPath).toBe("/vault");
    expect(ctx.activePath).toBe("Notes/A.md");
    expect(contextText).toContain("Notes/A.md");
    expect(pi.adopt).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledWith("s-1");
    // Unfocused window: the resize is queued, not claimed.
    expect(pi.queue).toHaveBeenCalledWith(term);
    expect(pi.claim).not.toHaveBeenCalled();
    expect(host.querySelector(".pi-terminal-title")?.textContent).toContain("101×31 · 13px");
    expect(host.querySelector(".agent-context")?.textContent).toContain("Notes/A.md");
  });

  it("claims PTY resize ownership when the window has focus", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => root.render(<AgentSurface />));
    await flush();
    expect(pi.claim).toHaveBeenCalledWith(term);
    expect(pi.queue).not.toHaveBeenCalled();
  });

  it("adopts the handed-off session once and leaves it alone when the context changes", async () => {
    const ready = vi.fn();
    act(() => root.render(<AgentSurface attachSessionId="s-live" vaultPathOverride="/detached" onSessionReady={ready} />));
    await flush();
    expect(pi.adopt).toHaveBeenCalledTimes(1);
    expect(pi.adopt.mock.calls[0][0]).toBe("s-live");
    expect(pi.adopt.mock.calls[0][1]).toBe("/detached");
    expect(ready).toHaveBeenCalledTimes(1);
    act(() => useAppStore.setState({ activePath: "Notes/B.md", openTabs: ["Notes/B.md"] }));
    await flush();
    expect(pi.adopt).toHaveBeenCalledTimes(1);
    expect(pi.ensure).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".agent-context")?.textContent).toContain("Notes/B.md");
  });

  it("does not re-run setup, take focus or claim the PTY when the user changes notes", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => root.render(<AgentSurface />));
    await flush();
    expect(pi.ensure).toHaveBeenCalledTimes(1);
    const focusCalls = term.focus.mock.calls.length;
    const claims = pi.claim.mock.calls.length;
    act(() => useAppStore.setState({ activePath: "Notes/B.md", openTabs: ["Notes/A.md", "Notes/B.md"] }));
    await flush();
    expect(pi.ensure).toHaveBeenCalledTimes(1);
    expect(term.focus.mock.calls.length).toBe(focusCalls);
    expect(pi.claim.mock.calls.length).toBe(claims);
  });

  it("launches with the newest context after a restart", async () => {
    act(() => root.render(<AgentSurface />));
    await flush();
    act(() => useAppStore.setState({ activePath: "Notes/B.md", openTabs: ["Notes/B.md"] }));
    await flush();
    act(() => notifySharedPiExit(0));
    await click(host.querySelector(".pi-exit-banner button")!);
    await flush();
    expect(pi.ensure).toHaveBeenCalledTimes(2);
    expect(pi.ensure.mock.calls[1][2]).toContain("Current document: Notes/B.md");
  });

  it("never adopts over a session this realm already runs", async () => {
    pi.session.sessionId = "s-existing";
    act(() => root.render(<AgentSurface attachSessionId="s-live" />));
    await flush();
    expect(pi.adopt).not.toHaveBeenCalled();
    expect(pi.ensure).toHaveBeenCalledTimes(1);
  });

  it("prints a launch failure into the terminal and retries only from the banner", async () => {
    pi.ensure.mockRejectedValue(new Error("pi not found"));
    act(() => root.render(<AgentSurface />));
    await flush();
    expect(term.writeln).toHaveBeenCalledWith("Error: pi not found");
    expect(term.writeln).toHaveBeenCalledWith("Mesa tried to launch `pi` in a native PTY.");
    act(() => useAppStore.setState({ activePath: "Notes/B.md", openTabs: ["Notes/B.md"] }));
    await flush();
    expect(pi.ensure).toHaveBeenCalledTimes(1);
    const banner = host.querySelector(".pi-exit-banner");
    expect(banner?.textContent).toContain("Pi could not start");
    pi.ensure.mockResolvedValue("s-2");
    await click(banner!.querySelector("button")!);
    await flush();
    expect(pi.ensure).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".pi-exit-banner")).toBeNull();
  });

  it("keeps a started session usable when the resize claim is refused", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    pi.claim.mockRejectedValue(new Error("not the owner"));
    const ready = vi.fn();
    act(() => root.render(<AgentSurface onSessionReady={ready} />));
    await flush();
    expect(ready).toHaveBeenCalledWith("s-1");
    expect(pi.queue).toHaveBeenCalled();
    expect(term.writeln).not.toHaveBeenCalled();
    expect(host.querySelector(".pi-exit-banner")).toBeNull();
  });

  it("uses the mirrored context in a detached realm", async () => {
    const contextOverride = {
      vaultName: "V", vaultPath: "/vault", activePath: "Mirror.md", activeFilePath: "/vault/Mirror.md",
      openPaths: ["Mirror.md"], openFilePaths: ["/vault/Mirror.md"], centerView: "editor", rightViews: ["graph"],
    } as unknown as Parameters<typeof AgentSurface>[0]["contextOverride"];
    act(() => root.render(<AgentSurface contextOverride={contextOverride} />));
    await flush();
    expect(host.querySelector(".agent-context")?.textContent).toContain("Mirror.md");
    expect(host.querySelector(".agent-context")?.textContent).toContain("editor / graph");
    expect(pi.ensure.mock.calls[0][1]).toBe(contextOverride);
  });
});

describe("AgentSurface shared terminal ownership", () => {
  it("moves the existing xterm element into this host instead of opening a second one", async () => {
    const elsewhere = document.createElement("div");
    term.open(elsewhere);
    const element = term.element;
    const open = vi.spyOn(term, "open");
    act(() => root.render(<AgentSurface />));
    await flush();
    expect(open).not.toHaveBeenCalled();
    expect(element?.parentElement).toBe(host.querySelector(".xterm-host"));
  });

  it("hands the terminal back on unmount and never opens it after an early unmount", async () => {
    let resolve!: (t: FakeTerm) => void;
    pi.terminal = new Promise((r) => { resolve = r; });
    act(() => root.render(<AgentSurface />));
    const termHost = host.querySelector(".xterm-host");
    act(() => root.render(<></>));
    expect(pi.release).toHaveBeenCalledWith(termHost);
    expect(pi.removeFont).toHaveBeenCalled();
    const open = vi.spyOn(term, "open");
    resolve(term);
    await flush();
    expect(open).not.toHaveBeenCalled();
    expect(pi.ensure).not.toHaveBeenCalled();
  });
});

describe("AgentSurface exit and restart", () => {
  it("shows the exit banner and restarts the shared session on request", async () => {
    act(() => root.render(<AgentSurface />));
    await flush();
    act(() => notifySharedPiExit(3));
    const banner = host.querySelector(".pi-exit-banner");
    expect(banner?.getAttribute("role")).toBe("status");
    expect(banner?.textContent).toContain("Pi exited (code 3)");
    await click(banner!.querySelector("button")!);
    await flush();
    expect(pi.ensure).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".pi-exit-banner")).toBeNull();
  });

  it("respawns after a store-requested restart stopped the live session", async () => {
    act(() => root.render(<AgentSurface />));
    await flush();
    registerSharedPiRestart(async () => true);
    await act(async () => { await requestSharedPiRestart(); });
    await flush();
    expect(pi.ensure).toHaveBeenCalledTimes(2);
  });
});

describe("AgentSurface browser wing", () => {
  it("toggles the harness and remembers a manual dismissal against automatic navigation", async () => {
    act(() => root.render(<AgentSurface browserSlideOut />));
    await flush();
    await click(button("Open browser harness"));
    expect(host.querySelector('[data-testid="browser-harness"]')).not.toBeNull();
    expect(button("Close browser harness").getAttribute("aria-pressed")).toBe("true");
    await click(host.querySelector('[data-testid="browser-harness"] button')!);
    expect(host.querySelector('[data-testid="browser-harness"]')).toBeNull();
    act(() => useAppStore.setState({ piBrowse: { url: "https://example.com/", seq: 1 } }));
    expect(host.querySelector('[data-testid="browser-harness"]')).toBeNull();
    // A new run clears the dismissal.
    act(() => useAppStore.setState({ deepResearch: { runId: "r2", startedAt: 0 } as DeepResearchRunState }));
    act(() => useAppStore.setState({ piBrowse: { url: "https://example.com/b", seq: 2 } }));
    expect(host.querySelector('[data-testid="browser-harness"]')).not.toBeNull();
  });

  it("opens on automatic navigation only in the host that owns the xterm element", async () => {
    // Another host owns the terminal element.
    const other = document.createElement("div");
    const ownerTerm = fakeTerm();
    ownerTerm.open(other);
    pi.session.terminal = ownerTerm;
    act(() => root.render(<AgentSurface />));
    await flush();
    pi.session.terminal = ownerTerm;
    act(() => useAppStore.setState({ piBrowse: { url: "https://example.com/", seq: 1 } }));
    expect(host.querySelector('[data-testid="browser-harness"]')).toBeNull();
  });

  it("resizes the slide-out wing by dragging its edge within bounds", async () => {
    act(() => root.render(<AgentSurface browserSlideOut />));
    await flush();
    await click(button("Open browser harness"));
    const wing = host.querySelector<HTMLElement>(".agent-browser-wing")!;
    expect(wing.className).toContain("slide");
    expect(wing.style.width).toBe("460px");
    const handle = wing.querySelector(".agent-browser-wing-resize.right")!;
    act(() => { handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100 })); });
    act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: 160 })); });
    expect(wing.style.width).toBe("520px");
    act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: 2000 })); });
    expect(wing.style.width).toBe("900px");
    act(() => { window.dispatchEvent(new MouseEvent("mouseup")); });
    act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 })); });
    expect(wing.style.width).toBe("900px");
  });

  it("widens the inline wing when its left edge is dragged left", async () => {
    act(() => root.render(<AgentSurface />));
    await flush();
    await click(button("Open browser harness"));
    const wing = host.querySelector<HTMLElement>(".agent-browser-wing")!;
    expect(wing.className).toContain("inline");
    const handle = wing.querySelector(".agent-browser-wing-resize.left")!;
    act(() => { handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500 })); });
    act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 })); });
    expect(wing.style.width).toBe("860px");
    act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: 900 })); });
    expect(wing.style.width).toBe("320px");
  });
});

describe("AgentSurface Deep Research wing", () => {
  function storeSpies() {
    const openDeepResearch = vi.fn();
    const openResearchWindow = vi.fn(async (_placement?: object) => true);
    useAppStore.setState({ openDeepResearch, openResearchWindow } as never);
    return { openDeepResearch, openResearchWindow };
  }

  it("opens one shared run in this host's wing and closes it again", async () => {
    const { openDeepResearch } = storeSpies();
    act(() => root.render(<AgentSurface />));
    await flush();
    await click(button("Open Deep Research"));
    expect(openDeepResearch).toHaveBeenCalledWith(false);
    const surface = useAppStore.getState().deepResearchSurface;
    expect(surface).toMatch(/^pi-surface-/);
    expect(host.querySelector('[data-testid="dr-panel"]')).not.toBeNull();
    expect(host.querySelector(".dr-wing")?.className).toContain("initial");
    const closes = host.querySelectorAll<HTMLButtonElement>('button[aria-label="Close Deep Research"]');
    expect(closes.length).toBe(2);
    await click(closes[1]);
    expect(useAppStore.getState().deepResearchSurface).toBeNull();
  });

  it("releases the research presentation when its host unmounts", async () => {
    storeSpies();
    act(() => root.render(<AgentSurface />));
    await flush();
    await click(button("Open Deep Research"));
    expect(useAppStore.getState().deepResearchSurface).not.toBeNull();
    act(() => root.render(<></>));
    expect(useAppStore.getState().deepResearchSurface).toBeNull();
  });

  it("does not release a presentation another host owns", async () => {
    act(() => root.render(<AgentSurface />));
    await flush();
    act(() => useAppStore.setState({ deepResearchSurface: "someone-else" }));
    act(() => root.render(<></>));
    expect(useAppStore.getState().deepResearchSurface).toBe("someone-else");
  });

  it("separates into the research window with Ctrl+Shift+Enter on the wing bar", async () => {
    const { openResearchWindow } = storeSpies();
    act(() => root.render(<AgentSurface />));
    await flush();
    await click(button("Open Deep Research"));
    const bar = host.querySelector<HTMLElement>(".dr-wing-bar")!;
    act(() => { bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(openResearchWindow).not.toHaveBeenCalled();
    act(() => { bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(openResearchWindow).toHaveBeenCalledTimes(1);
    // jsdom rects are zero: placement clamps to the minimum window origin.
    expect(openResearchWindow).toHaveBeenCalledWith({ x: 4, y: 56, width: 0, height: 0 });
  });

  it("tears off after a sustained drag and not after a short one or a cancel", async () => {
    const { openResearchWindow } = storeSpies();
    act(() => root.render(<AgentSurface />));
    await flush();
    await click(button("Open Deep Research"));
    const bar = host.querySelector<HTMLElement>(".dr-wing-bar")!;
    const wing = () => host.querySelector<HTMLElement>(".dr-wing")!;
    const down = (x: number) => act(() => {
      bar.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: 100 }));
    });
    const win = (type: string, x: number, y = 100) => act(() => {
      window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y }));
    });

    down(100);
    expect(document.body.style.userSelect).toBe("none");
    win("pointermove", 104);
    win("pointerup", 104);
    expect(openResearchWindow).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe("");

    down(100);
    win("pointermove", 140);
    expect(wing().className).toContain("tear-off-armed");
    win("pointercancel", 140);
    expect(wing().className).not.toContain("tear-off-armed");
    expect(document.body.style.userSelect).toBe("");
    win("pointerup", 140);
    expect(openResearchWindow).not.toHaveBeenCalled();

    down(100);
    win("pointermove", 400, 300);
    win("pointerup", 400, 300);
    expect(openResearchWindow).toHaveBeenCalledTimes(1);
    expect(openResearchWindow.mock.calls[0][0]).toMatchObject({ x: 300, y: 200 });
  });

  it("ignores a press on a wing-bar button for tear-off", async () => {
    const { openResearchWindow } = storeSpies();
    act(() => root.render(<AgentSurface />));
    await flush();
    await click(button("Open Deep Research"));
    const close = host.querySelector(".dr-wing-bar button")!;
    act(() => { close.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 })); });
    expect(document.body.style.userSelect).toBe("");
    act(() => { window.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 300 })); });
    act(() => { window.dispatchEvent(new MouseEvent("pointerup", { clientX: 300, clientY: 300 })); });
    expect(openResearchWindow).not.toHaveBeenCalled();
  });

  it("nests the browser under the evidence region inline and resizes the started wing", async () => {
    storeSpies();
    act(() => useAppStore.setState({ deepResearch: { runId: "r1", startedAt: 5 } as DeepResearchRunState }));
    act(() => root.render(<AgentSurface />));
    await flush();
    await click(button("Open Deep Research"));
    await click(button("Open browser harness"));
    expect(host.querySelector(".agent-browser-wing")).toBeNull();
    expect(host.querySelector('[aria-label="Research browser"] [data-testid="browser-harness"]')).not.toBeNull();
    const wing = host.querySelector<HTMLElement>(".dr-wing")!;
    expect(wing.className).toContain("inline");
    expect(wing.style.width).toBe("520px");
    const handle = wing.querySelector(".agent-browser-wing-resize.left")!;
    act(() => { handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500 })); });
    act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: 0 })); });
    expect(wing.style.width).toBe("960px");
    act(() => { window.dispatchEvent(new MouseEvent("mouseup")); });
    // Closing the nested harness dismisses it.
    await click(host.querySelector('[aria-label="Research browser"] button')!);
    expect(host.querySelector('[aria-label="Research browser"]')).toBeNull();
  });

  it("slides the started wing out beside an open browser wing", async () => {
    storeSpies();
    act(() => useAppStore.setState({ deepResearch: { runId: "r1", startedAt: 5 } as DeepResearchRunState }));
    act(() => root.render(<AgentSurface browserSlideOut />));
    await flush();
    await click(button("Open Deep Research"));
    await click(button("Open browser harness"));
    const wing = host.querySelector<HTMLElement>(".dr-wing")!;
    expect(wing.className).toContain("slide");
    expect(wing.style.left).toBe("calc(100% + 460px)");
    const handle = wing.querySelector(".agent-browser-wing-resize.right")!;
    act(() => { handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 0 })); });
    act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: -1000 })); });
    expect(wing.style.width).toBe("380px");
  });
});

describe("AgentSurface title bar", () => {
  it("is one focusable combined title bar whose buttons never start a drag", async () => {
    const pointer = vi.fn();
    const key = vi.fn();
    const onClose = vi.fn();
    const place = vi.fn();
    act(() => root.render(
      <AgentSurface windowTitle="Pi agent" titleBarHint="Drag to move" nativeDragRegion onTitleBarPointerDown={pointer} onTitleBarKeyDown={key} onClose={onClose} onPlaceInWorkspace={place} />,
    ));
    await flush();
    const chrome = host.querySelector<HTMLElement>(".pi-terminal-chrome")!;
    expect(chrome.className).toContain("window-titlebar");
    expect(chrome.tabIndex).toBe(0);
    expect(chrome.getAttribute("aria-label")).toBe("Pi agent window. Drag to move");
    expect(chrome.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(host.querySelector(".pi-terminal-title")?.textContent).toMatch(/^External process · /);
    act(() => { button("Close Pi agent").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
    expect(pointer).not.toHaveBeenCalled();
    act(() => { chrome.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
    expect(pointer).toHaveBeenCalledTimes(1);
    act(() => { button("Close Pi agent").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(key).not.toHaveBeenCalled();
    act(() => { chrome.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(key).toHaveBeenCalledTimes(1);
    await click(button("Close Pi agent"));
    await click(button("Place Pi in workspace"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(place).toHaveBeenCalledTimes(1);
  });

  it("focuses the terminal when its host is clicked", async () => {
    act(() => root.render(<AgentSurface />));
    await flush();
    term.focus.mockClear();
    await click(host.querySelector(".xterm-host")!);
    expect(term.focus).toHaveBeenCalledTimes(1);
  });
});

describe("floating Pi windows", () => {
  it("yields the fallback panel to the dedicated overlay so only one floats", async () => {
    act(() => useAppStore.setState({ agentOpen: true, piOverlayOpen: true }));
    act(() => root.render(<><AgentPanel /><AgentOverlay /></>));
    await flush();
    expect(host.querySelectorAll('[data-testid="pi-floating"]').length).toBe(1);
    expect(useAppStore.getState().agentOpen).toBe(false);
  });

  it("places Pi in the workspace and closes the floating panel", async () => {
    const moveViewToRight = vi.fn();
    act(() => useAppStore.setState({ agentOpen: true, piOverlayOpen: false, moveViewToRight } as never));
    act(() => root.render(<AgentPanel />));
    await flush();
    expect(host.querySelector('[data-testid="pi-floating"]')).not.toBeNull();
    await click(button("Place Pi in workspace"));
    expect(moveViewToRight).toHaveBeenCalledWith("agent");
    expect(useAppStore.getState().agentOpen).toBe(false);
    expect(host.querySelector('[data-testid="pi-floating"]')).toBeNull();
  });

  it("closes the overlay Pi from its title bar", async () => {
    act(() => useAppStore.setState({ piOverlayOpen: true }));
    act(() => root.render(<AgentOverlay />));
    await flush();
    await click(button("Close Pi agent"));
    expect(useAppStore.getState().piOverlayOpen).toBe(false);
    expect(host.querySelector('[data-testid="pi-floating"]')).toBeNull();
  });
});
