// @vitest-environment jsdom
import { act, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ tauri: true }));
vi.mock("../../lib/vault", async (original) => {
  const actual = await original<Record<string, unknown>>();
  return { ...actual, get IN_TAURI() { return flags.tauri; } };
});
// The real AgentSurface owns the PTY; the window only wires its title bar.
vi.mock("../AgentPanel", () => ({
  AgentSurface: (props: {
    onTitleBarPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onTitleBarKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
    windowTitle: string;
  }) => (
    <div className="stub-pi-bar" tabIndex={0} aria-label={props.windowTitle}
      onPointerDown={props.onTitleBarPointerDown} onKeyDown={props.onTitleBarKeyDown}>
      <span className="stub-child" tabIndex={0} />
    </div>
  ),
}));

import { useAppStore } from "../../store";
import { PI_MIN_WIDTH } from "../../lib/agent";
import { FloatingWindow, PiOverlayWindow, type WinRec } from "./OverlayWindows";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initial = useAppStore.getState();
let host: HTMLDivElement;
let root: Root;
const rec: WinRec = { open: true, x: 100, y: 100, w: 500, h: 400 };
const change = vi.fn();
const close = vi.fn();
const focusWin = vi.fn();
const place = vi.fn();
let openAgentWindow: ReturnType<typeof vi.fn>;

function pointer(target: EventTarget, type: string, init: MouseEventInit & { pointerId?: number } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}
function key(target: HTMLElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function renderPi() {
  act(() => root.render(
    <PiOverlayWindow rec={rec} z={3} onChange={change} onClose={close} onFocus={focusWin} onPlaceInWorkspace={place} />
  ));
}
const win = () => host.querySelector<HTMLElement>(".pi-ov-win")!;
const bar = () => host.querySelector<HTMLElement>(".stub-pi-bar")!;
const resizeHandle = () => host.querySelector<HTMLElement>(".ov-win-resize")!;

beforeEach(() => {
  flags.tauri = true;
  vi.clearAllMocks();
  openAgentWindow = vi.fn(async () => true);
  useAppStore.setState({ openAgentWindow } as never);
  document.body.style.userSelect = "text";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => { window.dispatchEvent(new Event("pointercancel")); window.dispatchEvent(new Event("pointerup")); });
  act(() => root.unmount());
  host.remove();
  useAppStore.setState(initial, true);
});

