import { describe, expect, it } from "vitest";
import { rectsDiffer, rectUsable, roundRect } from "./harness";

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
});
