import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../store";

describe("Steam overlay Shift+Tab shortcut", () => {
  beforeEach(() => {
    useAppStore.setState({
      overlayOpen: false,
      piOverlayOpen: false,
      searchOpen: false,
      searchSeed: "",
      deepResearchSurface: null,
      overlayWindowRequest: null,
    });
  });

  it("accepts successive toggles without a debounce window", () => {
    const toggle = useAppStore.getState().toggleOverlay;

    toggle();
    expect(useAppStore.getState().overlayOpen).toBe(true);

    toggle();
    expect(useAppStore.getState().overlayOpen).toBe(false);
  });

  it("routes search into the overlay window while the overlay is open", () => {
    useAppStore.setState({ overlayOpen: true, searchOpen: true, overlayWindowRequest: null });

    useAppStore.getState().openSearch("epstein");

    const state = useAppStore.getState();
    expect(state.searchSeed).toBe("epstein");
    expect(state.searchOpen).toBe(false);
    expect(state.overlayWindowRequest).toEqual({ id: "search" });
  });

  it("opens the main search modal when the overlay is closed", () => {
    useAppStore.getState().openSearch("vault");

    const state = useAppStore.getState();
    expect(state.searchSeed).toBe("vault");
    expect(state.searchOpen).toBe(true);
    expect(state.overlayWindowRequest).toBeNull();
  });

  it("assigns one explicit presentation owner when the overlay opens Research", () => {
    useAppStore.getState().openDeepResearch(false);
    expect(useAppStore.getState().deepResearchSurface).toBeNull();

    useAppStore.getState().openDeepResearch(true);
    expect(useAppStore.getState().deepResearchSurface).toBe("overlay");

    useAppStore.getState().setDeepResearchSurface("pi-test-host");
    expect(useAppStore.getState().deepResearchSurface).toBe("pi-test-host");
  });
});
