// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The main-window shell in isolation: layout classes and width variables come
 * from layout settings, pane splitters drag through `paneResizeDrag`, the
 * sidebar header actions reach the store, and a blocked close offers keep,
 * recovery copies or a confirmed discard. Child surfaces are stubbed; each has
 * its own suite.
 */

const h = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => true),
  confirm: vi.fn(async (_message: string, _options?: unknown) => true),
  effects: { current: null as null | Record<string, unknown> },
  welcome: { current: null as null | { onOpen: () => void; onRetry: () => void } },
  stub: () => null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./lib/confirmAction", () => ({ confirmAction: h.confirm }));
vi.mock("./components/useMainWindowEffects", () => ({
  useMainWindowEffects: (props: Record<string, unknown>) => { h.effects.current = props; },
}));
vi.mock("./components/useApplyTheme", () => ({ useApplyTheme: () => {} }));
vi.mock("./components/useTrayStatus", () => ({ useTrayStatus: () => {} }));
vi.mock("./components/useCustomHotkeys", () => ({ useCustomHotkeys: () => {} }));
vi.mock("./components/useBrowserKeyGuard", () => ({ useBrowserKeyGuard: () => {} }));
vi.mock("./controllers/settingsFollow", () => ({ followOtherWindows: () => () => {} }));
vi.mock("./components/Welcome", () => ({
  Welcome: (props: { onOpen: () => void; onRetry: () => void }) => {
    h.welcome.current = props;
    return <div data-welcome />;
  },
}));
vi.mock("./components/TopBar", () => ({ TopBar: h.stub }));
vi.mock("./components/FileTree", () => ({ FileTree: h.stub }));
vi.mock("./components/TagList", () => ({ TagList: h.stub }));
vi.mock("./components/BookmarksList", () => ({ BookmarksList: h.stub }));
vi.mock("./components/StatusBar", () => ({ StatusBar: h.stub }));
vi.mock("./components/TasksModal", () => ({ TasksModal: h.stub }));
vi.mock("./components/Guide", () => ({ Tour: h.stub, HelpModal: h.stub }));
vi.mock("./components/DocumentView", () => ({ DocumentView: h.stub, DocPopoutModal: h.stub }));
vi.mock("./components/DropOverlay", () => ({ DropOverlay: h.stub }));
vi.mock("./components/LazySurfaces", () => ({
  AgentWindows: h.stub, EphemeralModals: h.stub, OverlayBoundary: h.stub,
  GraphView: () => <div data-graph-stub />,
}));
vi.mock("./components/DetachedWindows", () => ({ AgentWindow: h.stub, ResearchWindow: h.stub }));
vi.mock("./components/FloatingLayers", () => ({ DragGhostLayer: h.stub, PreviewLayer: h.stub }));
vi.mock("./components/SortMenu", () => ({ SortMenu: h.stub }));
vi.mock("./components/CenterRegion", () => ({ CenterRegion: h.stub }));
vi.mock("./components/RightStack", () => ({ RightStack: h.stub }));
vi.mock("./components/PanelWindow", () => ({ PanelWindow: h.stub }));

import App from "./App";
import { getStore, useAppStore } from "./store";
import { PI_MIN_WIDTH } from "./lib/agent";
import type { VaultFile } from "./types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const initial = useAppStore.getState();

const file = (relPath: string): VaultFile => ({
  path: `/vault/${relPath}`, relPath, name: relPath.split("/").pop()!.replace(/\.md$/, ""),
  ext: "md", isMarkdown: true, size: 1, mtime: 0,
});

const spies = {
  openVault: vi.fn(async () => {}),
  flushSave: vi.fn(async () => {}),
  newNote: vi.fn(async () => {}),
  revealActiveFile: vi.fn(),
  openRecovery: vi.fn(),
};

function settings(patch: Partial<ReturnType<typeof getStore>["settings"]>): void {
  act(() => useAppStore.setState({ settings: { ...getStore().settings, ...patch } }));
}

