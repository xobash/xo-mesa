import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type ForceCenter,
  type ForceCollide,
  type ForceLink,
  type ForceManyBody,
  type ForceX,
  type ForceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { resolveOverlaps } from "../components/graphGeometry";

/** Size-tiered force constants shared by GraphView's open, retune and benchmark paths. */
export function graphSimulationTier(count: number) {
  const big = count > 300;
  const huge = count > 800;
  return {
    big,
    huge,
    chargeScale: huge ? -12 : big ? -18 : -24,
    chargeDistanceMax: huge ? 1400 : big ? 1100 : 900,
    theta: huge ? 0.95 : 0.9,
    warmTicks: huge ? 42 : big ? 56 : 78,
    collideIterations: big ? 3 : 4,
    velocityDecay: huge ? 0.42 : big ? 0.4 : 0.38,
    alphaDecay: huge ? 0.06 : big ? 0.04 : 0.028,
    /** Alpha left after the synchronous warm ticks, before the first paint. */
    openAlpha: huge ? 0.12 : big ? 0.16 : 0.2,
  };
}

export interface GraphForceSettings {
  w: number;
  h: number;
  radius: (node: GraphForceNode) => number;
  repel: number;
  center: number;
  linkForce: number;
  linkDistance: number;
}
type GraphForceNode = SimulationNodeDatum & { degree?: number };
const clampForce = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(value, hi));

/**
 * Build GraphView's single force simulation, stopped at alpha 0.85. Every node
 * shares charge and centering; links are degree-scaled; collision keys off the
 * displayed radius plus the overlap gap.
 */
export function createGraphSimulation<N extends GraphForceNode & { id: string }, L extends SimulationLinkDatum<N>>(
  nodes: N[],
  links: L[],
  settings: GraphForceSettings
): Simulation<N, L> {
  const tier = graphSimulationTier(nodes.length);
  const chargeStrength = tier.chargeScale * settings.repel;
  const centerStrength = clampForce(settings.center, 0, 1) * 0.1;
  const pull = centerStrength * 0.4;
  const radius = settings.radius as (node: N) => number;
  const endpoint = (value: N | string | number) => (typeof value === "object" ? value : null);
  return forceSimulation<N, L>(nodes)
    .force("charge", forceManyBody<N>().strength(() => chargeStrength).distanceMax(tier.chargeDistanceMax).theta(tier.theta))
    .force(
      "link",
      forceLink<N, L>(links)
        .id((d) => d.id)
        // Link distance respects both endpoint radii so links cannot pull circles into overlap.
        .distance((l) => {
          const s = endpoint(l.source), t = endpoint(l.target);
          return (s ? radius(s) : 6) + (t ? radius(t) : 6) + settings.linkDistance / 10;
        })
        // d3's default degree scaling: hub-to-hub links are weak, leaf links stay strong.
        .strength((l) => {
          const s = endpoint(l.source), t = endpoint(l.target);
          return clampForce((1 / Math.max(1, Math.min(s?.degree ?? 1, t?.degree ?? 1))) * settings.linkForce, 0, 2);
        })
    )
    .force("center", forceCenter<N>(settings.w / 2, settings.h / 2).strength(centerStrength))
    .force("collide", forceCollide<N>().radius((n) => radius(n) + 6).strength(1).iterations(tier.collideIterations))
    .force("x", forceX<N>(settings.w / 2).strength(() => pull))
    .force("y", forceY<N>(settings.h / 2).strength(() => pull))
    .velocityDecay(tier.velocityDecay)
    .alphaDecay(tier.alphaDecay)
    .alpha(0.85)
    .stop();
}

/** Alpha below which a released graph counts as settled (GraphView's tick threshold). */
export const GRAPH_SETTLED_ALPHA = 0.004;
/** Drag reheat target shared with GraphView. */
const GRAPH_DRAG_ALPHA = 0.3;

/**
 * A plain-number copy of a live GraphView simulation: node state, every
 * force's per-node/per-link values and the simulation's decay settings. It is
 * structured-cloneable so a worker can rebuild the same simulation.
 */
