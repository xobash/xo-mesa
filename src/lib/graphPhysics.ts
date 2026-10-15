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

/** Alpha below which a released graph counts as settled (GraphView's tick threshold). */
export const GRAPH_SETTLED_ALPHA = 0.004;
/** Drag reheat target shared with GraphView. */
export const GRAPH_DRAG_ALPHA = 0.3;

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
}

type GraphNodeLike = SimulationNodeDatum & { id: string };
type IndexLink = SimulationLinkDatum<SimulationNodeDatum> & { source: number; target: number };

/** Copy a live simulation's node state and force values into a clonable init. */
export function snapshotGraphPhysics<N extends GraphNodeLike, L extends SimulationLinkDatum<N>>(
  sim: Simulation<N, L>,
  options: { collideIterations: number; velocityCap: number; doubleTickBelow: number; grab: N | null }
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
  };
}

/** The worker-side copy of a GraphView simulation for one drag and its settle. */
export class GraphPhysicsSession {
  readonly nodes: SimulationNodeDatum[];
  readonly sim: Simulation<SimulationNodeDatum, IndexLink>;
  private readonly collide: ForceCollide<SimulationNodeDatum>;
  private readonly configuredCollide: number;
  private readonly velocityCap: number;
  private readonly doubleTickBelow: number;
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
    return this.grabbed < 0 && this.sim.alpha() <= GRAPH_SETTLED_ALPHA;
  }

  /** Pin a node and reheat exactly as GraphView's first drag move does. */
  grab(index: number, fx: number, fy: number): void {
    const node = this.nodes[index];
    if (!node) return;
    node.fx = fx;
    node.fy = fy;
    this.grabbed = index;
    this.sim.alpha(Math.max(this.sim.alpha(), GRAPH_DRAG_ALPHA)).alphaTarget(GRAPH_DRAG_ALPHA);
    this.collide.iterations(1);
  }

  move(index: number, fx: number, fy: number): void {
    const node = this.nodes[index];
    if (!node) return;
    node.fx = fx;
    node.fy = fy;
  }

  /** Unpin and let existing energy decay, as GraphView's release does. */
  release(index: number): void {
    const node = this.nodes[index];
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
