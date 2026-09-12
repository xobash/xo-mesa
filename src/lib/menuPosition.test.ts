import { describe, expect, it } from "vitest";
import { clampFloatingMenuPosition } from "./menuPosition";

describe("floating menu placement", () => {
  it("keeps a menu at the requested point when it fits", () => {
    expect(
      clampFloatingMenuPosition(
        { x: 120, y: 180 },
        { width: 900, height: 700 },
        { width: 180, height: 120 }
      )
    ).toEqual({ left: 120, top: 180 });
  });

  it("clamps the menu above the bottom edge of the viewport", () => {
    expect(
      clampFloatingMenuPosition(
        { x: 120, y: 660 },
        { width: 900, height: 700 },
        { width: 180, height: 120 }
      )
    ).toEqual({ left: 120, top: 572 });
  });

  it("clamps the menu away from the right edge of the viewport", () => {
    expect(
      clampFloatingMenuPosition(
        { x: 860, y: 180 },
        { width: 900, height: 700 },
        { width: 184, height: 120 }
      )
    ).toEqual({ left: 708, top: 180 });
  });

  it("keeps oversized menus anchored at the viewport margin", () => {
    expect(
      clampFloatingMenuPosition(
        { x: -50, y: -20 },
        { width: 120, height: 80 },
        { width: 220, height: 180 }
      )
    ).toEqual({ left: 8, top: 8 });
  });
});