export interface GraphPhysicsInit {
  /** x, y, vx, vy per node. */
  state: Float64Array;
  /** fx, fy per node; NaN when free. */
  fixed: Float64Array;
  /** source, target node index per link. */
  links: Int32Array;
  linkDistance: Float64Array;
  linkStrength: Float64Array;
  linkIterations: number;
  charge: Float64Array;
  chargeTheta: number;
  chargeDistanceMin: number;
  chargeDistanceMax: number;
  centerX: number;
  centerY: number;
  centerStrength: number;
  collideRadius: Float64Array;
  collideStrength: number;
  /** Configured passes; a grab runs one pass until release. */
  collideIterations: number;
  xTarget: Float64Array;
  xStrength: Float64Array;
  yTarget: Float64Array;
  yStrength: Float64Array;
  alpha: number;
  alphaMin: number;
  alphaDecay: number;
  alphaTarget: number;
  velocityDecay: number;
  /** Velocity cap for every non-grabbed node while a grab is active. */
  velocityCap: number;
  /** Settling runs two ticks per step below this node count. */
  doubleTickBelow: number;
  /** Grabbed node index, or -1. */
  grab: number;
  /**
   * When present, the session also runs GraphView's idle overlap cleanup: it
   * ticks only while hot or grabbed, resolves overlaps once alpha falls to
   * 0.02, and counts as settled only after a pass moves nothing.
   */
  overlap?: { gap: number; radius: Float64Array; phase: Float64Array };
}

type GraphNodeLike = SimulationNodeDatum & { id: string };
type IndexLink = SimulationLinkDatum<SimulationNodeDatum> & { source: number; target: number };

/** Copy a live simulation's node state and force values into a clonable init. */
export function snapshotGraphPhysics<N extends GraphNodeLike, L extends SimulationLinkDatum<N>>(
  sim: Simulation<N, L>,
  options: {
    collideIterations: number;
    velocityCap: number;
    doubleTickBelow: number;
    grab: N | null;
    overlap?: { gap: number; radius: (node: N) => number; phase: (node: N) => number };
  }
): GraphPhysicsInit {
  const nodes = sim.nodes();
  const n = nodes.length;
  const index = new Map<N, number>();
  nodes.forEach((node, i) => index.set(node, i));
  const state = new Float64Array(n * 4);
  const fixed = new Float64Array(n * 2);
  nodes.forEach((node, i) => {
    state[i * 4] = node.x ?? 0;
    state[i * 4 + 1] = node.y ?? 0;
    state[i * 4 + 2] = node.vx ?? 0;
    state[i * 4 + 3] = node.vy ?? 0;
    fixed[i * 2] = node.fx ?? NaN;
    fixed[i * 2 + 1] = node.fy ?? NaN;
  });
  const perNode = (fn: ((d: N, i: number, data: N[]) => number) | undefined, fallback: number) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = fn ? +fn(nodes[i], i, nodes) : fallback;
    return out;
  };

  const linkForce = sim.force("link") as ForceLink<N, L> | undefined;
  const linkData = linkForce?.links() ?? [];
  const links = new Int32Array(linkData.length * 2);
  const linkDistance = new Float64Array(linkData.length);
  const linkStrength = new Float64Array(linkData.length);
  linkData.forEach((l, i) => {
    links[i * 2] = index.get(l.source as N) ?? -1;
    links[i * 2 + 1] = index.get(l.target as N) ?? -1;
    linkDistance[i] = +linkForce!.distance()(l, i, linkData);
    linkStrength[i] = +linkForce!.strength()(l, i, linkData);
  });

  const charge = sim.force("charge") as ForceManyBody<N> | undefined;
  const center = sim.force("center") as ForceCenter<N> | undefined;
  const collide = sim.force("collide") as ForceCollide<N> | undefined;
  const fx = sim.force("x") as ForceX<N> | undefined;
  const fy = sim.force("y") as ForceY<N> | undefined;
  return {
    state,
    fixed,
    links,
    linkDistance,
    linkStrength,
    linkIterations: linkForce?.iterations() ?? 1,
    charge: perNode(charge?.strength(), 0),
    chargeTheta: charge?.theta() ?? 0.9,
    chargeDistanceMin: charge?.distanceMin() ?? 1,
    chargeDistanceMax: charge?.distanceMax() ?? Infinity,
    centerX: center?.x() ?? 0,
    centerY: center?.y() ?? 0,
    centerStrength: center ? center.strength() : 0,
    collideRadius: perNode(collide?.radius(), 0),
    collideStrength: collide?.strength() ?? 0,
    collideIterations: options.collideIterations,
    xTarget: perNode(fx?.x(), 0),
    xStrength: perNode(fx?.strength(), 0),
    yTarget: perNode(fy?.y(), 0),
    yStrength: perNode(fy?.strength(), 0),
    alpha: sim.alpha(),
    alphaMin: sim.alphaMin(),
    alphaDecay: sim.alphaDecay(),
    alphaTarget: sim.alphaTarget(),
    velocityDecay: sim.velocityDecay(),
    velocityCap: options.velocityCap,
    doubleTickBelow: options.doubleTickBelow,
    grab: options.grab ? index.get(options.grab) ?? -1 : -1,
    overlap: options.overlap && {
      gap: options.overlap.gap,
      radius: Float64Array.from(nodes, options.overlap.radius),
      phase: Float64Array.from(nodes, options.overlap.phase),
    },
  };
}

