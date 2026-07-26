import { describe, expect, it } from "vitest";
// The Steam overlay and Pi surfaces are closed in the default workspace. Keep
// their substantial UI trees out of startup, while App-level gates preserve
// their existing store-owned visibility and Overlay's fade-out lifetime.
import app from "../App.tsx?raw";

describe("optional surface lazy-load contract", () => {
  it("App.tsx does not statically import the Pi surface module", () => {
    expect(app).not.toMatch(
      /^import\s+[^;]*from\s+"\.\/components\/AgentPanel";/m
    );
    expect(app).toContain('import("./components/AgentPanel")');
  });

  it("App.tsx does not statically import the Steam overlay", () => {
    expect(app).not.toMatch(
      /^import\s+[^;]*from\s+"\.\/components\/Overlay";/m
    );
    expect(app).toContain('import("./components/Overlay")');
  });

  it("keeps the overlay mounted after first open so close animation survives", () => {
    expect(app).toContain("if (open) setLoaded(true)");
    expect(app).toContain("if (!loaded && !open) return null");
    expect(app).toContain("<LazyOverlay />");
  });

  it("gates both floating Pi windows on their existing store flags", () => {
    expect(app).toContain("if (!agentOpen && !piOverlayOpen) return null");
    expect(app).toContain("agentOpen && <LazyAgentPanel />");
    expect(app).toContain("piOverlayOpen && <LazyAgentOverlay />");
  });

  it("loads closed command, search, and settings modals only on demand", () => {
    for (const component of ["CommandPalette", "SearchPanel", "SettingsModal"]) {
      expect(app).not.toMatch(
        new RegExp(
          `^import\\s+[^;]*from\\s+\"\\\\.\\\\/components\\\\/${component}\";`,
          "m"
        )
      );
      expect(app).toContain(`import("./components/${component}")`);
    }
    expect(app).toContain(
      "if (!paletteOpen && !searchOpen && !settingsOpen) return null"
    );
    expect(app).toContain("paletteOpen && <LazyCommandPalette />");
    expect(app).toContain("searchOpen && <LazySearchPanel />");
    expect(app).toContain("settingsOpen && <LazySettingsModal />");
  });
});
