// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasBackingScale, currentDevicePixelRatio, onDevicePixelRatioChange } from "./devicePixelRatio";
import { PDF_CANVAS_BUDGET_BYTES, PDF_CANVAS_MAX_SCALED_PIXELS, pdfCanvasBackingScale } from "./pdfCanvasBudget";

const setRatio = (value: number) => Object.defineProperty(window, "devicePixelRatio", { configurable: true, value });

afterEach(() => {
  setRatio(1);
  vi.unstubAllGlobals();
});

describe("canvas backing scale", () => {
  it("uses the device pixel ratio for ordinary pages", () => {
    expect(canvasBackingScale(918, 1188, 1.25, 8_000_000)).toBe(1.25);
    expect(canvasBackingScale(918, 1188, 1.5, 8_000_000)).toBe(1.5);
    expect(canvasBackingScale(918, 1188, 2, 8_000_000)).toBe(2);
  });

  it("never draws coarser than the CSS box", () => {
    expect(canvasBackingScale(918, 1188, 1, 8_000_000)).toBe(1);
    expect(canvasBackingScale(918, 1188, 0.75, 8_000_000)).toBe(1);
    expect(canvasBackingScale(918, 1188, Number.NaN, 8_000_000)).toBe(1);
    expect(canvasBackingScale(0, 0, 2, 8_000_000)).toBe(1);
    // A page already over the ceiling at CSS size is left at CSS size.
    expect(canvasBackingScale(4000, 4000, 2, 8_000_000)).toBe(1);
  });

  it("caps a huge zoomed page at the pixel ceiling", () => {
    const scale = pdfCanvasBackingScale(2448, 3168, 2);
    expect(scale).toBeGreaterThan(1);
    expect(scale).toBeLessThan(2);
    expect(Math.floor(2448 * scale) * Math.floor(3168 * scale)).toBeLessThanOrEqual(PDF_CANVAS_MAX_SCALED_PIXELS);
  });

  it("leaves room for a three-page paint band inside the canvas budget", () => {
    expect(3 * PDF_CANVAS_MAX_SCALED_PIXELS * 4).toBeLessThanOrEqual(PDF_CANVAS_BUDGET_BYTES);
  });
});

describe("device pixel ratio changes", () => {
  it("reads a sane ratio", () => {
    setRatio(1.5);
    expect(currentDevicePixelRatio()).toBe(1.5);
    setRatio(0);
    expect(currentDevicePixelRatio()).toBe(1);
  });

  it("re-arms the resolution query for each new ratio and stops on dispose", () => {
    const armed: { media: string; listeners: Set<() => void> }[] = [];
    vi.stubGlobal("matchMedia", (media: string) => {
      const entry = { media, listeners: new Set<() => void>() };
      armed.push(entry);
      return {
        media,
        addEventListener: (_t: string, cb: () => void) => entry.listeners.add(cb),
        removeEventListener: (_t: string, cb: () => void) => entry.listeners.delete(cb),
      };
    });
    setRatio(1.25);
    const seen: number[] = [];
    const stop = onDevicePixelRatioChange((ratio) => seen.push(ratio));
    expect(armed.map((a) => a.media)).toEqual(["(resolution: 1.25dppx)"]);
    setRatio(1.5);
    for (const cb of [...armed[0].listeners]) cb();
    expect(seen).toEqual([1.5]);
    expect(armed[0].listeners.size).toBe(0);
    expect(armed[1].media).toBe("(resolution: 1.5dppx)");
    stop();
    expect(armed[1].listeners.size).toBe(0);
  });

  it("does nothing without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(() => onDevicePixelRatioChange(() => {})()).not.toThrow();
  });
});