beforeEach(() => {
  for (const fn of Object.values(spies)) fn.mockClear();
  h.invoke.mockReset();
  h.invoke.mockResolvedValue(true);
  h.confirm.mockReset();
  h.confirm.mockResolvedValue(true);
  h.effects.current = null;
  useAppStore.setState({
    ...(spies as unknown as Partial<ReturnType<typeof getStore>>),
    vaultPath: "/vault",
    files: [file("a/b/c.md"), file("a/d.md"), file("top.md")],
    graphFull: false,
    dragView: null,
    draggingFile: null,
    settings: {
      ...getStore().settings,
      sidebarOpen: true, sidebarAutoHide: false, sidebarWidth: 240,
      rightWidth: 300, rightStack: [], dockSide: "right",
      animations: true, hardwareAccel: true,
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAppStore.setState(initial, true);
});

const render = () => act(() => root.render(<App />));
const layout = () => host.querySelector<HTMLElement>(".layout")!;
const pointer = (type: string, target: EventTarget, clientX: number) => act(() => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  target.dispatchEvent(event);
});

describe("layout", () => {
  it("passes the main-window flag and vault to the main-window effects", () => {
    render();
    expect(h.effects.current).toMatchObject({ mainWindow: true, vaultPath: "/vault", requestedVault: "" });
  });

  it("reflects sidebar and dock settings in classes and width variables", () => {
    render();
    expect(layout().className).toBe("layout no-right");
    expect(layout().style.getPropertyValue("--sidebar-w")).toBe("240px");
    expect(layout().style.getPropertyValue("--sidebar-slot-w")).toBe("240px");
    expect(host.querySelector(".splitter-left")).not.toBeNull();
    expect(host.querySelector(".splitter-right")).toBeNull();

    settings({ sidebarAutoHide: true });
    expect(layout().className).toContain("auto-hide");
    expect(layout().style.getPropertyValue("--sidebar-slot-w")).toBe("0px");
    expect(host.querySelector(".sidebar-edge")).not.toBeNull();
    expect(host.querySelector(".splitter-left")).toBeNull();

    settings({ sidebarOpen: false, rightStack: ["agent"], dockSide: "left" });
    expect(layout().className).toBe("layout no-sidebar dock-left");
    expect(host.querySelector(".sidebar")!.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector(".splitter-right")).not.toBeNull();
  });

  it("never gives Pi a dock narrower than its minimum width", () => {
    settings({ rightStack: ["agent"], rightWidth: 200 });
    render();
    expect(layout().style.getPropertyValue("--right-w")).toBe(`${PI_MIN_WIDTH}px`);
    settings({ rightStack: ["preview"] });
    expect(layout().style.getPropertyValue("--right-w")).toBe("200px");
  });

  it("opens the right region while a view or file is being dragged", () => {
    render();
    act(() => useAppStore.setState({ draggingFile: "top.md" } as never));
    expect(layout().className).not.toContain("no-right");
  });

  it("swaps the layout for the full graph", () => {
    render();
    act(() => useAppStore.setState({ graphFull: true }));
    expect(host.querySelector(".layout")).toBeNull();
    expect(host.querySelector(".full-graph")).not.toBeNull();
  });

  it("mirrors the animation and acceleration settings on the document", () => {
    render();
    expect(document.documentElement.dataset.anim).toBe("on");
    expect(document.documentElement.dataset.accel).toBe("on");
    settings({ animations: false, hardwareAccel: false });
    expect(document.documentElement.dataset.anim).toBe("off");
    expect(document.documentElement.dataset.accel).toBe("off");
  });
});

describe("pane resize", () => {
  it("drags the sidebar live, clamps it and commits on release", () => {
    render();
    pointer("pointerdown", host.querySelector(".splitter-left")!, 100);
    pointer("pointermove", window, 160);
    expect(layout().style.getPropertyValue("--sidebar-w")).toBe("300px");
    expect(getStore().settings.sidebarWidth).toBe(240);
    pointer("pointermove", window, 2000);
    expect(layout().style.getPropertyValue("--sidebar-slot-w")).toBe("520px");
    pointer("pointerup", window, 2000);
    expect(getStore().settings.sidebarWidth).toBe(520);
  });

  it("widens a right dock when dragged left and restores on pointercancel without committing", () => {
    settings({ rightStack: ["preview"] });
    render();
    pointer("pointerdown", host.querySelector(".splitter-right")!, 500);
    pointer("pointermove", window, 450);
    expect(layout().style.getPropertyValue("--right-w")).toBe("350px");
    pointer("pointercancel", window, 450);
    expect(layout().style.getPropertyValue("--right-w")).toBe("300px");
    pointer("pointerup", window, 450);
    expect(getStore().settings.rightWidth).toBe(300);
  });

  it("flips the drag direction for a left dock and keeps Pi at its minimum", () => {
    settings({ rightStack: ["agent"], rightWidth: 500, dockSide: "left" });
    render();
    pointer("pointerdown", host.querySelector(".splitter-right")!, 500);
    pointer("pointermove", window, 540);
    pointer("pointerup", window, 540);
    expect(getStore().settings.rightWidth).toBe(540);
    pointer("pointerdown", host.querySelector(".splitter-right")!, 500);
    pointer("pointermove", window, 0);
    pointer("pointerup", window, 0);
    expect(getStore().settings.rightWidth).toBe(PI_MIN_WIDTH);
  });

  it("a new drag cancels the previous one and unmount cancels a live drag", () => {
    render();
    const splitter = host.querySelector(".splitter-left")!;
    pointer("pointerdown", splitter, 100);
    pointer("pointermove", window, 150);
    pointer("pointerdown", splitter, 100);
    expect(layout().style.getPropertyValue("--sidebar-w")).toBe("240px");
    pointer("pointermove", window, 120);
    act(() => root.unmount());
    pointer("pointerup", window, 120);
    expect(getStore().settings.sidebarWidth).toBe(240);
    root = createRoot(host);
  });
});

describe("sidebar header", () => {
  it("collapses every ancestor folder in one click", () => {
    render();
    act(() => host.querySelector<HTMLElement>('[aria-label="Collapse all folders"]')!.click());
    expect(getStore().collapsedFolders).toEqual({ a: true, "a/b": true });
  });

  it("routes new note, reveal and deleted files to the store", () => {
    render();
    for (const label of ["New note", "Reveal active file", "Open deleted files"]) {
      act(() => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click());
    }
    expect(spies.newNote).toHaveBeenCalledTimes(1);
    expect(spies.revealActiveFile).toHaveBeenCalledTimes(1);
    expect(spies.openRecovery).toHaveBeenCalledTimes(1);
  });
});

describe("early save flush", () => {
  it("flushes on window blur and when the page becomes hidden", () => {
    render();
    act(() => window.dispatchEvent(new Event("blur")));
    expect(spies.flushSave).toHaveBeenCalledTimes(1);
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      act(() => document.dispatchEvent(new Event("visibilitychange")));
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      if (visibility) Object.defineProperty(Document.prototype, "visibilityState", visibility);
    }
    expect(spies.flushSave).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
    act(() => window.dispatchEvent(new Event("blur")));
    expect(spies.flushSave).toHaveBeenCalledTimes(2);
    root = createRoot(host);
  });
});

describe("welcome", () => {
  it("opens a picker, and retries the remembered root unless it was never approved", () => {
    act(() => useAppStore.setState({ vaultPath: null, unavailableVault: { root: "/old", reason: "The folder is offline." } as never }));
    render();
    expect(host.querySelector("[data-welcome]")).not.toBeNull();
    act(() => h.welcome.current!.onOpen());
    expect(spies.openVault).toHaveBeenLastCalledWith();
    act(() => h.welcome.current!.onRetry());
    expect(spies.openVault).toHaveBeenLastCalledWith("/old");
    act(() => useAppStore.setState({ unavailableVault: { root: "/old", reason: "This vault folder has not been selected in Mesa yet." } as never }));
    act(() => h.welcome.current!.onRetry());
    expect(spies.openVault).toHaveBeenLastCalledWith(undefined);
  });
});

describe("blocked close", () => {
  type OnBlocked = (reason: unknown) => Promise<"keep" | "discard">;
  const block = (reason: unknown) => {
    let result!: Promise<"keep" | "discard">;
    act(() => { result = (h.effects.current!.onBlocked as OnBlocked)(reason); });
    return result;
  };
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;

  it("shows the reason once and Keep editing resolves keep", async () => {
    render();
    const first = block("Disk full");
    expect((h.effects.current!.onBlocked as OnBlocked)("again")).toBe(first);
    expect(document.body.textContent).toContain("Disk full");
    act(() => button("Keep editing").click());
    await expect(first).resolves.toBe("keep");
    expect(document.body.textContent).not.toContain("Changes could not be saved");
  });

  it("discards only after confirmation", async () => {
    render();
    h.confirm.mockResolvedValueOnce(false);
    const result = block("Locked");
    await act(async () => button("Close without saving").click());
    expect(document.body.textContent).toContain("Changes could not be saved");
    await act(async () => button("Close without saving").click());
    await expect(result).resolves.toBe("discard");
    expect(h.confirm).toHaveBeenCalledTimes(2);
  });

  it("saves recovery copies outside the vault through text_save_copy", async () => {
    const target = file("a/d.md");
    act(() => useAppStore.setState({ pendingTextSaves: () => [{ key: "k", target, content: "body", failed: true }] } as never));
    render();
    block("Busy");
    await act(async () => button("Save copies…").click());
    expect(h.invoke).toHaveBeenCalledWith("text_save_copy", { root: "/vault", name: "d-unsaved.md", content: "body" });
    expect(getStore().status).toMatch(/^Recovery copies saved/);
    expect(button("Save copies…").disabled).toBe(false);
  });

  it("stops at a declined copy and reports a failed one", async () => {
    const target = file("a/d.md");
    act(() => useAppStore.setState({
      status: "before",
      pendingTextSaves: () => [{ key: "1", target, content: "x", failed: true }, { key: "2", target, content: "y", failed: true }],
    } as never));
    render();
    block("Busy");
    h.invoke.mockResolvedValueOnce(false);
    await act(async () => button("Save copies…").click());
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(getStore().status).toBe("before");
    h.invoke.mockRejectedValueOnce(new Error("denied"));
    await act(async () => button("Save copies…").click());
    expect(getStore().status).toBe("Could not save recovery copies: Error: denied");
  });

  it("Escape keeps editing, but not while copies are being written", async () => {
    let finish!: (ok: boolean) => void;
    h.invoke.mockImplementation(() => new Promise<boolean>((r) => { finish = r; }));
    act(() => useAppStore.setState({ pendingTextSaves: () => [{ key: "k", target: file("top.md"), content: "x", failed: true }] } as never));
    render();
    const result = block("Busy");
    act(() => button("Save copies…").click());
    expect(button("Keep editing").disabled).toBe(true);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(document.body.textContent).toContain("Changes could not be saved");
    await act(async () => finish(true));
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await expect(result).resolves.toBe("keep");
  });

  it("resolves keep when the shell unmounts with the dialog open", async () => {
    render();
    const result = block("Busy");
    act(() => root.unmount());
    await expect(result).resolves.toBe("keep");
    root = createRoot(host);
  });
});
