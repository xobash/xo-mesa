import { describe, expect, it } from "vitest";
// GraphView owns the canvas render loop and is the only production consumer of
// d3-force. The default workspace is Editor + Preview, so App.tsx loads Graph
// on demand instead of making every main/popout startup parse it.
import app from "../App.tsx?raw";

const allSources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("graph lazy-load contract", () => {
  it("App.tsx does not statically import GraphView", () => {
    expect(app).not.toMatch(
      /^import\s+[^;]*from\s+"\.\/components\/GraphView";/m
    );
  });

  it("App.tsx loads GraphView dynamically", () => {
    expect(app).toContain('import("./components/GraphView")');
  });

  it("only GraphView.tsx statically imports d3-force", () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(allSources)) {
      if (file.includes(".test.")) continue;
      if (file.endsWith("components/GraphView.tsx")) continue;
      for (const line of text.split("\n")) {
        if (/^\s*import\s+type\b/.test(line)) continue;
        if (/^\s*import\s+[^("']*["']d3-force["']/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
