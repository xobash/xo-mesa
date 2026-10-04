import { describe, expect, it } from "vitest";
import windows from "../../src-tauri/tauri.windows.conf.json";
import offline from "../../src-tauri/tauri.windows.offline.conf.json";
import packageJson from "../../package.json";

describe("Windows installer configuration", () => {
  it("supports both installer formats with the same minimum WebView2 runtime", () => {
    expect(windows.bundle.targets).toEqual(expect.arrayContaining(["msi", "nsis"]));
    expect(windows.bundle.windows.minimumWebview2Version).toBe("111.0.0.0");
    expect(windows.bundle.windows.webviewInstallMode.type).toBe("downloadBootstrapper");
    expect(offline.bundle.windows.webviewInstallMode.type).toBe("offlineInstaller");
    expect(packageJson.scripts["mesa:build:windows:offline"]).toContain("tauri.windows.offline.conf.json");
  });
});
