// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Native window boundary: this detached window's position and move events,
// the main window's frame, and the global cursor.
const native = vi.hoisted(() => ({
  cursor: { x: 0, y: 0 },
  position: { x: 0, y: 0 },
  mainExists: true,
  main: { x: 100, y: 100, width: 1000, height: 800 },
  moved: [] as Array<(event: { payload: { x: number; y: number } }) => void>,
  unlisten: vi.fn(),
  calls: [] as string[],
  emitTo: vi.fn(async (target: string, event: string, payload: unknown) => {
    native.calls.push(`emit:${target}:${event}:${JSON.stringify(payload)}`);
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({ emitTo: native.emitTo }));
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: async () => ({ ...native.cursor }),
  getCurrentWindow: () => ({
    outerPosition: async () => ({ ...native.position }),
    onMoved: async (handler: (event: { payload: { x: number; y: number } }) => void) => {
      native.moved.push(handler);
      return native.unlisten;
    },
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: async (label: string) =>
      label === "main" && native.mainExists
        ? {
            outerPosition: async () => ({ x: native.main.x, y: native.main.y }),
            outerSize: async () => ({ width: native.main.width, height: native.main.height }),
          }
        : null,
  },
  getCurrentWebviewWindow: () => ({
    close: async () => {
      native.calls.push("close");
    },
  }),
}));

import {
  DOCK_WINDOW_EVENT,
  closeCurrentPopoutWindow,
  dockIntoMainWindow,
  installNativeDragDock,
  type DockWindowPayload,
} from "./windowDock";

const OUTSIDE = { x: 1500, y: 300 };
const INSIDE = { x: 500, y: 400 };
const payload: DockWindowPayload = { kind: "panel", view: "graph", relPath: null };

function docked() {
  return native.calls.includes("close");
}

/** Emit one native move and let its async main-window probe settle. */
async function move(x: number, y: number, cursor?: { x: number; y: number }, gapMs = 40) {
  if (cursor) native.cursor = { ...cursor };
  native.position = { x, y };
  for (const handler of native.moved) handler({ payload: { x, y } });
  await vi.advanceTimersByTimeAsync(gapMs);
}

/** A sustained drag: three moves spanning 80+ ms and 100+ px. */
async function drag(from: { x: number; y: number }, cursorPath: Array<{ x: number; y: number }>) {
  for (let i = 0; i < cursorPath.length; i += 1) {
    await move(from.x + (i + 1) * 50, from.y, cursorPath[i]);
  }
}

function pointer(type: string, target: EventTarget, button = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "button", { value: button });
  target.dispatchEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  native.cursor = { ...OUTSIDE };
  native.position = { x: 1400, y: 200 };
  native.mainExists = true;
  native.moved = [];
  native.calls = [];
  native.unlisten.mockReset();
  native.emitTo.mockClear();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("dockIntoMainWindow", () => {
  it("tells main to dock before closing this window", async () => {
    await dockIntoMainWindow({ kind: "doc", relPath: "A.md" });
    expect(native.calls).toEqual([`emit:main:${DOCK_WINDOW_EVENT}:{"kind":"doc","relPath":"A.md"}`, "close"]);
  });

  it("closes a popout without docking", async () => {
    await closeCurrentPopoutWindow();
    expect(native.calls).toEqual(["close"]);
  });
});

describe("installNativeDragDock without a drag arm", () => {
  it("docks after a sustained drag that started outside Mesa is released over it", async () => {
    await installNativeDragDock(payload);
    await drag(native.position, [OUTSIDE, OUTSIDE, INSIDE]);
    expect(docked()).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(native.emitTo).toHaveBeenCalledWith("main", DOCK_WINDOW_EVENT, payload);
    expect(docked()).toBe(true);
  });

  it("does not dock a drag that never left Mesa", async () => {
    native.cursor = { ...INSIDE };
    await installNativeDragDock(payload);
    await drag(native.position, [INSIDE, INSIDE, INSIDE]);
    await vi.advanceTimersByTimeAsync(500);
    expect(docked()).toBe(false);
  });

  it("does not dock a short jitter over Mesa", async () => {
    await installNativeDragDock(payload);
    await move(1401, 200, INSIDE);
    await move(1402, 200, INSIDE);
    await move(1403, 201, INSIDE);
    await vi.advanceTimersByTimeAsync(500);
    expect(docked()).toBe(false);
  });

  it("waits while a drag pauses outside Mesa and docks when it continues inward", async () => {
    await installNativeDragDock(payload);
    await drag(native.position, [OUTSIDE, OUTSIDE, OUTSIDE]);
    await vi.advanceTimersByTimeAsync(500);
    expect(docked()).toBe(false);
    await move(1600, 200, INSIDE);
    await vi.advanceTimersByTimeAsync(200);
    expect(docked()).toBe(true);
  });

  it("never docks when the main window is gone", async () => {
    native.mainExists = false;
    await installNativeDragDock(payload);
    await drag(native.position, [OUTSIDE, OUTSIDE, INSIDE]);
    await vi.advanceTimersByTimeAsync(500);
    expect(docked()).toBe(false);
  });

  it("cleanup cancels a pending dock and stops listening", async () => {
    const cleanup = await installNativeDragDock(payload);
    await drag(native.position, [OUTSIDE, OUTSIDE, INSIDE]);
    cleanup();
    await vi.advanceTimersByTimeAsync(500);
    expect(docked()).toBe(false);
    expect(native.unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("installNativeDragDock with requireUserDragArm", () => {
  function dragRegion() {
    const bar = document.createElement("div");
    bar.setAttribute("data-tauri-drag-region", "");
    const title = document.createElement("span");
    const button = document.createElement("button");
    bar.append(title, button);
    document.body.appendChild(bar);
    return { bar, title, button };
  }

  it("ignores native moves until the user presses the drag region", async () => {
    await installNativeDragDock(payload, { requireUserDragArm: true });
    await drag(native.position, [OUTSIDE, OUTSIDE, INSIDE]);
    await vi.advanceTimersByTimeAsync(500);
    expect(docked()).toBe(false);
  });

  it("does not arm from a control, a secondary button or outside the drag region", async () => {
    const { button, title } = dragRegion();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    await installNativeDragDock(payload, { requireUserDragArm: true });
    pointer("pointerdown", button);
    pointer("pointerdown", title, 2);
    pointer("pointerdown", outside);
    await drag(native.position, [OUTSIDE, OUTSIDE, INSIDE]);
    await vi.advanceTimersByTimeAsync(500);
    expect(docked()).toBe(false);
  });

  it("docks an armed drag that leaves Mesa and is released over it", async () => {
    const { title } = dragRegion();
    native.cursor = { ...INSIDE };
    await installNativeDragDock(payload, { requireUserDragArm: true });
    // A startup correction before the press never counts toward the gesture.
    await move(900, 900);
    pointer("pointerdown", title);
    await drag(native.position, [OUTSIDE, OUTSIDE, INSIDE]);
    pointer("pointerup", window);
    await vi.advanceTimersByTimeAsync(200);
    expect(docked()).toBe(true);
  });

  it("an armed drag that never leaves Mesa does not dock and stays disarmed", async () => {
    const { title } = dragRegion();
    native.cursor = { ...INSIDE };
    await installNativeDragDock(payload, { requireUserDragArm: true });
    pointer("pointerdown", title);
    await drag(native.position, [INSIDE, INSIDE, INSIDE]);
    pointer("pointerup", window);
    await vi.advanceTimersByTimeAsync(500);
    expect(docked()).toBe(false);
    // Later movement without a new press cannot accumulate into a dock.
    await drag(native.position, [OUTSIDE, OUTSIDE, INSIDE]);
    await vi.advanceTimersByTimeAsync(500);
    expect(docked()).toBe(false);
  });

  it("a click with no native movement disarms docking", async () => {
    const { title } = dragRegion();
    await installNativeDragDock(payload, { requireUserDragArm: true });
    pointer("pointerdown", title);
    pointer("pointercancel", window);
    await drag(native.position, [OUTSIDE, OUTSIDE, INSIDE]);
    await vi.advanceTimersByTimeAsync(500);
    expect(docked()).toBe(false);
  });

  it("cleanup removes exactly the pointer listeners it installed", async () => {
    const docAdd = vi.spyOn(document, "addEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");
    const winAdd = vi.spyOn(window, "addEventListener");
    const winRemove = vi.spyOn(window, "removeEventListener");
    const cleanup = await installNativeDragDock(payload, { requireUserDragArm: true });
    const installed = [...docAdd.mock.calls, ...winAdd.mock.calls].filter(([type]) => String(type).startsWith("pointer"));
    expect(installed.map(([type]) => type).sort()).toEqual(["pointercancel", "pointerdown", "pointerup"]);
    cleanup();
    const removed = [...docRemove.mock.calls, ...winRemove.mock.calls].filter(([type]) => String(type).startsWith("pointer"));
    for (const [type, handler, capture] of installed) {
      expect(removed).toContainEqual([type, handler, capture]);
    }
    expect(native.unlisten).toHaveBeenCalledTimes(1);
  });
});
