// @vitest-environment jsdom
// Browser-mode (not Tauri) shell effects: keyboard routing, the Shift+Tab
// overlay gesture, the first-run tour and the demo auto-open.
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore, type AppState } from "../store";
import { DEMO_ROOT } from "../lib/vault";
import { resetPlainShiftTabChord } from "../lib/shortcuts";
import type { VaultFile } from "../types";
import { useMainWindowEffects } from "./useMainWindowEffects";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initial = useAppStore.getState();
let host: HTMLDivElement;
let root: Root;

function Harness({ mainWindow = true, vaultPath = "/vault", openVault }: {
  mainWindow?: boolean; vaultPath?: string | null; openVault: AppState["openVault"];
}) {
  const appRootRef = useRef<HTMLDivElement | null>(null);
  useMainWindowEffects({
    mainWindow, vaultPath, unavailableVault: null, openVault,
    requestedVault: "", onBlocked: async () => "keep", appRootRef,
  });
  return <div ref={appRootRef} />;
}

const file = (relPath: string): VaultFile =>
  ({ path: `/vault/${relPath}`, relPath, name: relPath.replace(/\.md$/, ""), ext: "md", isMarkdown: true }) as VaultFile;
const files = [file("a.md"), file("b.md"), file("c.md")];

const actions = () => ({
  selectFile: vi.fn(async () => {}),
  openSearch: vi.fn(),
  setPalette: vi.fn(),
  setSettingsOpen: vi.fn(),
  newNote: vi.fn(async () => {}),
  closeCenter: vi.fn(),
  removeViewFromWorkspace: vi.fn(),
  flipDockSide: vi.fn(),
  moveViewToCenter: vi.fn(),
  moveViewToRight: vi.fn(),
  togglePanel: vi.fn(),
  toggleOverlay: vi.fn(),
});
let a: ReturnType<typeof actions>;

function setSettings(patch: Partial<AppState["settings"]>) {
  useAppStore.setState({ settings: { ...useAppStore.getState().settings, ...patch } });
}

async function mount(props: { mainWindow?: boolean; vaultPath?: string | null; openVault?: AppState["openVault"] } = {}) {
  const openVault = props.openVault ?? (vi.fn(async () => {}) as unknown as AppState["openVault"]);
  await act(async () => root.render(<Harness {...props} openVault={openVault} />));
  return openVault;
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}
const focus = () => useAppStore.getState().keyboardFocus;

beforeEach(() => {
  localStorage.setItem("mesa:toured", "1");
  resetPlainShiftTabChord();
  useAppStore.setState(initial, true);
  a = actions();
  useAppStore.setState({
    ...a,
    vaultPath: "/vault",
    files,
    notes: {},
    activePath: "b.md",
    status: "",
    piOverlayOpen: false,
    keyboardFocus: { region: "center", rightIndex: 0 },
  });
  setSettings({ sortMode: "name", sortDir: "asc", typeFilter: "all", rightStack: ["preview"], centerView: "doc", sidebarOpen: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  localStorage.clear();
  useAppStore.setState(initial, true);
});

describe("app chords", () => {
  it("Mod+P, Mod+Shift+F, Mod+, and Mod+N open their surfaces and cancel the browser default", async () => {
    await mount();
    expect(press("p", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(a.setPalette).toHaveBeenCalledWith(true);
    expect(press("F", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(a.openSearch).toHaveBeenCalledWith("");
    press(",", { ctrlKey: true });
    expect(a.setSettingsOpen).toHaveBeenCalledWith(true);
    press("n", { ctrlKey: true });
    expect(a.newNote).toHaveBeenCalledTimes(1);
  });

  it("app chords still work from a text field; never stops propagation", async () => {
    await mount();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const later = vi.fn();
    window.addEventListener("keydown", later);
    try {
      press("p", { ctrlKey: true }, input);
      expect(a.setPalette).toHaveBeenCalledWith(true);
      expect(later).toHaveBeenCalledTimes(1);
      // Plain navigation keys belong to the text field.
      press("j", {}, input);
      press("/", {}, input);
      expect(a.selectFile).not.toHaveBeenCalled();
      expect(a.openSearch).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", later);
    }
  });

  it("an event another handler already cancelled is left alone", async () => {
    await mount();
    const event = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true });
    event.preventDefault();
    act(() => { window.dispatchEvent(event); });
    expect(a.setPalette).not.toHaveBeenCalled();
  });

  it("Mod+Space with the left Shift held toggles the Pi overlay in the browser; keyup and blur release Shift", async () => {
    await mount();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true })); });
    press(" ", { code: "Space", ctrlKey: true, shiftKey: true });
    expect(useAppStore.getState().piOverlayOpen).toBe(true);
    act(() => { window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft" })); });
    press(" ", { code: "Space", ctrlKey: true, shiftKey: true });
    expect(useAppStore.getState().piOverlayOpen).toBe(true);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true })); });
    act(() => { window.dispatchEvent(new Event("blur")); });
    press(" ", { code: "Space", ctrlKey: true, shiftKey: true });
    expect(useAppStore.getState().piOverlayOpen).toBe(true);
  });

  it("a detached window owns none of these keys, and unmount removes the listeners", async () => {
    await mount({ mainWindow: false });
    press("p", { ctrlKey: true });
    press("Tab", { shiftKey: true });
    press("j");
    expect(a.setPalette).not.toHaveBeenCalled();
    expect(a.toggleOverlay).not.toHaveBeenCalled();
    expect(a.selectFile).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    await act(async () => root.unmount());
    root = createRoot(host);
    press("p", { ctrlKey: true });
    press("Tab", { shiftKey: true });
    expect(a.setPalette).not.toHaveBeenCalled();
    expect(a.toggleOverlay).not.toHaveBeenCalled();
  });
});

