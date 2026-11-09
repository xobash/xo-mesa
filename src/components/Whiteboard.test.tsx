// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Whiteboard } from "./overlay/Whiteboard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const calls: string[] = [];
const queries: { media: string; listeners: Set<() => void> }[] = [];
const setRatio = (value: number) => Object.defineProperty(window, "devicePixelRatio", { configurable: true, value });

beforeEach(() => {
  calls.length = 0;
  queries.length = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (media: string) => {
    const entry = { media, listeners: new Set<() => void>() };
    queries.push(entry);
    return {
      media,
      addEventListener: (_t: string, cb: () => void) => entry.listeners.add(cb),
      removeEventListener: (_t: string, cb: () => void) => entry.listeners.delete(cb),
    };
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    setTransform: (...args: number[]) => calls.push(`setTransform(${args.join(",")})`),
    clearRect: (...args: number[]) => calls.push(`clearRect(${args.join(",")})`),
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {},
  }) as unknown as CanvasRenderingContext2D);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.classList.contains("ov-board-canvas") ? 400 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return this.classList.contains("ov-board-canvas") ? 300 : 0; } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  // Drop the overrides; jsdom's own getters live on Element.prototype.
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  setRatio(1);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("sizes the whiteboard bitmap for the display and redraws when the ratio changes", () => {
  setRatio(1.5);
  act(() => root.render(<Whiteboard />));
  const canvas = host.querySelector<HTMLCanvasElement>('canvas[aria-label="Whiteboard drawing"]')!;
  expect([canvas.width, canvas.height]).toEqual([600, 450]);
  // Clear the whole bitmap, then draw CSS-pixel strokes through the ratio.
  expect(calls.slice(0, 3)).toEqual(["setTransform(1,0,0,1,0,0)", "clearRect(0,0,600,450)", "setTransform(1.5,0,0,1.5,0,0)"]);

  calls.length = 0;
  setRatio(2);
  act(() => { for (const cb of [...queries[queries.length - 1].listeners]) cb(); });
  expect([canvas.width, canvas.height]).toEqual([800, 600]);
  expect(calls).toContain("setTransform(2,0,0,2,0,0)");
});

it("keeps the bitmap at CSS size at 100% scaling", () => {
  act(() => root.render(<Whiteboard />));
  const canvas = host.querySelector<HTMLCanvasElement>('canvas[aria-label="Whiteboard drawing"]')!;
  expect([canvas.width, canvas.height]).toEqual([400, 300]);
});
