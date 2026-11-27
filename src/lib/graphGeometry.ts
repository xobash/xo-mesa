import type { GraphNode } from "../types";

export function phaseFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 0xffffffff) * Math.PI * 2;
}

/** Radius bounds in world units at node size 1: a node with no links, and the most-linked node. */
export const NODE_RADIUS_MIN = 8;
export const NODE_RADIUS_MAX = 30;

/**
 * Node radius in world units. Area grows linearly with the link count
 * (in + out) relative to the most-linked node in the graph: every link adds
 * the same area, equal counts draw equal sizes, and the most-linked node is
 * the largest (`NODE_RADIUS_MAX`). A node with no links, or any node in a
 * graph without links, is `NODE_RADIUS_MIN`. The maximum stays inside the
 * fixed 60-unit collision, so default sizes never overlap. Layout, collision
 * and bounds use this zoom-independent value.
 */
export function nodeRadius(n: Pick<GraphNode, "degree">, size: number, maxDegree: number): number {
  const share = maxDegree > 0 && n.degree > 0 ? Math.min(1, n.degree / maxDegree) : 0;
  const min2 = NODE_RADIUS_MIN * NODE_RADIUS_MIN;
  return size * Math.sqrt(min2 + (NODE_RADIUS_MAX * NODE_RADIUS_MAX - min2) * share);
}

/** Largest link count among `nodes`, the reference for `nodeRadius`. */
export function maxNodeDegree(nodes: readonly Pick<GraphNode, "degree">[]): number {
  let max = 0;
  for (const n of nodes) if (n.degree > max) max = n.degree;
  return max;
}

/**
 * Draw-size factor for nodes and labels at a zoom level. Nodes grow in world
 * units as the view zooms out (sqrt(1 / scale)), so they shrink on screen
 * more slowly than the layout. `k` is CSS px per world unit; the scale is
 * measured in device px, as Obsidian measures it.
 */
export function nodeDrawScale(k: number, dpr: number): number {
  return 1 / Math.sqrt(Math.max(1e-6, k * dpr));
}

export function graphLinkNodeId(node: string | GraphNode): string {
  return typeof node === "string" ? node : node.id;
}

/**
 * Ascending, de-duplicated link indices incident to any of `ids`, so a frame
 * can draw only the highlighted links, in the same order as a full scan.
 */
export function incidentLinkIndices(
  adjacency: ReadonlyMap<string, readonly number[]>,
  ids: Iterable<string | null>
): number[] {
  const out: number[] = [];
  for (const id of ids) {
    const indices = id == null ? undefined : adjacency.get(id);
    if (indices) for (const i of indices) out.push(i);
  }
  out.sort((a, b) => a - b);
  let w = 0;
  for (let i = 0; i < out.length; i++) if (i === 0 || out[i] !== out[i - 1]) out[w++] = out[i];
  out.length = w;
  return out;
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

/** World slack around a drawn node before the pointer leaves it. */
const HIT_SLACK = 2;

/** Hit radius in world units: the drawn radius plus slack, never under 9 screen px. */
function hitRadius(n: GraphNode, radiusOf: (n: GraphNode) => number, k: number, drawScale: number): number {
  return Math.max(radiusOf(n) * drawScale + HIT_SLACK, 9 / k);
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
  radiusOf: (n: GraphNode) => number,
  drawScale = 1
): GraphNode | null {
  let nearest: GraphNode | null = null;
  let nearestDistance = Infinity;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.x == null || n.y == null) continue;
    const r = hitRadius(n, radiusOf, k, drawScale);
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
 * from frozen layout x/y; render offsets never move hit targets. `radiusOf`
 * is the zoom-independent world radius; each query passes the current draw
 * scale. Results match `nearestNodeLinear` for the positions captured at
 * construction.
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
    this.cell = Math.max(16, 2 * (maxRadius + HIT_SLACK));
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.x == null || n.y == null || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      const key = gridKey(Math.floor(n.x / this.cell), Math.floor(n.y / this.cell));
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(i);
      else this.cells.set(key, [i]);
    }
  }

  nearest(gx: number, gy: number, k: number, drawScale = 1): GraphNode | null {
    const reach = Math.max(this.maxRadius * drawScale + HIT_SLACK, 9 / k);
    const x0 = Math.floor((gx - reach) / this.cell), x1 = Math.floor((gx + reach) / this.cell);
    const y0 = Math.floor((gy - reach) / this.cell), y1 = Math.floor((gy + reach) / this.cell);
    // A far-zoom query spanning more cells than there are nodes is cheaper as a scan.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.nodes.length) return nearestNodeLinear(this.nodes, gx, gy, k, this.radiusOf, drawScale);
    let best = -1;
    let bestDistance = Infinity;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = this.cells.get(gridKey(cx, cy));
        if (!bucket) continue;
        for (const i of bucket) {
          const n = this.nodes[i];
          const r = hitRadius(n, this.radiusOf, k, drawScale);
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

export function rectContains(
  r: { x: number; y: number; w: number; h: number },
  x: number,
  y: number
): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export function rectLinePenalty(
  r: { x: number; y: number; w: number; h: number },
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const steps = 12;
  let hits = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (rectContains(r, ax + (bx - ax) * t, ay + (by - ay) * t)) hits++;
  }
  return hits;
}
