import { describe, expect, it } from "vitest";
import packageJson from "../../package.json?raw";
import crossPlatformDoc from "../../docs/cross-platform.md?raw";
import nativeAcceptanceDoc from "../../docs/native-acceptance.md?raw";
import templateScript from "../../scripts/native-acceptance-template.mjs?raw";
import checkerScript from "../../scripts/native-acceptance-check.mjs?raw";
import viteConfig from "../../vite.config.ts?raw";
import buildWorkflow from "../../.github/workflows/build.yml?raw";

const workflows = [
  "One-command setup and rerun",
  "Interrupted setup or upgrade",
  "Edit, rapid tab changes, quit",
  "Drive disconnect and reconnect",
  "Sleep, wake, and network loss",
  "Two-device sync baseline",
  "Offline third-device sync",
  "Two-device sync interruption",
  "Sync simultaneous edits",
  "Sync delete, restore, and rename",
  "Sync certificate change",
  "Interrupted sync journal",
  "Window and keyboard interactions",
  "Assistive technology and scaling",
  "Interruption and return flows",
  "Long session resources",
  "Signing, notarization, and OS prompts",
];

const inventoryItems = [
  "Baseline pair and bidirectional transfer",
  "Offline third-device convergence",
  "Simultaneous text edit conflict",
  "Delete and restore",
  "Rename plus edit",
  "Peer certificate change",
  "Interrupted journal or app kill",
  "Retry evidence and final status",
  "Save/history visible beside the document",
  "Delete/recovery visible beside deletion",
  "Save/sync problem stayed visible until resolved",
  "Keyboard-only path",
  "VoiceOver/Narrator path",
  "High-DPI/small-display path",
  "Modal interruption and return",
];

const matrixTargets = [
  "Windows 11 current WebView2",
  "Windows 10 oldest WebView2",
  "macOS current WKWebView",
  "macOS 13.3 oldest WKWebView",
  "Linux current WebKitGTK smoke",
];

describe("native acceptance contract", () => {
  it("keeps the native acceptance template exposed as an npm command", () => {
    expect(packageJson).toContain('"acceptance:native-template"');
    expect(packageJson).toContain('"acceptance:native-check"');
    expect(packageJson).toContain("scripts/native-acceptance-template.mjs");
    expect(packageJson).toContain("scripts/native-acceptance-check.mjs");
    expect(crossPlatformDoc).toContain("npm run acceptance:native-template > native-acceptance.local.md");
    expect(crossPlatformDoc).toContain("npm run acceptance:native-check -- native-acceptance.local.md");
    expect(nativeAcceptanceDoc).toContain("npm run acceptance:native-template > native-acceptance.local.md");
    expect(nativeAcceptanceDoc).toContain("npm run acceptance:native-check -- native-acceptance.local.md");
  });

  it("keeps native acceptance distinct from browser and CI evidence", () => {
    for (const source of [crossPlatformDoc, nativeAcceptanceDoc, templateScript, checkerScript]) {
      expect(source).toContain("native");
    }
    expect(nativeAcceptanceDoc).toContain("GitHub Actions builds or uploaded bundles");
    expect(nativeAcceptanceDoc).toContain("Unit, source-contract, browser-demo, or Node tests");
    expect(crossPlatformDoc).toContain("Do not mark a row passed from a source assertion, browser fixture or another OS's");
    expect(templateScript).toContain("Browser fixtures, CI builds");
    expect(checkerScript).toContain("pass cites non-native evidence");
  });

  it("keeps every required workflow in the docs and generated template", () => {
    for (const workflow of workflows) {
      expect(nativeAcceptanceDoc).toContain(workflow);
      expect(templateScript).toContain(workflow);
      expect(checkerScript).toContain(workflow);
    }
    expect(nativeAcceptanceDoc).toContain("process-tree memory");
    expect(templateScript).toContain("Process-tree memory");
    expect(templateScript).toContain("Resource trend");
    expect(templateScript).toContain("Sync transport tested");
    expect(templateScript).toContain("Disk-full method");
    expect(templateScript).toContain("Third device, if offline sync is tested");
    expect(templateScript).toContain("Certificate-change method");
    expect(templateScript).toContain("Assistive technology used");
  });

  it("requires concrete messy-use and accessibility inventory evidence", () => {
    for (const item of inventoryItems) {
      expect(nativeAcceptanceDoc).toContain(item);
      expect(templateScript).toContain(item);
      expect(checkerScript).toContain(item);
    }
    expect(checkerScript).toContain("pass must name concrete native evidence");
    expect(checkerScript).toContain("tests passed");
    expect(checkerScript).toContain("vitest");
  });

  it("keeps the supported native matrix explicit and checked", () => {
    for (const target of matrixTargets) {
      expect(crossPlatformDoc).toContain(target);
      expect(nativeAcceptanceDoc).toContain(target);
      expect(templateScript).toContain(target);
      expect(checkerScript).toContain(target);
    }
    expect(nativeAcceptanceDoc).toContain("native acceptance matrix");
    expect(templateScript).toContain("Matrix target:");
    expect(checkerScript).toContain('"Matrix target"');
    expect(checkerScript).toContain("must be one of");
  });

  it("keeps build targets and CI aligned with the supported matrix", () => {
    expect(viteConfig).toContain('target: ["chrome111", "safari16.4"]');
    expect(crossPlatformDoc).toContain("Chrome/WebView2 111 or newer");
    expect(crossPlatformDoc).toContain("Safari/WKWebView 16.4 or newer");
    expect(buildWorkflow).toContain("windows-latest");
    expect(buildWorkflow).toContain("macos-latest");
    expect(buildWorkflow).toContain("ubuntu-latest");
    expect(buildWorkflow).toContain("cargo audit --file src-tauri/Cargo.lock");
  });
});
