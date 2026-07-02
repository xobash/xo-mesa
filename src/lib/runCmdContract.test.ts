import { describe, expect, it } from "vitest";
import runCmd from "../../run.cmd?raw";

describe("Windows run.cmd bootstrap contract", () => {
  it("does not rely on PowerShell execution-policy cmdlets to install Scoop", () => {
    expect(runCmd).toContain(":ensure_scoop");
    expect(runCmd).toContain("powershell -NoProfile -ExecutionPolicy Bypass");
    expect(runCmd).not.toContain("Set-ExecutionPolicy");
    expect(runCmd).not.toContain("Get-ExecutionPolicy");
  });

  it("falls back from Scoop to winget for Rust and stops before launch without Cargo", () => {
    const scoopRust = runCmd.indexOf("Installing Rust via Scoop rustup");
    const wingetRust = runCmd.indexOf("Installing Rust via winget rustup");
    const cargoGuard = runCmd.indexOf("Cargo still not found after Rust install");
    const launch = runCmd.indexOf("call npm run mesa");

    expect(scoopRust).toBeGreaterThan(-1);
    expect(wingetRust).toBeGreaterThan(scoopRust);
    expect(cargoGuard).toBeGreaterThan(wingetRust);
    expect(launch).toBeGreaterThan(cargoGuard);
  });

  it("verifies MSVC build tools before launching the Tauri app", () => {
    const msvcCheck = runCmd.indexOf(":has_msvc_tools");
    const msvcGuard = runCmd.indexOf("Microsoft C++ Build Tools still not found");
    const launch = runCmd.indexOf("call npm run mesa");

    expect(msvcCheck).toBeGreaterThan(-1);
    expect(msvcGuard).toBeGreaterThan(msvcCheck);
    expect(launch).toBeGreaterThan(msvcGuard);
    expect(runCmd).toContain("Microsoft.VisualStudio.Component.VC.Tools.x86.x64");
  });
});