describe("PiOverlayWindow", () => {
  it("renders at the stored geometry and stacking order", () => {
    renderPi();
    expect(win().style.left).toBe("100px");
    expect(win().style.top).toBe("100px");
    expect(win().style.width).toBe("500px");
    expect(win().style.height).toBe("400px");
    expect(win().style.zIndex).toBe("3");
    expect(bar().getAttribute("aria-label")).toBe("Pi agent");
  });

  it("drags inside the viewport with clamping and suppresses text selection until release", () => {
    renderPi();
    const down = pointer(bar(), "pointerdown", { clientX: 160, clientY: 120 });
    expect(down.defaultPrevented).toBe(true);
    expect(focusWin).toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe("none");
    pointer(window, "pointermove", { clientX: 400, clientY: 300 });
    expect(change).toHaveBeenLastCalledWith({ x: 340, y: 280 });
    // Clamped to the left edge and below the top bar.
    pointer(window, "pointermove", { clientX: 0, clientY: 0 });
    expect(change).toHaveBeenLastCalledWith({ x: 4, y: 56 });
    pointer(window, "pointerup", { clientX: 400, clientY: 300 });
    expect(document.body.style.userSelect).toBe("text");
    expect(openAgentWindow).not.toHaveBeenCalled();
    // Listeners are gone after release.
    change.mockClear();
    pointer(window, "pointermove", { clientX: 500, clientY: 300 });
    expect(change).not.toHaveBeenCalled();
  });

  it("arms the tear-off near an edge and opens a native Pi window on edge release", async () => {
    renderPi();
    pointer(bar(), "pointerdown", { clientX: 160, clientY: 120 });
    pointer(window, "pointermove", { clientX: window.innerWidth - 2, clientY: 300 });
    expect(win().classList.contains("tear-off-armed")).toBe(true);
    pointer(window, "pointermove", { clientX: 400, clientY: 300 });
    expect(win().classList.contains("tear-off-armed")).toBe(false);
    pointer(window, "pointermove", { clientX: window.innerWidth - 2, clientY: 300 });
    pointer(window, "pointerup", { clientX: window.innerWidth - 2, clientY: 300, screenX: 1600, screenY: 400 });
    expect(win().classList.contains("tear-off-armed")).toBe(false);
    expect(openAgentWindow).toHaveBeenCalledWith({ x: 1540, y: 380, width: 500, height: 400 });
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps the overlay window when the native window does not open", async () => {
    openAgentWindow.mockResolvedValueOnce(false);
    renderPi();
    pointer(bar(), "pointerdown", { clientX: 160, clientY: 120 });
    pointer(window, "pointerup", { clientX: 0, clientY: 300, screenX: 10, screenY: 400 });
    expect(openAgentWindow).toHaveBeenCalledTimes(1);
    await flush();
    expect(close).not.toHaveBeenCalled();
  });

  it("never tears off in the browser build", () => {
    flags.tauri = false;
    renderPi();
    pointer(bar(), "pointerdown", { clientX: 160, clientY: 120 });
    pointer(window, "pointerup", { clientX: 0, clientY: 300 });
    expect(openAgentWindow).not.toHaveBeenCalled();
  });

  it("pointercancel ends the drag without tearing off and restores selection", () => {
    renderPi();
    pointer(bar(), "pointerdown", { clientX: 160, clientY: 120 });
    pointer(window, "pointermove", { clientX: 0, clientY: 300 });
    expect(win().classList.contains("tear-off-armed")).toBe(true);
    act(() => { window.dispatchEvent(new Event("pointercancel")); });
    expect(win().classList.contains("tear-off-armed")).toBe(false);
    expect(document.body.style.userSelect).toBe("text");
    pointer(window, "pointerup", { clientX: 0, clientY: 300 });
    expect(openAgentWindow).not.toHaveBeenCalled();
  });

  it("ignores secondary buttons and survives a webview without pointer capture", () => {
    renderPi();
    pointer(bar(), "pointerdown", { button: 2, clientX: 160, clientY: 120 });
    pointer(window, "pointermove", { clientX: 400, clientY: 300 });
    expect(change).not.toHaveBeenCalled();
    const capture = vi.fn(() => { throw new Error("unsupported"); });
    (bar() as HTMLElement & { setPointerCapture: unknown }).setPointerCapture = capture;
    pointer(bar(), "pointerdown", { clientX: 160, clientY: 120 });
    expect(capture).toHaveBeenCalled();
    pointer(window, "pointermove", { clientX: 400, clientY: 300 });
    expect(change).toHaveBeenLastCalledWith({ x: 340, y: 280 });
  });

  it("Ctrl/Cmd+Shift+Enter on the title bar separates Pi and closes the overlay window once it opens", async () => {
    renderPi();
    const event = key(bar(), { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(openAgentWindow).toHaveBeenCalledWith();
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("Arrow moves and Shift+Arrow resizes, with Pi's minimum width", () => {
    renderPi();
    expect(key(bar(), { key: "ArrowDown" }).defaultPrevented).toBe(true);
    expect(change).toHaveBeenLastCalledWith({ y: 116 });
    key(bar(), { key: "ArrowLeft", shiftKey: true });
    expect(change).toHaveBeenLastCalledWith({ w: 484 });
    // Unrelated keys and keys from inside the bar are left alone.
    change.mockClear();
    expect(key(bar(), { key: "a" }).defaultPrevented).toBe(false);
    const child = host.querySelector<HTMLElement>(".stub-child")!;
    expect(key(child, { key: "ArrowDown" }).defaultPrevented).toBe(false);
    expect(key(child, { key: "Enter", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(change).not.toHaveBeenCalled();
    expect(openAgentWindow).not.toHaveBeenCalled();
  });

  it("the resize grip grows the window within Pi's minimum and the viewport", () => {
    renderPi();
    const down = pointer(resizeHandle(), "pointerdown", { clientX: 600, clientY: 500 });
    expect(down.defaultPrevented).toBe(true);
    expect(focusWin).toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe("none");
    pointer(window, "pointermove", { clientX: 650, clientY: 560 });
    expect(change).toHaveBeenLastCalledWith({ w: 550, h: 460 });
    pointer(window, "pointermove", { clientX: 0, clientY: 0 });
    expect(change).toHaveBeenLastCalledWith({ w: PI_MIN_WIDTH, h: 320 });
    pointer(window, "pointermove", { clientX: 5_000, clientY: 5_000 });
    expect(change).toHaveBeenLastCalledWith({ w: window.innerWidth - rec.x - 8, h: window.innerHeight - rec.y - 8 });
    pointer(window, "pointerup", {});
    expect(document.body.style.userSelect).toBe("text");
    change.mockClear();
    pointer(window, "pointermove", { clientX: 650, clientY: 560 });
    expect(change).not.toHaveBeenCalled();
  });
});

describe("FloatingWindow resize", () => {
  it("uses the shared grip with the generic 280 × 180 minimum and does not start a drag", () => {
    act(() => root.render(
      <FloatingWindow title="Scratchpad" rec={rec} z={1} onChange={change} onClose={close} onFocus={focusWin}>body</FloatingWindow>
    ));
    expect(host.querySelector(".ov-win-bar")!.getAttribute("aria-label")).not.toContain("separates");
    pointer(resizeHandle(), "pointerdown", { clientX: 600, clientY: 500 });
    pointer(window, "pointermove", { clientX: 0, clientY: 0 });
    expect(change).toHaveBeenLastCalledWith({ w: 280, h: 180 });
    pointer(window, "pointerup", {});
    // Without a tear-off handler, the transfer chord is an ordinary key.
    const bar = host.querySelector<HTMLElement>(".ov-win-bar")!;
    expect(key(bar, { key: "Enter", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
  });
});
