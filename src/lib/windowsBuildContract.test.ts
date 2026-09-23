import { describe, expect, it } from "vitest";
import workflow from "../../.github/workflows/build.yml?raw";
import offlineConfig from "../../src-tauri/tauri.windows.offline.conf.json?raw";
import windowsConfig from "../../src-tauri/tauri.windows.conf.json?raw";
import packageJson from "../../package.json?raw";
import viteConfig from "../../vite.config.ts?raw";

function count(fragment: string): number {
  return workflow.split(fragment).length - 1;
}

describe("Windows GitHub build contract", () => {
  it("keeps the normal installer small and provides an explicit offline build", () => {
    expect(windowsConfig).toContain('"type": "downloadBootstrapper"');
    expect(offlineConfig).toContain('"type": "offlineInstaller"');
    expect(packageJson).toContain("mesa:build:windows:offline");
    expect(packageJson).toContain("tauri.windows.offline.conf.json");
  });

  it("runs the supported action stack on the current Node LTS", () => {
    // One checkout per job: frontend, rust, rust-advisory, desktop. Node is
    // only needed by the two that touch the web build.
    expect(count("actions/checkout@v7")).toBe(4);
    expect(count("actions/setup-node@v6")).toBe(2);
    expect(count("node-version: 24")).toBe(2);
    expect(workflow).toContain("tauri-apps/tauri-action@v1");
    expect(workflow).toContain("actions/upload-artifact@v7");
    expect(workflow).toContain("Swatinem/rust-cache@v2");
  });

  it("runs every verification gate the contract names, not just the build", () => {
    // The project verification contract calls `npm audit` and `cargo test`
    // gates. A workflow that only type-checks and bundles lets a
    // Rust-only regression and a freshly published advisory both reach main.
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm audit --audit-level=moderate");
    expect(workflow).toContain("cargo audit --file src-tauri/Cargo.lock");
    expect(workflow).toContain("cargo test --manifest-path src-tauri/Cargo.toml");
    expect(workflow).toContain(
      "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings",
    );
  });

  it("uses explicit system-webview build targets instead of esnext", () => {
    expect(viteConfig).toContain('target: ["chrome111", "safari16.4"]');
    expect(viteConfig).not.toContain('target: "esnext"');
  });

  it("compiles and tests the Rust Windows and macOS code paths, not only Linux", () => {
    // The PTY resolver's PATHEXT lookup, the Node-shebang launch path and the
    // cmd.exe wrapper fallback are all `#[cfg(target_os = "windows")]`. A
    // Linux-only Rust job never compiles them, so they would reach `main`
    // checked by nothing but the bundling job's link step.
    expect(workflow).toContain("os: [ubuntu-latest, windows-latest, macos-latest]");
    // The bundles must not ship ahead of the tests that gate them.
    expect(workflow).toContain("needs: [frontend, rust, rust-advisory]");
  });

  it("builds and uploads both Windows installer formats", () => {
    expect(workflow).toContain("- os: windows-latest");
    expect(workflow).toContain("name: windows");
    expect(workflow).toContain("runs-on: ${{ matrix.os }}");
    expect(workflow).toContain(
      "matrix.name == 'windows' && '--bundles msi,nsis'",
    );
    expect(workflow).toContain("src-tauri/target/release/bundle/**/*");
  });

  it("is read-only and runs on every push to main", () => {
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("push:\n    branches: [main]");
  });
});
