import { describe, expect, it } from "vitest";
import defaultCapability from "../../src-tauri/capabilities/default.json";
import browserCapability from "../../src-tauri/capabilities/browser.json";
import tauriConfig from "../../src-tauri/tauri.conf.json";

describe("native filesystem and remote-browser scopes", () => {
  it("starts filesystem and asset access empty", () => {
    const fsScope = defaultCapability.permissions.find(
      (permission) => typeof permission === "object" && permission.identifier === "fs:scope",
    );
    expect(fsScope).toEqual({ identifier: "fs:scope", allow: [] });
    expect(tauriConfig.app.security.assetProtocol).toEqual({ enable: true, scope: [] });
  });

  it("keeps remote browser webviews out of the trusted capability", () => {
    expect(defaultCapability.windows).not.toContain("browser-*");
    expect(browserCapability.windows).toEqual(["browser-*"]);
    expect(browserCapability.permissions.some((permission) => String(permission).startsWith("fs:"))).toBe(false);
    expect(browserCapability.permissions.some((permission) => String(permission).startsWith("dialog:"))).toBe(false);
  });
});
