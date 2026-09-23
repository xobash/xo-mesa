import { beforeEach, describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";
import agentPanelSource from "../components/AgentPanel.tsx?raw";
import overlaySource from "../components/Overlay.tsx?raw";
import storeSource from "../store.ts?raw";
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

  it("keeps Shift+Tab ownership at the app-shell boundary", () => {
    expect(appSource).toContain("getStore().toggleOverlay();");
    expect(appSource).toContain("const onShiftTabKey = (e: KeyboardEvent) => {");
    expect(appSource).toContain('window.addEventListener("keydown", onShiftTabKey, { capture: true });');
    expect(appSource).toContain('window.addEventListener("keyup", onKeyUp, { capture: true });');
    expect(overlaySource).toContain("isPlainShiftTab");
    expect(overlaySource).toContain("trapOverlayFocus");
    expect(overlaySource).toContain("if (isPlainShiftTab(e)) return;");
    expect(overlaySource).not.toContain("toggleOverlay");
    expect(agentPanelSource).toContain("if (event.type === \"keydown\" && isPlainShiftTab(event))");
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

  it("boots Pi inside the overlay when Deep Research starts from an overlay-only surface", () => {
    expect(storeSource).toContain('overlayWindowRequest: { id: "agent" }');
    expect(storeSource).toContain("if (get().overlayOpen)");
  });

  it("allows a longer cold-start window before Deep Research declares Pi dead", () => {
    expect(storeSource).toContain("const DR_PI_STARTUP_WAIT_MS = 15 * 1000;");
    expect(storeSource).toContain("const piStartupDeadline = Date.now() + DR_PI_STARTUP_WAIT_MS;");
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
