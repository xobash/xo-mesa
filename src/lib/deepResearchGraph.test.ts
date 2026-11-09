import { describe, expect, it } from "vitest";
import { buildResearchGraph } from "./deepResearchGraph";

describe("buildResearchGraph", () => {
  it("does not invent planned or source nodes before real activity exists", () => {
    const graph = buildResearchGraph("How do tides work?", [
      { kind: "status", message: "Waiting for the model", at: 1_000 },
    ]);
    expect(graph.nodes.map((n) => n.kind)).toEqual(["query"]);
    expect(graph.edges).toEqual([]);
  });

  it("builds a chronological graph from announced and observed actions", () => {
    const graph = buildResearchGraph("How do tides work?", [
      { kind: "plan", message: "Cause\nEvidence", at: 1_000 },
      { kind: "subquestion", message: "Researching cause", subQuestion: "What causes tides?", at: 2_000 },
      { kind: "search", message: "Searched for “tide causes”", observed: true, sourceUrl: "https://search.test", at: 3_000 },
      { kind: "source", message: "Opened source", sourceTitle: "NOAA tides", sourceUrl: "https://noaa.test", at: 4_000 },
      { kind: "note", message: "Finished source", sourceUrl: "https://noaa.test", at: 5_000 },
    ]);
    expect(graph.nodes.map((n) => n.kind)).toEqual(["query", "plan", "subquestion", "search", "source", "note"]);
    expect(graph.nodes.find((n) => n.kind === "search")?.observed).toBe(true);
    expect(graph.edges).toHaveLength(5);
    expect(graph.edges[0]).toEqual({ id: "edge-0", source: "query", target: "activity-0" });
  });

  it("keeps complete labels at readable size and spaces same-column nodes apart", () => {
    const longLabel =
      "This complete source description must wrap across every required line without being truncated";
    const graph = buildResearchGraph("Question", [
      { kind: "source", message: "Opened one", sourceTitle: longLabel, at: 1_000 },
      { kind: "source", message: "Opened two", sourceTitle: "Second source", at: 2_000 },
    ]);
    const first = graph.nodes[1];
    const second = graph.nodes[2];
    expect(first.label).toBe(longLabel);
    expect(first.truncated).toBe(true);
    expect(first.lines[first.lines.length - 1]?.endsWith("...")).toBe(true);
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height + 16);
  });

  it("reflows dense activity into bounded circular nodes", () => {
    const graph = buildResearchGraph(
      "Question",
      Array.from({ length: 47 }, (_, i) => ({
        kind: "source" as const,
        message: `Opened source ${i + 1}`,
        sourceTitle: `Source ${i + 1}`,
        at: 1_000 + i,
      })),
      48,
      { width: 640, height: 360 }
    );

    expect(graph.width).toBe(640);
    expect(graph.height).toBe(360);
    expect(graph.nodeWidth).toBeLessThan(130);
    expect(graph.nodes.every((node) => node.radius > 0)).toBe(true);
    expect(
      graph.nodes.every(
        (node) =>
          node.x - node.hoverRadius >= 0 &&
          node.x + node.hoverRadius <= graph.width &&
          node.y - node.hoverRadius >= 0 &&
          node.y + node.hoverRadius <= graph.height
      )
    ).toBe(true);
    expect(new Set(graph.nodes.map((node) => `${node.x}:${node.y}`)).size).toBe(graph.nodes.length);
    expect(graph.nodes.map((node) => node.step)).toEqual(
      Array.from({ length: graph.nodes.length }, (_, i) => i + 1)
    );
    expect(graph.nodes.every((node) => node.lines[0]?.startsWith(`${node.step} `))).toBe(true);

    for (let i = 0; i < graph.nodes.length; i++) {
      for (let j = i + 1; j < graph.nodes.length; j++) {
        const a = graph.nodes[i];
        const b = graph.nodes[j];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(
          a.hoverRadius + b.hoverRadius
        );
      }
    }

    const firstRowY = graph.nodes[0].y;
    const firstRow = graph.nodes.filter((node) => node.y === firstRowY);
    const secondRowY = graph.nodes.find((node) => node.y !== firstRowY)?.y;
    const secondRow = graph.nodes.filter((node) => node.y === secondRowY);
    expect(firstRow.map((node) => node.x)).toEqual(
      [...firstRow].map((node) => node.x).sort((a, b) => a - b)
    );
    expect(secondRow.map((node) => node.x)).toEqual(
      [...secondRow].map((node) => node.x).sort((a, b) => b - a)
    );
  });

  it("recomputes the collision-free chronological grid for the measured graph section", () => {
    const activity = Array.from({ length: 30 }, (_, i) => ({
      kind: (i % 3 === 0 ? "search" : i % 3 === 1 ? "source" : "note") as "search" | "source" | "note",
      message: `Research action ${i + 1}`,
      at: i + 1,
    }));
    const narrow = buildResearchGraph("Question", activity, 48, { width: 320, height: 240 });
    const wide = buildResearchGraph("Question", activity, 48, { width: 900, height: 500 });

    expect(narrow.nodes.map((node) => `${node.x}:${node.y}`)).not.toEqual(
      wide.nodes.map((node) => `${node.x}:${node.y}`)
    );
    expect(Math.max(...wide.nodes.map((node) => node.radius))).toBeGreaterThan(
      Math.max(...narrow.nodes.map((node) => node.radius))
    );
    for (const graph of [narrow, wide]) {
      expect(graph.nodes.every((node) => node.labelMaxWidth <= graph.nodeWidth)).toBe(true);
      expect(graph.nodes.every((node) => node.labelY < graph.height)).toBe(true);
    }
  });

  it("joins canonical source records with activity nodes", () => {
    const graph = buildResearchGraph(
      "Question",
      [{
        kind: "source",
        message: "Opened source",
        sourceTitle: "Observed research page",
        sourceUrl: "https://www.example.com/research/?utm_source=pi",
        at: 1,
      }],
      48,
      { width: 640, height: 360 },
      [{ url: "https://example.com/research?utm_source=mesa", title: "Research page", status: "reading", observed: true }]
    );

    const source = graph.nodes.find((node) => node.sourceUrl === "https://example.com/research");
    expect(graph.nodes.filter((node) => node.kind === "source")).toHaveLength(1);
    expect(source).toMatchObject({
      kind: "source",
      label: "Research page",
      sourceStatus: "reading",
      sourceObserved: true,
    });
  });

  it("condenses a long query node without losing the full text", () => {
    const query =
      "Map every Epstein-Speckel-Seckel source relationship, origin story, contradiction, and confidence caveat across the current vault and external sources";
    const graph = buildResearchGraph(query, []);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].label).toBe(query);
    expect(graph.nodes[0].truncated).toBe(true);
    expect(graph.nodes[0].lines[graph.nodes[0].lines.length - 1]?.endsWith("...")).toBe(true);
  });
});
