import type { GraphLink, GraphNode } from "../types";

/**
 * Typed-array link endpoints for the draw loop. Reading `renderX` and
 * `renderRadius` through 92,775 link objects cost 8 to 11 ms a frame in
 * Safari 27.2 (Measured): node objects have several shapes, so every read is
 * a generic property lookup. Node positions are copied once per frame into
 * flat arrays and each link keeps its two node indices, so the per-link work
 * is plain arithmetic, identical to the object version.
 */

export interface LinkIndex {
  nodes: readonly GraphNode[];
  /** Index of `node` in `nodes`, or -1. */
  nodeAt(node: GraphNode): number;
  /** Index into `nodes` of each link's source and target; -1 when not drawn. */
  s: Int32Array;
  t: Int32Array;
  sId: string[];
  tId: string[];
}

const indexes = new WeakMap<readonly GraphLink[], LinkIndex>();

/** The node indices and ids of `links`, built once per link and node array. */
export function linkIndex(links: readonly GraphLink[], nodes: readonly GraphNode[]): LinkIndex {
  const cached = indexes.get(links);
  if (cached && cached.nodes === nodes) return cached;
  const at = new Map<GraphNode, number>();
  for (let i = 0; i < nodes.length; i++) at.set(nodes[i], i);
  const s = new Int32Array(links.length), t = new Int32Array(links.length);
  const sId: string[] = new Array(links.length), tId: string[] = new Array(links.length);
  for (let i = 0; i < links.length; i++) {
    const source = links[i].source as GraphNode, target = links[i].target as GraphNode;
    s[i] = at.get(source) ?? -1;
    t[i] = at.get(target) ?? -1;
    sId[i] = typeof source === "string" ? source : source.id;
    tId[i] = typeof target === "string" ? target : target.id;
  }
  const index = { nodes, s, t, sId, tId, nodeAt: (node: GraphNode) => at.get(node) ?? -1 };
  indexes.set(links, index);
  return index;
}

/** Per-frame node render positions and radii, plus what changed. */
export class NodePositions {
  x = new Float64Array(0);
  y = new Float64Array(0);
  /** Drawn radius (zoom-dependent). */
  r = new Float64Array(0);
  /** Layout radius (zoom-independent), for GPU trimming. */
  base = new Float64Array(0);
  /** Radius pulse phase (`renderPhase`), so the GPU trims at the pulsing radius. */
  phase = new Float64Array(0);
  /** A node other than `still` changed position, layout radius or phase this frame. */
  placesChanged = false;
  private nodes: readonly GraphNode[] | null = null;

  /**
   * Copy render state for this frame. Returns true when the node array is new
   * or any node other than `still` changed position or drawn radius.
   */
  load(nodes: readonly GraphNode[], still: string | null, baseRadius: (n: GraphNode) => number): boolean {
    let moved = nodes !== this.nodes, placed = moved;
    if (this.x.length < nodes.length) {
      const size = nodes.length;
      this.x = new Float64Array(size); this.y = new Float64Array(size); this.r = new Float64Array(size); this.base = new Float64Array(size);
      this.phase = new Float64Array(size);
      moved = placed = true;
    }
    this.nodes = nodes;
    const { x, y, r, base, phase } = this;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const nx = n.renderX ?? n.x ?? 0, ny = n.renderY ?? n.y ?? 0, nr = n.renderRadius ?? 0, nb = baseRadius(n), np = n.renderPhase ?? 0;
      if (n.id !== still) {
        if (!placed && (x[i] !== nx || y[i] !== ny || base[i] !== nb || phase[i] !== np)) placed = true;
        if (!moved && (placed || r[i] !== nr)) moved = true;
      }
      x[i] = nx; y[i] = ny; r[i] = nr; base[i] = nb; phase[i] = np;
    }
    this.placesChanged = placed;
    return moved;
  }
}

/** Living-motion radius pulse rate, radians per second (period ~3.5 s). */
export const PULSE_RATE = 1.8;

/**
 * Pulse angle at `seconds`, reduced to one turn so the GPU's 32-bit `sin`
 * stays exact on a long-running clock. The 2D nodes and the GPU link trim
 * both read this value.
 */
export function pulseAngle(seconds: number): number {
  return (seconds * PULSE_RATE) % (Math.PI * 2);
}

/** Drawn radius under the living-motion pulse; the WebGL link shader computes the same. */
export function pulsedRadius(radius: number, angle: number, phase: number, amp: number): number {
  return radius * (1 + Math.sin(angle + phase) * amp);
}
