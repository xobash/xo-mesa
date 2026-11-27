import { expect, it } from "vitest";
import type { GraphNode } from "../types";
import { GraphHitIndex, incidentLinkIndices, maxNodeDegree, nearestNodeLinear, nodeDrawScale, nodeRadius, NODE_RADIUS_MAX, NODE_RADIUS_MIN, resolveOverlaps, timelineSortValue } from "./graphGeometry";

/** Radius at size 1 in a graph whose most-linked node has 9 links. */
const radius9 = (n: GraphNode) => nodeRadius(n, 1, 9);

it("separates idle nodes while keeping a pinned node fixed", () => {
  const fixed = { id: "fixed", degree: 0, x: 0, y: 0, fx: 0, fy: 0 } as GraphNode;
  const moving = { id: "moving", degree: 9, x: 0, y: 0 } as GraphNode;
  expect(resolveOverlaps([fixed, moving], radius9, 8, 2)).toBe(true);
  expect([fixed.x, fixed.y]).toEqual([0, 0]);
  expect(Math.hypot(moving.x!, moving.y!)).toBeGreaterThanOrEqual(radius9(fixed) + radius9(moving) + 16 - 1e-9);
  expect(timelineSortValue(moving)).toBe(Infinity);
});

it("sizes nodes in proportion to their links: the most-linked node is the largest", () => {
  const degrees = [0, 1, 2, 3, 6, 15, 40, 99, 250];
  const max = maxNodeDegree(degrees.map((degree) => ({ degree })));
  expect(max).toBe(250);
  const area = (degree: number) => nodeRadius({ degree }, 1, max) ** 2;
  // Every link adds the same area, so area is linear in the link count.
  const perLink = (NODE_RADIUS_MAX ** 2 - NODE_RADIUS_MIN ** 2) / max;
  for (const d of degrees) expect(area(d)).toBeCloseTo(NODE_RADIUS_MIN ** 2 + perLink * d, 9);
  // Strictly larger with each extra link, with no plateau at either end.
  for (let d = 1; d <= max; d++) expect(area(d)).toBeGreaterThan(area(d - 1));
  expect(nodeRadius({ degree: 0 }, 1, max)).toBe(NODE_RADIUS_MIN);
  expect(nodeRadius({ degree: max }, 1, max)).toBe(NODE_RADIUS_MAX);
  // The reference is this graph: in a small vault the most-linked note is just as large.
  expect(nodeRadius({ degree: 3 }, 1, 3)).toBe(NODE_RADIUS_MAX);
  expect(nodeRadius({ degree: 2 }, 1, 3)).toBeLessThan(NODE_RADIUS_MAX);
  // A graph without links draws every node at the minimum; the node-size setting scales every radius.
  expect(nodeRadius({ degree: 0 }, 1, 0)).toBe(NODE_RADIUS_MIN);
  expect(nodeRadius({ degree: 40 }, 2, max)).toBe(2 * nodeRadius({ degree: 40 }, 1, max));
  expect(nodeRadius({ degree: 0 }, 0.5, max)).toBe(4);
  expect(maxNodeDegree([])).toBe(0);
});

it("grows nodes in world units when zoomed out", () => {
  // One device pixel per world unit draws at layout size; a quarter of that doubles it.
  expect(nodeDrawScale(1, 1)).toBe(1);
  expect(nodeDrawScale(0.5, 2)).toBe(1);
  expect(nodeDrawScale(0.25, 1)).toBe(2);
  // A grabbed target follows the drawn size: 40 world units from a degree-0 node misses at layout size, hits when drawn 8x larger.
  const node = { id: "n", degree: 0, x: 0, y: 0 } as GraphNode;
  expect(nearestNodeLinear([node], 40, 0, 1, radius9)).toBeNull();
  expect(nearestNodeLinear([node], 40, 0, 1, radius9, 8)).toBe(node);
  expect(new GraphHitIndex([node], radius9).nearest(40, 0, 1, 8)).toBe(node);
});

