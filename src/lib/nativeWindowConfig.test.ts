import { describe, expect, it } from "vitest";
import tauriConfig from "../../src-tauri/tauri.conf.json";
import defaultCapability from "../../src-tauri/capabilities/default.json";
import piCapability from "../../src-tauri/capabilities/pi.json";
import workspaceCapability from "../../src-tauri/capabilities/workspace.json";
import { MESA_WINDOW_BACKGROUND, MESA_WINDOW_CHROME } from "./windowChrome";

describe("native window configuration", () => {
  it("allows guarded native close and document title updates", () => {
    expect(defaultCapability.windows).toContain("doc-*");
    expect(defaultCapability.permissions).toEqual(expect.arrayContaining([
      "core:window:allow-close",
      "core:window:allow-destroy",
      "core:window:allow-set-title",
    ]));
  });

  it("restricts document and frame sources", () => {
    expect(tauriConfig.app.security.csp).toContain("default-src 'self'");
    expect(tauriConfig.app.security.csp).toContain("object-src 'none'");
    expect(tauriConfig.app.security.csp).toContain("frame-ancestors 'none'");
  });

  it("gives the privileged app origin no inline-script or remote-connect allowance", () => {
    const directives = Object.fromEntries(
      tauriConfig.app.security.csp.split(";").map((part) => {
        const [name, ...values] = part.trim().split(/\s+/);
        return [name, values];
      })
    );
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
    expect(directives["script-src"]).not.toContain("'unsafe-eval'");
    expect(directives["script-src"]).not.toContain("https:");
    expect(directives["connect-src"]).not.toContain("https:");
    expect(directives["connect-src"]).not.toContain("http:");
    expect(directives["connect-src"]).not.toContain("*");
  });

  it("targets only Mesa's own windows; no capability names a child webview", () => {
    const labels = [defaultCapability, piCapability, workspaceCapability].flatMap((capability) => capability.windows);
    expect(labels.every((label) => /^(main|doc-\*|panel-\*|agent-\*)$/.test(label))).toBe(true);
    expect(JSON.stringify([defaultCapability, piCapability, workspaceCapability])).not.toContain("harness");
    for (const capability of [defaultCapability, piCapability, workspaceCapability]) {
      expect(capability).not.toHaveProperty("webviews");
      expect("remote" in capability).toBe(false);
    }
  });

  it("uses the same dark startup color as detached Mesa windows", () => {
    const main = tauriConfig.app.windows.find((window) => window.label === "main");
    const hex = `#${MESA_WINDOW_BACKGROUND.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    expect(main?.theme).toBe("Dark");
    expect(main?.backgroundColor?.toLowerCase()).toBe(hex);
    expect(MESA_WINDOW_CHROME.theme).toBe("dark");
  });
});