/** Buffers a start message can transfer instead of copying; the init is unusable afterwards. */
export function graphPhysicsTransferables(init: GraphPhysicsInit): ArrayBuffer[] {
  const arrays = [init.state, init.fixed, init.links, init.linkDistance, init.linkStrength, init.charge, init.collideRadius, init.xTarget, init.xStrength, init.yTarget, init.yStrength];
  if (init.overlap) arrays.push(init.overlap.radius, init.overlap.phase);
  return [...new Set(arrays.map((array) => array.buffer as ArrayBuffer))];
}

/** The worker-side copy of a GraphView simulation for one drag and its settle. */
export class GraphPhysicsSession {
  readonly nodes: SimulationNodeDatum[];
  readonly sim: Simulation<SimulationNodeDatum, IndexLink>;
  private readonly collide: ForceCollide<SimulationNodeDatum>;
  private readonly configuredCollide: number;
  private readonly velocityCap: number;
  private readonly doubleTickBelow: number;
  private readonly overlap: GraphPhysicsInit["overlap"];
  private overlapsResolved = false;
  private grabbed = -1;

  constructor(init: GraphPhysicsInit) {
    const n = init.state.length / 4;
    this.nodes = Array.from({ length: n }, (_, i) => {
      const fxv = init.fixed[i * 2];
      const fyv = init.fixed[i * 2 + 1];
      return {
        x: init.state[i * 4],
        y: init.state[i * 4 + 1],
        vx: init.state[i * 4 + 2],
        vy: init.state[i * 4 + 3],
        fx: Number.isNaN(fxv) ? null : fxv,
        fy: Number.isNaN(fyv) ? null : fyv,
      };
    });
    const links: IndexLink[] = [];
    for (let i = 0; i < init.links.length; i += 2) {
      links.push({ source: init.links[i], target: init.links[i + 1] });
    }
    this.configuredCollide = init.collideIterations;
    this.velocityCap = init.velocityCap;
    this.doubleTickBelow = init.doubleTickBelow;
    this.overlap = init.overlap;
    this.collide = forceCollide<SimulationNodeDatum>()
      .radius((_, i) => init.collideRadius[i])
      .strength(init.collideStrength)
      .iterations(init.collideIterations);
    this.sim = forceSimulation<SimulationNodeDatum, IndexLink>(this.nodes)
      .force(
        "charge",
        forceManyBody<SimulationNodeDatum>()
          .strength((_, i) => init.charge[i])
          .theta(init.chargeTheta)
          .distanceMin(init.chargeDistanceMin)
          .distanceMax(init.chargeDistanceMax)
      )
      .force(
        "link",
        forceLink<SimulationNodeDatum, IndexLink>(links)
          .distance((_, i) => init.linkDistance[i])
          .strength((_, i) => init.linkStrength[i])
          .iterations(init.linkIterations)
      )
      .force("center", forceCenter(init.centerX, init.centerY).strength(init.centerStrength))
      .force("collide", this.collide)
      .force("x", forceX<SimulationNodeDatum>((_, i) => init.xTarget[i]).strength((_, i) => init.xStrength[i]))
      .force("y", forceY<SimulationNodeDatum>((_, i) => init.yTarget[i]).strength((_, i) => init.yStrength[i]))
      .velocityDecay(init.velocityDecay)
      .alphaMin(init.alphaMin)
      .alphaDecay(init.alphaDecay)
      .alphaTarget(init.alphaTarget)
      .alpha(init.alpha)
      .stop();
    if (init.grab >= 0) {
      this.grab(init.grab, init.fixed[init.grab * 2], init.fixed[init.grab * 2 + 1]);
    }
  }

