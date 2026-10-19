import { expect, it } from "vitest";
import type { GraphNode } from "../types";
import { GraphHitIndex, nearestNodeLinear, nodeRadius, resolveOverlaps, timelineSortValue } from "./graphGeometry";

it("separates idle nodes while keeping a pinned node fixed", () => {
  const fixed = { id: "fixed", degree: 0, x: 0, y: 0, fx: 0, fy: 0 } as GraphNode;
  const moving = { id: "moving", degree: 9, x: 0, y: 0 } as GraphNode;
  expect(resolveOverlaps([fixed, moving], nodeRadius, 8, 2)).toBe(true);
  expect([fixed.x, fixed.y]).toEqual([0, 0]);
  expect(Math.hypot(moving.x!, moving.y!)).toBeGreaterThanOrEqual(nodeRadius(fixed) + nodeRadius(moving) + 16);
  expect(timelineSortValue(moving)).toBe(Infinity);
});

it("hit-tests with the grid exactly like the linear scan at every zoom", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const nodes = Array.from({ length: 3000 }, (_, i) => ({ id: `n${i}`, degree: Math.floor(random() * random() * 60), x: random() * 4000 - 2000, y: random() * 3000 - 1500 }) as GraphNode);
  nodes.push({ id: "same-a", degree: 1, x: 10, y: 10 } as GraphNode, { id: "same-b", degree: 1, x: 10, y: 10 } as GraphNode);
  nodes.push({ id: "nan", degree: 0, x: NaN, y: 0 } as GraphNode, { id: "inf", degree: 0, x: Infinity, y: 0 } as GraphNode, { id: "unplaced", degree: 0 } as GraphNode);
  const radius = (n: GraphNode) => nodeRadius(n, 1.5);
  const index = new GraphHitIndex(nodes, radius);
  for (const k of [0.03, 0.2, 1, 4]) {
    for (let q = 0; q < 1500; q++) {
      const target = nodes[Math.floor(random() * 3000)];
      const gx = q % 3 ? target.x! + (random() - 0.5) * 40 / k : random() * 4400 - 2200;
      const gy = q % 3 ? target.y! + (random() - 0.5) * 40 / k : random() * 3400 - 1700;
      expect(index.nearest(gx, gy, k)).toBe(nearestNodeLinear(nodes, gx, gy, k, radius));
    }
  }
  // Coincident nodes: the later one draws on top and wins in both.
  expect(index.nearest(10, 10, 1)?.id).toBe("same-b");
  expect(nearestNodeLinear(nodes, 10, 10, 1, radius)?.id).toBe("same-b");
  expect(index.nearest(1e6, 1e6, 1)).toBeNull();
});

it("resolves overlaps with numeric grid keys and skips non-finite positions", () => {
  const a = { id: "a", degree: 0, x: 0, y: 0 } as GraphNode;
  const b = { id: "b", degree: 0, x: 1, y: 0 } as GraphNode;
  const lost = { id: "lost", degree: 0, x: NaN, y: 0 } as GraphNode;
  const far = { id: "far", degree: 0, x: Infinity, y: 0 } as GraphNode;
  expect(resolveOverlaps([a, b, lost, far], nodeRadius, 8, 2)).toBe(true);
  expect(Math.abs(b.x! - a.x!)).toBeGreaterThanOrEqual(nodeRadius(a) + nodeRadius(b) + 16 - 1e-9);
  expect(Number.isNaN(lost.x)).toBe(true);
  expect(far.x).toBe(Infinity);
  // Custom phase: coincident nodes separate along the supplied angle.
  const p = { x: 5, y: 5 }, q = { x: 5, y: 5 };
  resolveOverlaps([p, q], () => 2, 1, 1, (n) => (n === p ? 0 : Math.PI));
  expect(p.x).toBeGreaterThan(5);
  expect(p.y).toBeCloseTo(5);
});
