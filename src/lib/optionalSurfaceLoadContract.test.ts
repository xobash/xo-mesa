import { describe, expect, it } from "vitest";
// The Steam overlay and Pi surfaces are closed in the default workspace. Keep
// their substantial UI trees out of startup, while App-level gates preserve
// their existing store-owned visibility and Overlay's fade-out lifetime.
import app from "../App.tsx?raw";
import mediaView from "../components/MediaView.tsx?raw";

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

  it("keeps the heavy Deep Research panel out of App startup", () => {
    expect(app).not.toMatch(
      /^import\s+[^;]*from\s+"\.\/components\/DeepResearchPanel";/m
    );
    expect(app).toContain('import("./components/DeepResearchPanel")');
    expect(app).toContain('from "./components/DeepResearchPhaseChip"');
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

  it("loads the connect-vault modal only when the welcome screen opens it", () => {
    // It only ever mounted behind `connectOpen`, so it does no work while
    // closed — the property that makes the lazy boundary behavior-identical.
    expect(app).not.toMatch(
      /^import\s+[^;]*from\s+"\.\/components\/ConnectVaultModal";/m
    );
    expect(app).toContain('import("./components/ConnectVaultModal")');
    expect(app).toContain("connectOpen && (");
    expect(app).toContain("<LazyConnectVaultModal onClose=");
  });

  it("loads closed command, search, sync, diagnostics, and settings modals only on demand", () => {
    for (const component of ["CommandPalette", "SearchPanel", "SettingsModal", "DiagnosticsModal", "SyncModal"]) {
      expect(app).not.toMatch(
        new RegExp(
          `^import\\s+[^;]*from\\s+\"\\\\.\\\\/components\\\\/${component}\";`,
          "m"
        )
      );
      expect(app).toContain(`import("./components/${component}")`);
    }
    expect(app).toContain(
      "if (!paletteOpen && !searchOpen && !settingsOpen && !diagnosticsOpen && !syncOpen) return null"
    );
    expect(app).toContain("paletteOpen && <LazyCommandPalette />");
    expect(app).toContain("searchOpen && <LazySearchPanel />");
    expect(app).toContain("syncOpen && <LazySyncModal />");
    expect(app).toContain("diagnosticsOpen && <LazyDiagnosticsModal />");
    expect(app).toContain("settingsOpen && <LazySettingsModal />");
  });

  it("does not pre-warm the PDF engine from the default media viewer module", () => {
    expect(mediaView).not.toContain("warmPdfEngine");
    expect(mediaView).not.toContain("requestIdleCallback");
    expect(mediaView).not.toContain("setTimeout(prefetch");
    expect(mediaView).toContain('import("./PdfView")');
  });
});
