import { describe, expect, it } from "vitest";
import packageJsonRaw from "../../package.json?raw";
import releaseDoc from "../../docs/release.md?raw";
import auditScript from "../../scripts/public-release-audit.mjs?raw";
import gitignore from "../../.gitignore?raw";
import buildWorkflow from "../../.github/workflows/build.yml?raw";

describe("public release audit contract", () => {
  it("is wired into package scripts and release gates", () => {
    const packageJson = JSON.parse(packageJsonRaw) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["audit:public"]).toBe("node scripts/public-release-audit.mjs");
    expect(releaseDoc).toContain("npm run audit:public");
    expect(buildWorkflow).toContain("npm run audit:public");
  });

  it("blocks private local release payloads", () => {
    const normalizedScript = auditScript.replaceAll("\\", "");

    for (const forbidden of [
      "docs/graph-and-preview-optimizations.md",
      "docs/mesa-hero.png",
      "docs/mesa-overlay.png",
      "AGENTS.md",
      "HANDOFF.md",
      "REQUESTS.local.md",
      "CONTINUE_PROMPT.local.md",
      ".local.md",
      "/Users/ash",
      "/Volumes/ZimaOS-HD",
      "Frontier Vault",
    ]) {
      expect(normalizedScript).toContain(forbidden);
    }

    for (const ignored of [
      "docs/graph-and-preview-optimizations.md",
      "docs/mesa-hero.png",
      "docs/mesa-overlay.png",
      "*.local.md",
      "AGENTS.md",
      "HANDOFF.md",
    ]) {
      expect(gitignore).toContain(ignored);
    }
  });
});
