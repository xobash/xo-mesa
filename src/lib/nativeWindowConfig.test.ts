import { describe, expect, it } from "vitest";
import tauriConfig from "../../src-tauri/tauri.conf.json";
import { MESA_WINDOW_BACKGROUND, MESA_WINDOW_CHROME } from "./windowChrome";

describe("native window configuration", () => {
  it("restricts document and frame sources", () => {
    expect(tauriConfig.app.security.csp).toContain("default-src 'self'");
    expect(tauriConfig.app.security.csp).toContain("object-src 'none'");
    expect(tauriConfig.app.security.csp).toContain("frame-ancestors 'none'");
  });

  it("uses the same dark startup color as detached Mesa windows", () => {
    const main = tauriConfig.app.windows.find((window) => window.label === "main");
    const hex = `#${MESA_WINDOW_BACKGROUND.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    expect(main?.theme).toBe("Dark");
    expect(main?.backgroundColor?.toLowerCase()).toBe(hex);
    expect(MESA_WINDOW_CHROME.theme).toBe("dark");
  });
});
