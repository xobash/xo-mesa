import { describe, expect, it } from "vitest";
import type { VaultFile } from "../types";
import {
  loadStartupTextCache,
  STARTUP_TEXT_READ_CONCURRENCY,
} from "./startupTextCache";

const files = Array.from({ length: 100 }, (_, index): VaultFile => ({
  path: `/vault/${index}.md`,
  relPath: `${index}.md`,
  name: String(index),
  ext: "md",
  isMarkdown: true,
}));

describe("loadStartupTextCache", () => {
  it("bounds in-flight reads while retaining every result", async () => {
    let active = 0;
    let peak = 0;
    const result = await loadStartupTextCache(files, async (file) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return `content:${file.relPath}`;
    });
    expect(peak).toBe(STARTUP_TEXT_READ_CONCURRENCY);
    expect(result.size).toBe(files.length);
    expect(result.get("99.md")).toBe("content:99.md");
  });

  it("supports a narrower injected limit for constrained environments", async () => {
    let active = 0;
    let peak = 0;
    await loadStartupTextCache(
      files.slice(0, 8),
      async () => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return "";
      },
      3
    );
    expect(peak).toBe(3);
  });

  it("abandons unread files when a vault-open generation is superseded", async () => {
    let stopped = false;
    const seen: string[] = [];
    const result = await loadStartupTextCache(
      files.slice(0, 8),
      async (file) => {
        seen.push(file.relPath);
        if (file.relPath === "2.md") stopped = true;
        return `content:${file.relPath}`;
      },
      1,
      (text) => text,
      () => stopped
    );
    expect(seen).toEqual(["0.md", "1.md", "2.md"]);
    expect(result.size).toBe(3);
  });
});
