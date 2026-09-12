import { describe, expect, it } from "vitest";
import packageJson from "../../package.json?raw";
import crossPlatformDoc from "../../docs/cross-platform.md?raw";
import nativeAcceptanceDoc from "../../docs/native-acceptance.md?raw";
import templateScript from "../../scripts/native-acceptance-template.mjs?raw";
import checkerScript from "../../scripts/native-acceptance-check.mjs?raw";

const workflows = [
  "One-command setup and rerun",
  "Interrupted setup or upgrade",
  "Edit, rapid tab changes, quit",
  "Drive disconnect and reconnect",
  "Sleep, wake, and network loss",
  "Two-device sync baseline",
  "Two-device sync interruption",
  "Two-device sync conflict review",
  "Window and keyboard interactions",
  "Long session resources",
  "Signing, notarization, and OS prompts",
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
  });
});
