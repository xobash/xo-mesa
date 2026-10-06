import type { GraphNode } from "../types";

export function phaseFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 0xffffffff) * Math.PI * 2;
}

// Node size scales with the number of links (in + out), mirroring Obsidian:
// "the more nodes that reference it, the bigger it gets". sqrt keeps hubs
// prominent without exploding, and degree-0 notes stay small dots.
export function nodeRadius(n: GraphNode, size = 1): number {
  return Math.min(24 * size, (2.4 + 1.75 * Math.sqrt(n.degree)) * size);
}

export function graphLinkNodeId(node: string | GraphNode): string {
  return typeof node === "string" ? node : node.id;
}

export function timelineSortValue(n: GraphNode): number {
  return Number.isFinite(n.timelineTime) ? n.timelineTime! : Number.POSITIVE_INFINITY;
}

/** Separate idle layout overlaps with a spatial hash grid. Fixed nodes stay in place but push others. */
export function resolveOverlaps(
  nodes: GraphNode[],
  radiusOf: (n: GraphNode) => number,
  gap: number,
  iterations: number
): boolean {
  let moved = false;
  // Respect the displayed size, including enlarged hubs.
  const maxRadius = nodes.reduce((max, n) => Math.max(max, radiusOf(n)), 0);
  const cell = 2 * maxRadius + 2 * gap + 4;
  for (let iter = 0; iter < iterations; iter++) {
    const grid = new Map<string, GraphNode[]>();
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      const k = Math.floor(n.x / cell) + "," + Math.floor(n.y / cell);
      const arr = grid.get(k);
      if (arr) arr.push(n);
      else grid.set(k, [n]);
    }
    for (const n of nodes) {
      if (n.x == null || n.y == null || n.fx != null) continue;
      const rn = radiusOf(n) + gap;
      const gx = Math.floor(n.x / cell);
      const gy = Math.floor(n.y / cell);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const arr = grid.get(gx + dx + "," + (gy + dy));
          if (!arr) continue;
          for (const m of arr) {
            if (m === n || m.x == null || m.y == null) continue;
            const min = rn + radiusOf(m) + gap;
            let ddx: number = n.x - m.x;
            let ddy: number = n.y - m.y;
            let d2: number = ddx * ddx + ddy * ddy;
            if (d2 >= min * min) continue;
            let d: number = Math.sqrt(d2);
            if (d < 1e-6) {
              const a = phaseFromId(n.id) + iter * 1.7;
              ddx = Math.cos(a);
              ddy = Math.sin(a);
              d = 1;
              d2 = 1;
            }
            const overlap = min - d;
            if (overlap < 0.01) continue; // skip sub-pixel jitter
            // Fixed nodes (m.fx != null) don't move, so n takes the full push.
            const nShare = m.fx != null ? 1 : 0.5;
            const ux: number = ddx / d;
            const uy: number = ddy / d;
            n.x = n.x + ux * overlap * nShare;
            n.y = n.y + uy * overlap * nShare;
            if (m.fx == null) {
              m.x = m.x - ux * overlap * (1 - nShare);
              m.y = m.y - uy * overlap * (1 - nShare);
            }
            moved = true;
          }
        }
      }
    }
  }
  return moved;
}
