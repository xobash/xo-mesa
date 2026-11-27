import { expect, it } from "vitest";
import { NODE_RADIUS_MAX, NODE_RADIUS_MIN, nodeRadius } from "../lib/graphGeometry";
import { layoutMiniGraph } from "./MiniGraph";

it("sizes mini-graph nodes by the real graph's rule, relative to the most-linked node shown", () => {
  const degrees = [0, 1, 2, 2, 5, 12, 40];
  const graph = {
    nodes: degrees.map((degree, i) => ({ id: `n${i}`, title: `n${i}`, degree })),
    links: degrees.slice(1).map((_, i) => [i + 1, (i + 2) % degrees.length] as [number, number]),
    active: -1, total: degrees.length, pending: false,
  };
  const r = layoutMiniGraph(graph).map((p) => p.r);
  // One scale maps the real graph's 8..30 onto the mini graph: same proportions.
  const scale = r[6] / NODE_RADIUS_MAX;
  for (let i = 0; i < degrees.length; i++) expect(r[i]).toBeCloseTo(nodeRadius({ degree: degrees[i] }, 1, 40) * scale, 9);
  expect(r[0] / r[6]).toBeCloseTo(NODE_RADIUS_MIN / NODE_RADIUS_MAX, 9);
  // Equal link counts draw equal sizes; the most-linked node is the largest.
  expect(r[2]).toBe(r[3]);
  expect(Math.max(...r)).toBe(r[6]);
  // Area grows linearly with links.
  const area = r.map((x) => x * x);
  expect((area[5] - area[0]) / (area[6] - area[0])).toBeCloseTo(12 / 40, 9);
});