describe("Shift+Tab overlay gesture", () => {
  it("toggles once per physical chord from a workspace region and claims the event", async () => {
    await mount();
    const later = vi.fn();
    window.addEventListener("keydown", later);
    try {
      const first = press("Tab", { shiftKey: true });
      expect(first.defaultPrevented).toBe(true);
      expect(later).not.toHaveBeenCalled();
      expect(a.toggleOverlay).toHaveBeenCalledTimes(1);
      press("Tab", { shiftKey: true, repeat: true });
      expect(a.toggleOverlay).toHaveBeenCalledTimes(1);
      act(() => { window.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", shiftKey: true })); });
      press("Tab", { shiftKey: true });
      expect(a.toggleOverlay).toHaveBeenCalledTimes(2);
      // Blur ends the chord too.
      act(() => { window.dispatchEvent(new Event("blur")); });
      press("Tab", { shiftKey: true });
      expect(a.toggleOverlay).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener("keydown", later);
    }
  });

  it("stays ordinary backward focus inside text controls and dialogs", async () => {
    await mount();
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    expect(press("Tab", { shiftKey: true }, input).defaultPrevented).toBe(false);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);
    button.focus();
    expect(press("Tab", { shiftKey: true }, button).defaultPrevented).toBe(false);
    // Ctrl+Shift+Tab is not the overlay gesture.
    press("Tab", { shiftKey: true, ctrlKey: true });
    expect(a.toggleOverlay).not.toHaveBeenCalled();
  });
});

describe("vim-style navigation", () => {
  it("j/k step through the sidebar order and focus the sidebar", async () => {
    await mount();
    press("j");
    expect(a.selectFile).toHaveBeenLastCalledWith("c.md");
    expect(focus().region).toBe("sidebar");
    press("k");
    expect(a.selectFile).toHaveBeenLastCalledWith("a.md");
  });

  it("j/k in the side region do nothing", async () => {
    useAppStore.setState({ keyboardFocus: { region: "right", rightIndex: 0 } });
    await mount();
    press("j");
    expect(a.selectFile).not.toHaveBeenCalled();
    expect(focus()).toEqual({ region: "right", rightIndex: 0 });
  });

  it("g g jumps to the first file, G to the last, and Escape clears the prefix", async () => {
    await mount();
    press("g");
    expect(useAppStore.getState().status).toMatch(/g again jumps to the first file/);
    press("g");
    expect(a.selectFile).toHaveBeenLastCalledWith("a.md");
    expect(focus().region).toBe("sidebar");
    // g followed by another key consumes only the prefix.
    a.selectFile.mockClear();
    press("g");
    press("x");
    press("g");
    expect(a.selectFile).not.toHaveBeenCalled();
    press("Escape");
    press("g");
    expect(a.selectFile).not.toHaveBeenCalled();
  });

  // Bug: `k === "g"` (lower-cased key) is tested before `key === "G"`
  // (useMainWindowEffects.ts:551 vs :559), so Shift+G only arms the g prefix
  // and never jumps to the last file that the status hint promises.
  it("Shift+G jumps to the last file", async () => {
    await mount();
    press("G", { shiftKey: true });
    expect(a.selectFile).toHaveBeenLastCalledWith("c.md");
  });

  it("modified plain keys are not navigation", async () => {
    await mount();
    press("j", { altKey: true });
    press("g", { ctrlKey: true });
    expect(a.selectFile).not.toHaveBeenCalled();
    expect(useAppStore.getState().status).toBe("");
  });

  it("h/l move focus between regions; h from center opens a closed sidebar", async () => {
    await mount();
    press("l");
    expect(focus()).toEqual({ region: "right", rightIndex: 0 });
    press("h");
    expect(focus().region).toBe("center");
    press("h");
    expect(focus().region).toBe("sidebar");
    press("l");
    setSettings({ sidebarOpen: false });
    press("h");
    expect(useAppStore.getState().settings.sidebarOpen).toBe(true);
    expect(focus().region).toBe("sidebar");
  });

  it("/ opens search, v moves the document to center, b toggles the sidebar", async () => {
    await mount();
    press("/");
    expect(a.openSearch).toHaveBeenCalledWith("");
    press("v");
    expect(a.moveViewToCenter).toHaveBeenCalledWith("doc");
    expect(focus().region).toBe("center");
    // Closing the sidebar moves focus to the center; opening it focuses it.
    press("b");
    expect(useAppStore.getState().settings.sidebarOpen).toBe(false);
    expect(focus()).toEqual({ region: "center", rightIndex: 0 });
    press("b");
    expect(useAppStore.getState().settings.sidebarOpen).toBe(true);
    expect(focus()).toEqual({ region: "sidebar", rightIndex: 0 });
  });

  it("p and t focus an open panel, open a missing one, or focus the center view", async () => {
    setSettings({ rightStack: ["preview"] });
    await mount();
    press("p");
    expect(a.togglePanel).not.toHaveBeenCalled();
    expect(focus()).toEqual({ region: "right", rightIndex: 0 });
    press("t");
    expect(a.togglePanel).toHaveBeenCalledWith("tasks");
    expect(focus()).toEqual({ region: "right", rightIndex: 1 });

    setSettings({ centerView: "tasks", rightStack: ["tasks"] });
    press("t");
    expect(focus().region).toBe("center");
    press("p");
    expect(a.togglePanel).toHaveBeenLastCalledWith("preview");

    setSettings({ centerView: "preview", rightStack: [] });
    useAppStore.setState({ keyboardFocus: { region: "sidebar", rightIndex: 0 } });
    press("p");
    expect(focus().region).toBe("center");
    setSettings({ centerView: "doc", rightStack: ["tasks"] });
    press("t");
    expect(focus()).toEqual({ region: "right", rightIndex: 0 });
  });
});

describe("Ctrl+W window prefix", () => {
  it("q closes the focused pane: center, or the side view", async () => {
    await mount();
    press("w", { ctrlKey: true });
    press("q");
    expect(a.closeCenter).toHaveBeenCalledTimes(1);
    useAppStore.setState({ keyboardFocus: { region: "right", rightIndex: 0 } });
    press("w", { ctrlKey: true });
    press("c");
    expect(a.removeViewFromWorkspace).toHaveBeenCalledWith("preview");
  });

  it("f flips the dock side; Shift+L moves the center view to the side", async () => {
    await mount();
    press("w", { ctrlKey: true });
    press("f");
    expect(a.flipDockSide).toHaveBeenCalledTimes(1);
    press("w", { ctrlKey: true });
    press("L", { shiftKey: true });
    expect(a.moveViewToRight).toHaveBeenCalledWith("doc");
    expect(focus()).toEqual({ region: "right", rightIndex: 1 });
  });

  it("Shift+L with an empty center only moves focus; an unrelated key ends the prefix", async () => {
    setSettings({ centerView: "empty" });
    await mount();
    press("w", { ctrlKey: true });
    press("L", { shiftKey: true });
    expect(a.moveViewToRight).not.toHaveBeenCalled();
    expect(focus().region).toBe("right");
    useAppStore.setState({ keyboardFocus: { region: "center", rightIndex: 0 } });
    press("w", { ctrlKey: true });
    press("x");
    expect(a.selectFile).not.toHaveBeenCalled();
    press("j");
    // After the prefix is consumed, j is ordinary navigation again.
    expect(a.selectFile).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Alt+W is not the window prefix", async () => {
    await mount();
    press("w", { ctrlKey: true, altKey: true });
    expect(useAppStore.getState().status).toBe("");
  });
});

describe("startup in the browser", () => {
  it("opens the demo vault when nothing is open", async () => {
    useAppStore.setState({ vaultPath: null });
    const openVault = await mount({ vaultPath: null });
    expect(openVault).toHaveBeenCalledWith(DEMO_ROOT);
  });

  it("opens the first-run tour after 450 ms of no user action", async () => {
    vi.useFakeTimers();
    localStorage.removeItem("mesa:toured");
    useAppStore.setState({ tourOpen: false, loading: false });
    await mount();
    act(() => { vi.advanceTimersByTime(449); });
    expect(useAppStore.getState().tourOpen).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(useAppStore.getState().tourOpen).toBe(true);
  });

  it("a user action before the delay cancels the tour", async () => {
    vi.useFakeTimers();
    localStorage.removeItem("mesa:toured");
    useAppStore.setState({ tourOpen: false, loading: false });
    await mount();
    act(() => { window.dispatchEvent(new Event("pointerdown")); vi.advanceTimersByTime(1_000); });
    expect(useAppStore.getState().tourOpen).toBe(false);
  });

  it("waits while another surface is open and schedules once it closes", async () => {
    vi.useFakeTimers();
    localStorage.removeItem("mesa:toured");
    useAppStore.setState({ tourOpen: false, loading: false, settingsOpen: true });
    await mount();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(useAppStore.getState().tourOpen).toBe(false);
    act(() => { useAppStore.setState({ settingsOpen: false }); });
    act(() => { vi.advanceTimersByTime(450); });
    expect(useAppStore.getState().tourOpen).toBe(true);
  });

  it("never opens the tour once it has been seen", async () => {
    vi.useFakeTimers();
    useAppStore.setState({ tourOpen: false, loading: false });
    await mount();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(useAppStore.getState().tourOpen).toBe(false);
  });
});
