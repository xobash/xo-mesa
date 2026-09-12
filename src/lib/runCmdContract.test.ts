import { describe, expect, it } from "vitest";
import runCmd from "../../run.cmd?raw";
import installPs1 from "../../install.ps1?raw";

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

  it("repairs a Rustup Cargo proxy that has no default toolchain", () => {
    const runnableCheck = runCmd.indexOf("call cargo --version >nul 2>nul");
    const configureDefault = runCmd.indexOf("call rustup default stable-msvc", runnableCheck);
    const verifyAfterConfigure = runCmd.indexOf(
      "call cargo --version >nul 2>nul",
      runnableCheck + 1,
    );
    const rustReady = runCmd.indexOf("ok Rust/Cargo present");

    expect(runnableCheck).toBeGreaterThan(-1);
    expect(configureDefault).toBeGreaterThan(runnableCheck);
    expect(verifyAfterConfigure).toBeGreaterThan(configureDefault);
    expect(rustReady).toBeGreaterThan(verifyAfterConfigure);
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

  it("activates the MSVC environment instead of only finding Visual Studio", () => {
    const activate = runCmd.indexOf("VsDevCmd.bat");
    const compilerCheck = runCmd.indexOf("where cl >nul 2>nul", activate);
    const linkerCheck = runCmd.indexOf("where link >nul 2>nul", compilerCheck);

    expect(activate).toBeGreaterThan(-1);
    expect(runCmd).toContain("-arch=x64 -host_arch=x64");
    expect(compilerCheck).toBeGreaterThan(activate);
    expect(linkerCheck).toBeGreaterThan(compilerCheck);
  });

  it("verifies WebView2 after the install attempt before launching Mesa", () => {
    const probe = runCmd.indexOf(":has_webview2");
    const install = runCmd.indexOf("Microsoft.EdgeWebView2Runtime");
    const verify = runCmd.indexOf("WebView2 Runtime still not found after install");
    const launch = runCmd.indexOf("call npm run mesa");

    expect(probe).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(probe);
    expect(verify).toBeGreaterThan(install);
    expect(launch).toBeGreaterThan(verify);
    expect(runCmd).toContain("msedgewebview2.exe");
  });

  it("uses the documented WebView2 registration before offering a download", () => {
    const probe = runCmd.slice(runCmd.indexOf("\n:has_webview2"));
    expect(probe).toContain("F3017226-FE2A-4295-8BDF-00C3A9A7E4C5");
    expect(probe).toContain('reg query "%%~K" /v pv');
    expect(probe).toContain('not "%%C"=="0.0.0.0"');
  });

  it("parses a registered runtime value without a whitespace-sensitive filter", () => {
    const probe = runCmd.slice(runCmd.indexOf("\n:has_webview2"));
    expect(probe).toContain('for /f "tokens=1,2,*" %%A');
    expect(probe).toContain('if /i "%%A"=="pv"');
    expect(probe).toContain('if /i not "%%C"=="0.0.0.0"');
    expect(probe).not.toContain('findstr /r /c:"[ ]pv[ ]"');
    expect(probe).toContain('for /d %%D');
  });

  it("warns about the 260-character path limit before the Rust build hits it", () => {
    // Cargo/Tauri artifacts nest ~150 characters below the project root, so a
    // long root (a OneDrive-redirected Documents folder reaches it unaided)
    // fails partway through the FIRST Rust build, long after setup looked
    // like it succeeded. The check runs before any install work.
    const check = runCmd.indexOf(":check_long_paths");
    const call = runCmd.indexOf("call :check_long_paths");
    const nodeStep = runCmd.indexOf("where npm >nul 2>nul");
    expect(check).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(nodeStep).toBeGreaterThan(call);

    expect(runCmd).toContain("LongPathsEnabled");
    // Substring test at a fixed offset: non-empty only past 90 characters.
    expect(runCmd).toContain('if "%CD:~90,1%"=="" exit /b 0');
  });

  it("reports the registry fix rather than making it, and never blocks the run", () => {
    // Enabling long paths is a machine-wide, admin-only change. A setup script
    // must not perform it silently, and it must not refuse to run either —
    // most installs are comfortably short.
    // The LABEL, not the `call` site earlier in the file — labels start a line.
    const body = runCmd.slice(runCmd.indexOf("\n:check_long_paths"));
    const section = body.slice(0, body.indexOf("\n:refresh_paths"));
    expect(section.length).toBeGreaterThan(200);
    expect(section).toContain("ADMIN terminal");
    expect(section).not.toMatch(/^\s*reg add/m);
    expect(section).not.toContain("exit /b 1");
  });
});

describe("Windows install.ps1 long-path contract", () => {
  it("clones with long paths enabled for this checkout only", () => {
    // Git enforces the 260-character cap itself unless core.longpaths is on.
    expect(installPs1).toContain('"core.longpaths=true"');
    expect(installPs1).toContain("git @gitLongPaths clone");
    expect(installPs1).toContain("git @gitLongPaths -C $installDir fetch origin main");
    expect(installPs1).toContain("git @gitLongPaths -C $installDir merge --ff-only origin/main");
    // `-c` scopes it to the invocation. An install script has no business
    // editing the user's global Git config.
    expect(installPs1).not.toContain("git config --global");
  });
});
