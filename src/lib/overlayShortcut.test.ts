import { beforeEach, describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";
import overlaySource from "../components/Overlay.tsx?raw";
import { useAppStore } from "../store";

describe("Steam overlay Shift+Tab shortcut", () => {
  beforeEach(() => {
    useAppStore.setState({ overlayOpen: false, piOverlayOpen: false });
  });

  it("accepts successive toggles without a debounce window", () => {
    const toggle = useAppStore.getState().toggleOverlay;

    toggle();
    expect(useAppStore.getState().overlayOpen).toBe(true);

    toggle();
    expect(useAppStore.getState().overlayOpen).toBe(false);
  });

  it("keeps Shift+Tab ownership at the app-shell boundary", () => {
    expect(appSource).toContain("getStore().toggleOverlay();");
    expect(overlaySource).not.toContain("isPlainShiftTab");
    expect(overlaySource).not.toContain("toggleOverlay");
  });
});
