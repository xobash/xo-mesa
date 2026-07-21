import { describe, expect, it } from "vitest";
import { detachedWindowPlacement, isWindowTearOffPoint } from "./windowTearOff";

describe("window tear-off", () => {
  it("arms at and just inside every workspace edge", () => {
    expect(isWindowTearOffPoint(8, 300, 1000, 700)).toBe(true);
    expect(isWindowTearOffPoint(992, 300, 1000, 700)).toBe(true);
    expect(isWindowTearOffPoint(500, 8, 1000, 700)).toBe(true);
    expect(isWindowTearOffPoint(500, 692, 1000, 700)).toBe(true);
    expect(isWindowTearOffPoint(500, 350, 1000, 700)).toBe(false);
  });

  it("also accepts coordinates reported outside the webview", () => {
    expect(isWindowTearOffPoint(-1, 300, 1000, 700)).toBe(true);
    expect(isWindowTearOffPoint(1001, 300, 1000, 700)).toBe(true);
  });

  it("positions the native window under the grabbed title-bar point", () => {
    expect(
      detachedWindowPlacement({
        screenX: 1800,
        screenY: 240,
        grabOffsetX: 320,
        grabOffsetY: 18,
        width: 720,
        height: 680,
      })
    ).toEqual({ x: 1480, y: 222, width: 720, height: 680 });
  });

  it("preserves negative multi-monitor coordinates and omits invalid sizes", () => {
    expect(
      detachedWindowPlacement({
        screenX: -120,
        screenY: 80,
        grabOffsetX: 40,
        grabOffsetY: 12,
        width: Number.NaN,
        height: 0,
      })
    ).toEqual({ x: -160, y: 68 });
  });
});
