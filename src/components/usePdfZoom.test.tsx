// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePdfZoom } from "./usePdfZoom";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Zoom = ReturnType<typeof usePdfZoom>;
interface Box { left: number; top: number; width: number; height: number }

let api: Zoom;
let root: Root | null;
let host: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let viewport: Box;
let inner: Box;
const scroll = { left: 0, top: 0 };

function rect(b: Box): DOMRect {
  return { ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top, toJSON: () => ({}) } as DOMRect;
}

function Harness({ scale, renderScale, setScale }: { scale: number; renderScale: number; setScale: (s: number) => void }) {
  api = usePdfZoom(scale, renderScale, setScale);
  return (
    <div ref={api.bodyRef} data-role="body">
      <div ref={api.bindPages} data-role="pages">
        <div ref={api.bindPagesInner} data-role="inner" />
      </div>
    </div>
  );
}

async function render(scale: number, renderScale: number, setScale: (s: number) => void) {
  await act(async () => {
    root ??= createRoot(host);
    root.render(<Harness scale={scale} renderScale={renderScale} setScale={setScale} />);
  });
}

function el(role: string): HTMLDivElement {
  return host.querySelector(`[data-role="${role}"]`) as HTMLDivElement;
}
function zoomVar(): string {
  return el("inner").style.getPropertyValue("--pdf-zoom");
}
function runFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const cb of pending) cb(0);
}
function wheel(init: WheelEventInit) {
  const event = new WheelEvent("wheel", { cancelable: true, bubbles: true, ...init });
  el("pages").dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = null;
  frames = new Map();
  nextFrame = 1;
  viewport = { left: 0, top: 0, width: 400, height: 400 };
  inner = { left: 0, top: 0, width: 400, height: 400 };
  scroll.left = 0;
  scroll.top = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const role = this.getAttribute("data-role");
    return rect(role === "pages" ? viewport : role === "inner" ? inner : { left: 0, top: 0, width: 0, height: 0 });
  });
  // jsdom does not scroll; record the corrections the hook applies.
  Object.defineProperty(HTMLElement.prototype, "scrollLeft", { configurable: true, get: () => scroll.left, set: (v: number) => { scroll.left = v; } });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", { configurable: true, get: () => scroll.top, set: (v: number) => { scroll.top = v; } });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollLeft?: number }).scrollLeft;
  delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
});

describe("usePdfZoom", () => {
  it("starts the preview at the settled ratio, or 1 before a first render", async () => {
    await render(1.5, 1, vi.fn());
    expect(zoomVar()).toBe("1.5");
    await act(async () => root!.unmount());
    root = null;
    await render(1.5, 0, vi.fn());
    expect(zoomVar()).toBe("1");
  });

  it("clamps button zoom to 0.5..3 and ignores a no-op", async () => {
    const setScale = vi.fn();
    await render(1, 1, setScale);
    act(() => api.zoomTo(10));
    expect(setScale).toHaveBeenLastCalledWith(3);
    expect(api.manualZoomRef.current).toBe(true);
    act(() => api.zoomTo(0.01));
    expect(setScale).toHaveBeenLastCalledWith(0.5);
    setScale.mockClear();
    act(() => api.zoomTo(0.5));
    expect(setScale).not.toHaveBeenCalled();
  });

  it("paints the compositor preview once per frame until the raster catches up", async () => {
    await render(1, 1, vi.fn());
    act(() => api.zoomTo(2));
    act(() => api.zoomTo(2.5));
    expect(frames.size).toBe(1);
    runFrames();
    expect(zoomVar()).toBe("2.5");
  });

  it("keeps the point under the cursor fixed while zooming and after the repaint", async () => {
    const setScale = vi.fn();
    await render(1, 1, setScale);
    act(() => api.zoomTo(2, { x: 100, y: 50 }));
    // The preview doubles the page box around its origin.
    inner = { left: 0, top: 0, width: 800, height: 800 };
    runFrames();
    expect(scroll).toEqual({ left: 100, top: 50 });
    // The editor repaints at the new scale: preview resets and one final correction lands.
    inner = { left: 0, top: 0, width: 820, height: 820 };
    await render(2, 2, setScale);
    expect(zoomVar()).toBe("1");
    expect(scroll.left).toBeCloseTo(102.5);
    expect(scroll.top).toBeCloseTo(51.25);
    // The anchor is spent: a later repaint at the same scale moves nothing.
    inner = { left: 0, top: 0, width: 900, height: 900 };
    await render(2, 2, setScale);
    expect(scroll.left).toBeCloseTo(102.5);
  });

  it("anchors on the viewport centre when the cursor is outside it", async () => {
    await render(1, 1, vi.fn());
    act(() => api.zoomTo(2, { x: 1000, y: 1000 }));
    inner = { left: 0, top: 0, width: 800, height: 800 };
    runFrames();
    expect(scroll).toEqual({ left: 200, top: 200 });
  });

  it("drops the anchor when the page has no layout", async () => {
    inner = { left: 0, top: 0, width: 0, height: 0 };
    await render(1, 1, vi.fn());
    act(() => api.zoomTo(2, { x: 100, y: 100 }));
    inner = { left: 0, top: 0, width: 800, height: 800 };
    runFrames();
    expect(scroll).toEqual({ left: 0, top: 0 });
  });

  it("turns ctrl+wheel pinch into one settled scale after the gesture", async () => {
    const setScale = vi.fn();
    await render(1, 1, setScale);
    const first = wheel({ ctrlKey: true, deltaY: -100, clientX: 10, clientY: 10 });
    const second = wheel({ ctrlKey: true, deltaY: -100, clientX: 10, clientY: 10 });
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(setScale).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    expect(setScale).toHaveBeenCalledTimes(1);
    expect(setScale.mock.calls[0][0]).toBeCloseTo(Math.exp(0.6));
  });

  it("caps one wheel sample and scales line-mode deltas", async () => {
    const setScale = vi.fn();
    await render(1, 1, setScale);
    wheel({ ctrlKey: true, deltaY: 30, deltaMode: 1 });
    act(() => vi.advanceTimersByTime(100));
    // 30 lines x 16 px is capped at 120 px.
    expect(setScale.mock.calls[0][0]).toBeCloseTo(Math.exp(-0.36));
  });

  it("lets an ordinary wheel scroll through", async () => {
    const setScale = vi.fn();
    await render(1, 1, setScale);
    const event = wheel({ deltaY: 100 });
    act(() => vi.advanceTimersByTime(200));
    expect(event.defaultPrevented).toBe(false);
    expect(setScale).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("cancels a pending preview frame and settle timer on unmount", async () => {
    const setScale = vi.fn();
    await render(1, 1, setScale);
    wheel({ ctrlKey: true, deltaY: -50 });
    expect(frames.size).toBe(1);
    await act(async () => root!.unmount());
    root = null;
    expect(frames.size).toBe(0);
    vi.advanceTimersByTime(500);
    expect(setScale).not.toHaveBeenCalled();
  });
});
