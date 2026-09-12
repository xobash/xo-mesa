import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const graph = readFileSync(resolve(root, "src/components/GraphView.tsx"), "utf8");
const graphLib = readFileSync(resolve(root, "src/lib/graph.ts"), "utf8");
const store = readFileSync(resolve(root, "src/store.ts"), "utf8");
const styles = readFileSync(resolve(root, "src/styles.css"), "utf8");

describe("Obsidian-style graph controls", () => {
  it("keeps the filter, display, and force controls in the graph surface", () => {
    for (const label of [
      "Filters",
      "Tags",
      "Attachments",
      "Existing files only",
      "Orphans",
      "Display",
      "Arrows",
      "Text fade threshold",
      "Node size",
      "Link thickness",
      "Forces",
      "Center force",
      "Repel force",
      "Link force",
      "Link distance",
    ]) {
      expect(graph).toContain(label);
    }
    expect(graph).toContain("onPointerEnter={suppressGraphHover}");
    expect(graph).toContain("onPointerMove={suppressGraphHover}");
    expect(graph).toContain("onPointerLeave={releaseGraphHover}");
    expect(graph).toContain("graphControlsHoverRef.current");
    expect(graph).toContain("Retune the current force graph in place");
    expect(graph).not.toContain("forceConfigSigRef");
    expect(styles).toContain("max-height: calc(100vh - 132px)");
    expect(styles).toContain("overflow-y: auto");
  });

  it("wires timelapse to the existing simulation and persists graph defaults", () => {
    expect(graph).toContain("Start timelapse animation");
    expect(graph).toContain("timelapseRef.current");
    expect(graph).toContain("timelineStartRef");
    expect(graph).toContain("timelineTime");
    expect(graph).toContain("A dedicated playback clock makes the time-based");
    expect(graph).toContain("function advanceTimelapse(now: number): boolean");
    expect(graph).toContain("if (Number.isFinite(next)) onChange(clamp(next, min, max))");
    expect(graph).toContain("publishVisibleGraph([], timelineLinksRef.current, false)");
    expect(graphLib).toContain("createdAt");
    expect(graph).not.toContain("sim.alphaTarget(0.08)");
    for (const key of [
      "graphArrows",
      "graphTextFadeThreshold",
      "graphNodeSize",
      "graphLinkThickness",
      "graphCenterForce",
      "graphRepelForce",
      "graphLinkForce",
      "graphLinkDistance",
    ]) {
      expect(store).toContain(`${key}:`);
    }
  });

  it("uses one uniform drag target so dense hubs do not get a special kick", () => {
    expect(graph).toContain("const target = 0.3;");
    expect(graph).not.toContain("const hubBoost");
  });

  it("keeps hover focus readable while preserving the preview path", () => {
    expect(graph).toContain("const dimK = 1 - 0.38 * focusK;");
    expect(graph).toContain("let nodeAlpha = Math.max(0.52, Math.min(1, twinkle));");
    expect(graph).toContain("<PreviewCard target={{ kind: \"note\", id: hover.id }}");
    expect(graph).toContain("const focusId = focusK > 0.02 && !dragId ? focus.id : null;");
  });
});
