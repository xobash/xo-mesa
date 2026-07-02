import { describe, expect, it } from "vitest";
import { vaultMenuPosition } from "./vaultSwitcher";

describe("vault switcher menu placement", () => {
  it("places the menu under the vault button", () => {
    expect(vaultMenuPosition({ left: 180, bottom: 44 }, 1200)).toEqual({
      left: 180,
      top: 52,
    });
  });

  it("keeps the menu inside the viewport", () => {
    expect(vaultMenuPosition({ left: 1080, bottom: 44 }, 1200)).toEqual({
      left: 872,
      top: 52,
    });
  });

  it("keeps a small left margin on narrow windows", () => {
    expect(vaultMenuPosition({ left: -20, bottom: 44 }, 300)).toEqual({
      left: 8,
      top: 52,
    });
  });
});
