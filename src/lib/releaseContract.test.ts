import { describe, expect, it } from "vitest";
import releaseDoc from "../../docs/release.md?raw";
import crossPlatformDoc from "../../docs/cross-platform.md?raw";
import workflow from "../../.github/workflows/build.yml?raw";

describe("release hardening contract", () => {
  it("requires native acceptance and signed desktop artifacts before public release", () => {
    expect(releaseDoc).toContain("completed native acceptance record");
    expect(releaseDoc).toContain("Windows | MSI and NSIS bundles signed with an Authenticode certificate");
    expect(releaseDoc).toContain("macOS | Universal app signed with an Apple Developer ID certificate and notarized");
    expect(releaseDoc).toContain("Unsigned bundles are development artifacts");
    expect(crossPlatformDoc).toContain("See `docs/release.md`");
  });

  it("keeps release credentials out of normal push and pull-request builds", () => {
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(releaseDoc).toContain("Do not commit certificates, keys, provisioning profiles, API keys, or");
    expect(releaseDoc).toContain("Pull requests and ordinary pushes");
    expect(releaseDoc).toMatch(/do not need\s+private credentials/);
  });

  it("keeps Mesa's release process manual and local-first", () => {
    expect(releaseDoc).toMatch(/do not add\s+telemetry/);
    expect(releaseDoc).toContain("background update checks");
    expect(releaseDoc).toContain("Do not ship automatic updates");
    expect(releaseDoc).toContain("manual, user-initiated update instructions");
  });

  it("pins the privacy audit to the public payload and release assets", () => {
    for (const required of [
      "release commit",
      "release notes",
      "uploaded artifacts",
      "No private names, local paths, vault names",
      "No certificates, API keys, sync keys, tokens",
      "*.local.md",
    ]) {
      expect(releaseDoc).toContain(required);
    }
    expect(releaseDoc).toMatch(/public\s+repository refs/);
    expect(releaseDoc).toMatch(/frontend\s+job runs `npm run audit:public`/);
    expect(workflow).toContain("npm run audit:public");
  });
});
