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

/** Numeric cell key; layout cells stay far inside ±2^20 for any finite graph. */
function gridKey(cx: number, cy: number): number {
  return (cx + 1048576) * 2097152 + (cy + 1048576);
}

/** Position fields the overlap resolver reads and writes. */
export interface OverlapNode {
  x?: number;
  y?: number;
  fx?: number | null;
}

/**
 * Separate idle layout overlaps with a spatial hash grid. Fixed nodes stay in
 * place but push others. Coincident nodes separate along a stable per-node phase.
 */
export function resolveOverlaps<T extends OverlapNode>(
  nodes: T[],
  radiusOf: (n: T) => number,
  gap: number,
  iterations: number,
  phaseOf: (n: T) => number = (n) => phaseFromId((n as unknown as GraphNode).id)
): boolean {
  let moved = false;
  // Respect the displayed size, including enlarged hubs.
  const maxRadius = nodes.reduce((max, n) => Math.max(max, radiusOf(n)), 0);
  const cell = 2 * maxRadius + 2 * gap + 4;
  for (let iter = 0; iter < iterations; iter++) {
    const grid = new Map<number, T[]>();
    for (const n of nodes) {
      // Non-finite positions cannot be separated and must not share a cell key.
      if (n.x == null || n.y == null || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      const k = gridKey(Math.floor(n.x / cell), Math.floor(n.y / cell));
      const arr = grid.get(k);
      if (arr) arr.push(n);
      else grid.set(k, [n]);
    }
    for (const n of nodes) {
      if (n.x == null || n.y == null || n.fx != null || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      const rn = radiusOf(n) + gap;
      const gx = Math.floor(n.x / cell);
      const gy = Math.floor(n.y / cell);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const arr = grid.get(gridKey(gx + dx, gy + dy));
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
              const a = phaseOf(n) + iter * 1.7;
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

/** Hit radius in world units: the drawn radius plus slack, never under 9 screen px. */
function hitRadius(n: GraphNode, radiusOf: (n: GraphNode) => number, k: number): number {
  return Math.max(radiusOf(n) + 6, 9 / k);
}

/**
 * Nearest node whose hit circle contains the world point, scanning every node.
 * Ties go to the later node, which draws on top.
 */
export function nearestNodeLinear(
  nodes: readonly GraphNode[],
  gx: number,
  gy: number,
  k: number,
  radiusOf: (n: GraphNode) => number
): GraphNode | null {
  let nearest: GraphNode | null = null;
  let nearestDistance = Infinity;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.x == null || n.y == null) continue;
    const r = hitRadius(n, radiusOf, k);
    const dx = gx - n.x;
    const dy = gy - n.y;
    const distance = dx * dx + dy * dy;
    if (distance <= r * r && distance < nearestDistance) {
      nearest = n;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * Uniform grid over layout positions for hover and click hit-tests. Build it
 * from frozen layout x/y; render offsets never move hit targets. Results match
 * `nearestNodeLinear` for the positions captured at construction.
 */
export class GraphHitIndex {
  readonly nodes: readonly GraphNode[];
  private readonly cell: number;
  private readonly maxRadius: number;
  private readonly cells = new Map<number, number[]>();
  private readonly radiusOf: (n: GraphNode) => number;

  constructor(nodes: readonly GraphNode[], radiusOf: (n: GraphNode) => number) {
    this.nodes = nodes;
    this.radiusOf = radiusOf;
    let maxRadius = 0;
    for (const n of nodes) maxRadius = Math.max(maxRadius, radiusOf(n));
    this.maxRadius = maxRadius;
    this.cell = Math.max(16, 2 * (maxRadius + 6));
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.x == null || n.y == null || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      const key = gridKey(Math.floor(n.x / this.cell), Math.floor(n.y / this.cell));
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(i);
      else this.cells.set(key, [i]);
    }
  }

  nearest(gx: number, gy: number, k: number): GraphNode | null {
    const reach = Math.max(this.maxRadius + 6, 9 / k);
    const x0 = Math.floor((gx - reach) / this.cell), x1 = Math.floor((gx + reach) / this.cell);
    const y0 = Math.floor((gy - reach) / this.cell), y1 = Math.floor((gy + reach) / this.cell);
    // A far-zoom query spanning more cells than there are nodes is cheaper as a scan.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.nodes.length) return nearestNodeLinear(this.nodes, gx, gy, k, this.radiusOf);
    let best = -1;
    let bestDistance = Infinity;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = this.cells.get(gridKey(cx, cy));
        if (!bucket) continue;
        for (const i of bucket) {
          const n = this.nodes[i];
          const r = hitRadius(n, this.radiusOf, k);
          const dx = gx - n.x!;
          const dy = gy - n.y!;
          const distance = dx * dx + dy * dy;
          if (distance <= r * r && (distance < bestDistance || (distance === bestDistance && i > best))) {
            best = i;
            bestDistance = distance;
          }
        }
      }
    }
    return best < 0 ? null : this.nodes[best];
  }
}
