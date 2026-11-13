// @vitest-environment node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "vite";
import indexHtml from "../../index.html?raw";

// A warmup path that no longer exists is skipped without a message, and the
// dev window then waits for every startup module to be transformed again.
describe("dev server warmup", () => {
  it("warms existing files, including the page's entry module", async () => {
    const config = await resolveConfig({ configFile: resolve("vite.config.ts") }, "serve");
    const files = config.server.warmup.clientFiles ?? [];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(existsSync(resolve(config.root, file)), `${file} is missing`).toBe(true);
    }
    const entry = /<script type="module" src="(\/[^"]+)"/.exec(indexHtml)?.[1];
    expect(entry).toBeDefined();
    expect(files).toContain(`.${entry}`);
  });
});
