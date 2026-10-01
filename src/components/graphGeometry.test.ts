import { expect, it } from "vitest";
import type { GraphNode } from "../types";
import { nodeRadius, resolveOverlaps, timelineSortValue } from "./graphGeometry";

it("separates idle nodes while keeping a pinned node fixed", () => {
  const fixed = { id: "fixed", degree: 0, x: 0, y: 0, fx: 0, fy: 0 } as GraphNode;
  const moving = { id: "moving", degree: 9, x: 0, y: 0 } as GraphNode;
  expect(resolveOverlaps([fixed, moving], nodeRadius, 8, 2)).toBe(true);
  expect([fixed.x, fixed.y]).toEqual([0, 0]);
  expect(Math.hypot(moving.x!, moving.y!)).toBeGreaterThanOrEqual(nodeRadius(fixed) + nodeRadius(moving) + 16);
  expect(timelineSortValue(moving)).toBe(Infinity);
});
