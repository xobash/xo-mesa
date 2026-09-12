import { describe, expect, it } from "vitest";
import {
  harnessOccluded,
  rectsDiffer,
  rectsOverlap,
  rectUsable,
  roundRect,
} from "./harness";

describe("harness rect helpers (native webview bounds sync)", () => {
  it("rounds DOMRect-style values to integer window coordinates", () => {
    expect(
      roundRect({ left: 10.4, top: 20.6, width: 300.49, height: 199.5 })
    ).toEqual({ x: 10, y: 21, w: 300, h: 200 });
  });

  it("never produces negative sizes (mid-layout rects)", () => {
    expect(roundRect({ left: 0, top: 0, width: -5, height: -1 })).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    });
  });

  it("treats the first measurement as a change", () => {
    expect(rectsDiffer(null, { x: 0, y: 0, w: 100, h: 100 })).toBe(true);
  });

  it("ignores sub-epsilon jitter but reports real movement", () => {
    const a = { x: 100, y: 50, w: 460, h: 620 };
    expect(rectsDiffer(a, { ...a }, 1)).toBe(false);
    expect(rectsDiffer(a, { ...a, x: 100.5 }, 1)).toBe(false);
    expect(rectsDiffer(a, { ...a, x: 101 }, 1)).toBe(true);
    expect(rectsDiffer(a, { ...a, h: 618 }, 1)).toBe(true);
  });

  it("rejects unusable rects (mid-mount, mid-slide-animation)", () => {
    expect(rectUsable({ x: 0, y: 0, w: 0, h: 0 })).toBe(false);
    expect(rectUsable({ x: 0, y: 0, w: 39, h: 400 })).toBe(false);
    expect(rectUsable({ x: 0, y: 0, w: 460, h: 620 })).toBe(true);
  });

  it("detects real overlap but ignores a shared edge and one-pixel jitter", () => {
    const slot = { x: 100, y: 100, w: 400, h: 300 };
    expect(rectsOverlap(slot, { x: 490, y: 120, w: 50, h: 50 })).toBe(true);
    expect(rectsOverlap(slot, { x: 500, y: 120, w: 50, h: 50 })).toBe(false);
    expect(rectsOverlap(slot, { x: 499, y: 120, w: 50, h: 50 })).toBe(false);
  });

  it("occludes for any usable intersecting Mesa surface", () => {
    const slot = { x: 100, y: 100, w: 400, h: 300 };
    expect(
      harnessOccluded(slot, [
        { x: 10, y: 10, w: 50, h: 50 },
        { x: 200, y: 150, w: 180, h: 120 },
      ])
    ).toBe(true);
    expect(
      harnessOccluded(slot, [
        { x: 10, y: 10, w: 50, h: 50 },
        { x: 200, y: 150, w: 0, h: 0 },
      ])
    ).toBe(false);
  });
});
