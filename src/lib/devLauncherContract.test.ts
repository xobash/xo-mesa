import { describe, expect, it } from "vitest";
import devLauncher from "../../scripts/dev.mjs?raw";

describe("desktop launcher contract", () => {
  it("does not depend on npx or npx.cmd being discoverable on PATH", () => {
    expect(devLauncher).not.toContain('"npx"');
    expect(devLauncher).not.toContain("npx.cmd");
  });

  it("runs the project-local Tauri CLI with the current Node executable", () => {
    expect(devLauncher).toContain('node_modules", "@tauri-apps", "cli", "tauri.js"');
    expect(devLauncher).toContain("spawn(process.execPath");
    expect(devLauncher).toContain("[tauriCli, ...tauriArgs]");
  });

  it("passes a Windows-safe PATH with Node and Cargo bins to Tauri child commands", () => {
    expect(devLauncher).toContain('key.toLowerCase() === "path"');
    expect(devLauncher).toContain("prependPath(dirname(process.execPath))");
    expect(devLauncher).toContain("prependPath(cargoBin)");
    expect(devLauncher).toContain("env.PATH = env[pathKey]");
  });
});