it("hit-tests with the grid exactly like the linear scan at every zoom", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const nodes = Array.from({ length: 3000 }, (_, i) => ({ id: `n${i}`, degree: Math.floor(random() * random() * 60), x: random() * 4000 - 2000, y: random() * 3000 - 1500 }) as GraphNode);
  nodes.push({ id: "same-a", degree: 1, x: 10, y: 10 } as GraphNode, { id: "same-b", degree: 1, x: 10, y: 10 } as GraphNode);
  nodes.push({ id: "nan", degree: 0, x: NaN, y: 0 } as GraphNode, { id: "inf", degree: 0, x: Infinity, y: 0 } as GraphNode, { id: "unplaced", degree: 0 } as GraphNode);
  const radius = (n: GraphNode) => nodeRadius(n, 1.5, 60);
  const index = new GraphHitIndex(nodes, radius);
  for (const k of [0.03, 0.2, 1, 4]) {
    for (let q = 0; q < 1500; q++) {
      const target = nodes[Math.floor(random() * 3000)];
      const gx = q % 3 ? target.x! + (random() - 0.5) * 40 / k : random() * 4400 - 2200;
      const gy = q % 3 ? target.y! + (random() - 0.5) * 40 / k : random() * 3400 - 1700;
      expect(index.nearest(gx, gy, k)).toBe(nearestNodeLinear(nodes, gx, gy, k, radius));
      // Zoomed out, nodes draw larger in world units; both paths use the same drawn radius.
      const drawn = nodeDrawScale(k, 2);
      expect(index.nearest(gx, gy, k, drawn)).toBe(nearestNodeLinear(nodes, gx, gy, k, radius, drawn));
    }
  }
  // Coincident nodes: the later one draws on top and wins in both.
  expect(index.nearest(10, 10, 1)?.id).toBe("same-b");
  expect(nearestNodeLinear(nodes, 10, 10, 1, radius)?.id).toBe("same-b");
  expect(index.nearest(1e6, 1e6, 1)).toBeNull();
  // Exhaustive linear-scan comparison: needs more than the default timeout under coverage.
}, 30000);

it("resolves overlaps with numeric grid keys and skips non-finite positions", () => {
  const a = { id: "a", degree: 0, x: 0, y: 0 } as GraphNode;
  const b = { id: "b", degree: 0, x: 1, y: 0 } as GraphNode;
  const lost = { id: "lost", degree: 0, x: NaN, y: 0 } as GraphNode;
  const far = { id: "far", degree: 0, x: Infinity, y: 0 } as GraphNode;
  expect(resolveOverlaps([a, b, lost, far], radius9, 8, 2)).toBe(true);
  expect(Math.abs(b.x! - a.x!)).toBeGreaterThanOrEqual(radius9(a) + radius9(b) + 16 - 1e-9);
  expect(Number.isNaN(lost.x)).toBe(true);
  expect(far.x).toBe(Infinity);
  // Custom phase: coincident nodes separate along the supplied angle.
  const p = { x: 5, y: 5 }, q = { x: 5, y: 5 };
  resolveOverlaps([p, q], () => 2, 1, 1, (n) => (n === p ? 0 : Math.PI));
  expect(p.x).toBeGreaterThan(5);
  expect(p.y).toBeCloseTo(5);
});

it("lists incident links exactly like a full ascending scan", () => {
  let seed = 11;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const ids = Array.from({ length: 40 }, (_, i) => `n${i}`);
  const links = Array.from({ length: 200 }, () => [ids[Math.floor(random() * 40)], ids[Math.floor(random() * 40)]] as const);
  const adjacency = new Map<string, number[]>();
  links.forEach(([s, t], i) => {
    for (const id of [s, t]) adjacency.set(id, [...(adjacency.get(id) ?? []), i]);
  });
  for (const pick of [[], [null, "missing"], ["n1"], ["n1", "n1"], ["n3", null, "n7"], ids.slice(0, 9)]) {
    const want = new Set(pick);
    const scan = links.flatMap(([s, t], i) => (want.has(s) || want.has(t) ? [i] : []));
    expect(incidentLinkIndices(adjacency, pick)).toEqual(scan);
  }
});
