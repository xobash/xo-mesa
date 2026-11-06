// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { installTabStripWheel, tabStripWheelDelta } from "./tabStripWheel";

const wheel = (init: Partial<WheelEvent>) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, ...init });

describe("tab strip wheel", () => {
  it("maps a vertical mouse wheel to horizontal scrolling in every delta mode", () => {
    expect(tabStripWheelDelta(wheel({ deltaY: 100 }), 600)).toBe(100);
    expect(tabStripWheelDelta(wheel({ deltaY: -3, deltaMode: 1 }), 600)).toBe(-48);
    expect(tabStripWheelDelta(wheel({ deltaY: 1, deltaMode: 2 }), 600)).toBe(600);
  });

  it("leaves trackpad sideways gestures and Ctrl+wheel zoom native", () => {
    expect(tabStripWheelDelta(wheel({ deltaX: 40, deltaY: 10 }), 600)).toBe(0);
    expect(tabStripWheelDelta(wheel({ deltaY: 100, ctrlKey: true }), 600)).toBe(0);
  });

  it("scrolls an overflowing strip and leaves a strip that fits alone", () => {
    const strip = document.createElement("div");
    Object.defineProperty(strip, "clientWidth", { value: 300 });
    let scrollWidth = 900;
    Object.defineProperty(strip, "scrollWidth", { get: () => scrollWidth });
    const remove = installTabStripWheel(strip);
    const turn = () => {
      const event = new WheelEvent("wheel", { deltaY: 120, cancelable: true });
      strip.dispatchEvent(event);
      return event;
    };
    expect(turn().defaultPrevented).toBe(true);
    expect(strip.scrollLeft).toBe(120);
    scrollWidth = 300;
    expect(turn().defaultPrevented).toBe(false);
    remove();
  });
});