  get grabbing(): boolean {
    return this.grabbed >= 0;
  }

  /** True once a released graph has cooled below the tick threshold. */
  get settled(): boolean {
    return this.grabbed < 0 && this.sim.alpha() <= GRAPH_SETTLED_ALPHA && (!this.overlap || this.overlapsResolved);
  }

  /** Only an in-range array index from the worker message selects a node. */
  private nodeAt(index: number): SimulationNodeDatum | undefined {
    return Number.isInteger(index) && index >= 0 && index < this.nodes.length ? this.nodes[index] : undefined;
  }

  /** Pin a node and reheat exactly as GraphView's first drag move does. */
  grab(index: number, fx: number, fy: number): void {
    const node = this.nodeAt(index);
    if (!node) return;
    node.fx = fx;
    node.fy = fy;
    this.grabbed = index;
    this.sim.alpha(Math.max(this.sim.alpha(), GRAPH_DRAG_ALPHA)).alphaTarget(GRAPH_DRAG_ALPHA);
    this.collide.iterations(1);
  }

  move(index: number, fx: number, fy: number): void {
    const node = this.nodeAt(index);
    if (!node) return;
    node.fx = fx;
    node.fy = fy;
  }

  /** Unpin and let existing energy decay, as GraphView's release does. */
  release(index: number): void {
    const node = this.nodeAt(index);
    if (node) {
      node.fx = null;
      node.fy = null;
    }
    if (index === this.grabbed) this.grabbed = -1;
    this.sim.alphaTarget(0);
    this.collide.iterations(this.configuredCollide);
  }

  /** One GraphView frame of physics: tick count and velocity caps match the main thread. */
  step(): void {
    const grabbing = this.grabbed >= 0;
    if (this.overlap) {
      // GraphView's frame order: tick while hot or grabbed, then clean up
      // overlaps below alpha 0.02 until a pass moves nothing.
      if (grabbing || this.sim.alpha() > GRAPH_SETTLED_ALPHA) {
        this.tick(grabbing);
        this.overlapsResolved = false;
      }
      if (!grabbing && this.sim.alpha() <= 0.02 && !this.overlapsResolved) {
        const { gap, radius, phase } = this.overlap;
        const moved = resolveOverlaps(this.nodes, (n) => radius[n.index!], gap, 2, (n) => phase[n.index!]);
        this.overlapsResolved = !moved;
      }
      return;
    }
    this.tick(grabbing);
  }

  private tick(grabbing: boolean): void {
    const ticks =
      this.nodes.length < this.doubleTickBelow && this.sim.alpha() > 0.06 && !grabbing ? 2 : 1;
    for (let t = 0; t < ticks; t++) {
      this.sim.tick();
      if (!grabbing) continue;
      const cap = this.velocityCap;
      const pinned = this.nodes[this.grabbed];
      for (const node of this.nodes) {
        if (node === pinned) continue;
        if (node.vx != null) node.vx = Math.max(-cap, Math.min(node.vx, cap));
        if (node.vy != null) node.vy = Math.max(-cap, Math.min(node.vy, cap));
      }
    }
  }

  /** x, y, vx, vy per node. */
  state(): Float64Array {
    const out = new Float64Array(this.nodes.length * 4);
    this.nodes.forEach((node, i) => {
      out[i * 4] = node.x ?? 0;
      out[i * 4 + 1] = node.y ?? 0;
      out[i * 4 + 2] = node.vx ?? 0;
      out[i * 4 + 3] = node.vy ?? 0;
    });
    return out;
  }
}

/** Worker protocol: main → worker. */
export type GraphPhysicsRequest =
  | { type: "start"; session: number; init: GraphPhysicsInit }
  | { type: "grab" | "move"; session: number; index: number; fx: number; fy: number }
  | { type: "release"; session: number; index: number }
  | { type: "stop"; session: number };

/** Worker protocol: worker → main. `idle` means the released graph settled. */
export type GraphPhysicsResponse =
  | { type: "state"; session: number; state: Float64Array; alpha: number }
  | { type: "idle"; session: number; state: Float64Array; alpha: number };
