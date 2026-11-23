import {
  forceSimulation,
  forceX,
  forceY,
  type ForceCollide,
  type ForceLink,
  type ForceManyBody,
  type ForceX,
  type ForceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { resolveOverlaps } from "./graphGeometry";
import { flatCollide, flatLink, flatManyBody } from "./graphForces";
import { tickParallel, type ChargeHelpers } from "./graphChargeParallel";
import { graphForceValues, type GraphForceSettings } from "./graphForceDefaults";

export { GRAPH_FORCE_DEFAULTS, graphForceValues, sliderPosition, sliderStrength, type GraphForceSettings } from "./graphForceDefaults";

/**
 * Graph force model, matched to Obsidian 1.x defaults (measured from its
 * simulation worker): x/y pull to the origin, degree-scaled link springs,
 * many-body charge with a 30-unit minimum distance, and a fixed 60-unit soft
 * collision. One model at every graph size; world units are Obsidian's.
 */
const CHARGE_DISTANCE_MIN = 30;
const COLLIDE_RADIUS = 60;
const COLLIDE_STRENGTH = 0.5;
const VELOCITY_DECAY = 0.4;
/** d3's default: alpha falls from 1 to 0.001 in 300 ticks. */
const ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300);
/** A released graph stops ticking at or below this alpha. */
export const GRAPH_SETTLED_ALPHA = 0.001;
/** The idle overlap cleanup runs only at or below this alpha, never while a node is grabbed. */
export const GRAPH_OVERLAP_ALPHA = 0.02;
/** Alpha for a drag, a data change and a force retune. */
export const GRAPH_REHEAT_ALPHA = 0.3;
/**
 * Decay of the visible tail after the open warm-up: it reaches rest in about
 * 80 frames with little movement. The first reheat restores `ALPHA_DECAY`.
 */
const OPEN_TAIL_DECAY = 0.06;

type GraphForceNode = SimulationNodeDatum;
type LinkStrength<N extends GraphForceNode, L extends SimulationLinkDatum<N>> = (link: L, i: number, links: L[]) => number;
/** Each link force's built-in `1 / min(degree)` strength, kept so a retune can rescale it. */
const degreeStrength = new WeakMap<object, LinkStrength<never, never>>();

/**
 * Set every slider-driven force value on a simulation. Creation and retune
 * share this, so they cannot drift apart. Never changes alpha or positions.
 */
export function applyGraphForces<N extends GraphForceNode, L extends SimulationLinkDatum<N>>(
  sim: Simulation<N, L>,
  settings: GraphForceSettings
): void {
  const values = graphForceValues(settings);
  (sim.force("x") as ForceX<N> | undefined)?.strength(values.center);
  (sim.force("y") as ForceY<N> | undefined)?.strength(values.center);
  (sim.force("charge") as ForceManyBody<N> | undefined)?.strength(values.charge);
  const link = sim.force("link") as ForceLink<N, L> | undefined;
  if (!link) return;
  let base = degreeStrength.get(link) as LinkStrength<N, L> | undefined;
  if (!base) {
    base = link.strength() as LinkStrength<N, L>;
    degreeStrength.set(link, base as LinkStrength<never, never>);
  }
  const degreeScaled = base;
  link.distance(values.linkDistance).strength((l, i, all) => values.link * degreeScaled(l, i, all));
}

/** Build GraphView's single force simulation, stopped at alpha 1. */
export function createGraphSimulation<N extends GraphForceNode & { id: string }, L extends SimulationLinkDatum<N>>(
  nodes: N[],
  links: L[],
  settings: GraphForceSettings
): Simulation<N, L> {
  const sim = forceSimulation<N, L>(nodes)
    .force("x", forceX<N>(0))
    .force("y", forceY<N>(0))
    .force("link", flatLink<N, L>(links).id((d) => d.id))
    // Flat-array copies of d3's many-body and collide (bit-identical, faster).
    .force("charge", flatManyBody<N>().distanceMin(CHARGE_DISTANCE_MIN))
    .force("collide", flatCollide<N>(COLLIDE_RADIUS).strength(COLLIDE_STRENGTH))
    .velocityDecay(VELOCITY_DECAY)
    .alphaDecay(ALPHA_DECAY)
    .alphaMin(GRAPH_SETTLED_ALPHA)
    .stop();
  applyGraphForces(sim, settings);
  return sim;
}

/** Position fields the seeding step reads and writes. */
interface SeedNode {
  id: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

/** World area reserved per new node when seeding (a 60-unit square). */
const SEED_AREA = 60 * 60;

/** mulberry32: a small deterministic generator, so one graph always seeds the same way. */
export function seededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Place new nodes as Obsidian does. A node with an already placed neighbour
 * starts near the centroid of those neighbours; any other node starts in a
 * ring just outside the placed graph, sized for the number of new nodes.
 */
export function seedGraphNodes<N extends SeedNode>(
  fresh: readonly N[],
  placed: ReadonlyMap<string, N>,
  neighbors: ReadonlyMap<string, ReadonlySet<string>>,
  random: () => number
): void {
  if (fresh.length === 0) return;
  let farthest = 0;
  for (const node of placed.values()) farthest = Math.max(farthest, (node.x ?? 0) ** 2 + (node.y ?? 0) ** 2);
  const inner = Math.sqrt(farthest);
  const area = SEED_AREA * fresh.length;
  const ring = Math.sqrt(area / Math.PI + inner * inner) - inner;
  const spread = Math.sqrt(area);
  const known = new Map(placed);
  for (const node of fresh) {
    let sx = 0, sy = 0, count = 0;
    for (const id of neighbors.get(node.id) ?? []) {
      const other = known.get(id);
      if (!other || other.x == null || other.y == null) continue;
      sx += other.x;
      sy += other.y;
      count++;
    }
    if (count > 0) {
      node.x = sx / count + (random() - 0.5) * spread;
      node.y = sy / count + (random() - 0.5) * spread;
    } else {
      const angle = 2 * random() * Math.PI;
      const radius = inner + Math.sqrt(random()) * ring;
      node.x = radius * Math.cos(angle);
      node.y = radius * Math.sin(angle);
    }
    node.vx = 0;
    node.vy = 0;
    node.fx = null;
    node.fy = null;
    known.set(node.id, node);
  }
}

/**
 * Start a graph from a reused layout (`positions`: x, y per node, NaN where
 * unknown): kept nodes take their place at rest, new nodes are seeded beside
 * them as a live topology change seeds them.
 */
export function seedFromReusedLayout<N extends SeedNode>(
  nodes: readonly N[],
  positions: Float64Array,
  neighbors: ReadonlyMap<string, ReadonlySet<string>>,
  random: () => number
): void {
  const placed = new Map<string, N>();
  const fresh: N[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i], x = positions[i * 2], y = positions[i * 2 + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      node.x = x; node.y = y; node.vx = 0; node.vy = 0;
      placed.set(node.id, node);
    } else {
      fresh.push(node);
    }
  }
  seedGraphNodes(fresh, placed, neighbors, random);
}

/**
 * The synchronous ticks GraphView runs before the first paint, and the alpha
 * left for the visible tail. Larger graphs run fewer ticks to bound the block.
 */
export function graphOpenWarmup(count: number): { ticks: number; openAlpha: number } {
  if (count > 800) return { ticks: 42, openAlpha: 0.12 };
  if (count > 300) return { ticks: 56, openAlpha: 0.16 };
  return { ticks: 78, openAlpha: 0.2 };
}

/**
 * Ticks and per-tick decay of an open warm-up from `startAlpha` to the open
 * alpha. From alpha 1 it is the full warm-up; a reused layout starts at the
 * topology-change alpha and needs fewer ticks at the same decay.
 */
function warmSchedule(count: number, startAlpha: number): { ticks: number; decay: number } {
  const { ticks, openAlpha } = graphOpenWarmup(count);
  const decay = 1 - Math.pow(openAlpha, 1 / ticks);
  if (startAlpha >= 1) return { ticks, decay };
  return { ticks: Math.ceil(ticks * Math.log(openAlpha / startAlpha) / Math.log(openAlpha)), decay };
}

/**
 * Run the open warm-up: anneal from alpha 1 (or `startAlpha` for a reused
 * layout) down to the open alpha within the warm ticks, then leave a short,
 * fast-decaying tail for the visible frames. The result matches a full
 * standard anneal closely (same spread and link lengths), with little
 * movement left after the first paint.
 */
export function warmGraphSimulation<N extends GraphForceNode, L extends SimulationLinkDatum<N>>(
  sim: Simulation<N, L>,
  count: number,
  startAlpha = 1
): void {
  const { ticks, decay } = warmSchedule(count, startAlpha);
  sim.alpha(startAlpha).alphaDecay(decay);
  for (let i = 0; i < ticks; i++) sim.tick();
  finishGraphWarmup(sim, count);
}

/** `warmGraphSimulation` with the many-body pass spread over helper workers; the same layout. */
export async function warmGraphSimulationParallel<N extends GraphForceNode, L extends SimulationLinkDatum<N>>(
  sim: Simulation<N, L>,
  count: number,
  helpers: ChargeHelpers,
  startAlpha = 1
): Promise<void> {
  const { ticks, decay } = warmSchedule(count, startAlpha);
  sim.alpha(startAlpha).alphaDecay(decay);
  for (let i = 0; i < ticks; i++) await tickParallel(sim, helpers);
  finishGraphWarmup(sim, count);
}

/** The decay state a warm-up leaves; applied on the main simulation after a worker warm-up. */
export function finishGraphWarmup<N extends GraphForceNode, L extends SimulationLinkDatum<N>>(sim: Simulation<N, L>, count: number): void {
  sim.alphaDecay(OPEN_TAIL_DECAY).alpha(graphOpenWarmup(count).openAlpha);
}

/** Reheat for a drag, new graph data or a force retune, at the standard decay. Never lowers alpha. */
export function reheatGraphSimulation<N extends GraphForceNode, L extends SimulationLinkDatum<N>>(sim: Simulation<N, L>): Simulation<N, L> {
  return sim.alphaDecay(ALPHA_DECAY).alpha(Math.max(sim.alpha(), GRAPH_REHEAT_ALPHA));
}

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
  collideRadius: Float64Array;
  collideStrength: number;
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
  /** Grabbed node index, or -1. */
  grab: number;
  /**
   * When present, the session also runs GraphView's idle overlap cleanup: it
   * ticks only while hot or grabbed, resolves overlaps once alpha falls to
   * `GRAPH_OVERLAP_ALPHA`, and counts as settled only after a pass moves nothing.
   */
  overlap?: { gap: number; radius: Float64Array; phase: Float64Array };
}

type GraphNodeLike = SimulationNodeDatum & { id: string };
type IndexLink = SimulationLinkDatum<SimulationNodeDatum> & { source: number; target: number };

/** Copy a live simulation's node state and force values into a clonable init. */
export function snapshotGraphPhysics<N extends GraphNodeLike, L extends SimulationLinkDatum<N>>(
  sim: Simulation<N, L>,
  options: {
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
    collideRadius: perNode(collide?.radius(), 0),
    collideStrength: collide?.strength() ?? 0,
    collideIterations: collide?.iterations() ?? 1,
    xTarget: perNode(fx?.x(), 0),
    xStrength: perNode(fx?.strength(), 0),
    yTarget: perNode(fy?.y(), 0),
    yStrength: perNode(fy?.strength(), 0),
    alpha: sim.alpha(),
    alphaMin: sim.alphaMin(),
    alphaDecay: sim.alphaDecay(),
    alphaTarget: sim.alphaTarget(),
    velocityDecay: sim.velocityDecay(),
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
    this.overlap = init.overlap;
    // Same force order as createGraphSimulation, so both paths tick identically.
    this.sim = forceSimulation<SimulationNodeDatum, IndexLink>(this.nodes)
      .force("x", forceX<SimulationNodeDatum>((_, i) => init.xTarget[i]).strength((_, i) => init.xStrength[i]))
      .force("y", forceY<SimulationNodeDatum>((_, i) => init.yTarget[i]).strength((_, i) => init.yStrength[i]))
      .force(
        "link",
        flatLink<SimulationNodeDatum, IndexLink>(links)
          .distance((_, i) => init.linkDistance[i])
          .strength((_, i) => init.linkStrength[i])
          .iterations(init.linkIterations)
      )
      .force(
        "charge",
        flatManyBody<SimulationNodeDatum>()
          .strength((_, i) => init.charge[i])
          .theta(init.chargeTheta)
          .distanceMin(init.chargeDistanceMin)
          .distanceMax(init.chargeDistanceMax)
      )
      .force(
        "collide",
        flatCollide<SimulationNodeDatum>()
          .radius((_, i) => init.collideRadius[i])
          .strength(init.collideStrength)
          .iterations(init.collideIterations)
      )
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
    reheatGraphSimulation(this.sim).alphaTarget(GRAPH_REHEAT_ALPHA);
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
  }

  /** One GraphView frame of physics: one tick while hot or grabbed, then idle overlap cleanup. */
  step(): void {
    if (this.needsTick()) {
      this.sim.tick();
      this.overlapsResolved = false;
    }
    this.idleOverlap();
  }

  /** `step` with the many-body pass spread over helper workers (same result). */
  async stepParallel(helpers: ChargeHelpers): Promise<void> {
    if (this.needsTick()) {
      await tickParallel(this.sim, helpers);
      this.overlapsResolved = false;
    }
    this.idleOverlap();
  }

  get nodeCount(): number {
    return this.nodes.length;
  }

  private needsTick(): boolean {
    return this.grabbed >= 0 || this.sim.alpha() > GRAPH_SETTLED_ALPHA;
  }

  private idleOverlap(): void {
    const grabbing = this.grabbed >= 0;
    if (this.overlap && !grabbing && this.sim.alpha() <= GRAPH_OVERLAP_ALPHA && !this.overlapsResolved) {
      const { gap, radius, phase } = this.overlap;
      const moved = resolveOverlaps(this.nodes, (n) => radius[n.index!], gap, 2, (n) => phase[n.index!]);
      this.overlapsResolved = !moved;
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

/**
 * Replay links in admission order: a link joins once both ends are admitted,
 * so the links among the first `count` nodes are always a prefix. `order`
 * is the replay's node order; links whose ends are not in it are dropped.
 */
export function replayLinkOrder<L extends { source: string | { id: string }; target: string | { id: string } }>(
  order: readonly { id: string }[],
  links: readonly L[]
): { links: L[]; admitAt: Int32Array } {
  const rank = new Map<string, number>();
  order.forEach((node, i) => rank.set(node.id, i));
  const id = (end: string | { id: string }) => (typeof end === "string" ? end : end.id);
  const keyed: { link: L; at: number; i: number }[] = [];
  links.forEach((link, i) => {
    const s = rank.get(id(link.source)), t = rank.get(id(link.target));
    if (s !== undefined && t !== undefined) keyed.push({ link, at: Math.max(s, t) + 1, i });
  });
  keyed.sort((a, b) => a.at - b.at || a.i - b.i);
  return { links: keyed.map((k) => k.link), admitAt: Int32Array.from(keyed, (k) => k.at) };
}

/** Number of replay links visible with `count` nodes admitted (`admitAt` is ascending). */
export function replayLinkCount(admitAt: Int32Array, count: number): number {
  let lo = 0, hi = admitAt.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (admitAt[mid] <= count) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * The worker copy of a timelapse replay: the same force model as
 * `createGraphSimulation`, holding only admitted nodes and their links, as
 * GraphView's main-thread replay does. Never sends "idle": the replay ends it.
 */
type ReplayNode = SimulationNodeDatum & { id: string };
type ReplayLink = SimulationLinkDatum<ReplayNode>;

export class GraphReplaySession {
  private readonly nodes: ReplayNode[];
  private readonly links: ReplayLink[];
  private readonly admitAt: Int32Array;
  readonly sim: Simulation<ReplayNode, ReplayLink>;
  private count = 0;

  constructor(ids: readonly string[], links: Int32Array, admitAt: Int32Array, settings: GraphForceSettings) {
    this.nodes = ids.map((id) => ({ id, x: 0, y: 0, vx: 0, vy: 0 }));
    this.links = [];
    for (let i = 0; i < links.length; i += 2) this.links.push({ source: ids[links[i]], target: ids[links[i + 1]] });
    this.admitAt = admitAt;
    this.sim = createGraphSimulation<ReplayNode, ReplayLink>([], [], settings);
  }

  /** Admits that arrived while a parallel step was running; applied when it ends. */
  private deferred: { count: number; seeds: Float64Array }[] = [];
  private stepping = false;

  /**
   * Admit nodes up to `count`, placing the new ones at `seeds` (x, y, vx, vy
   * each), and reheat. During a parallel step the batch waits for the step to
   * end: changing the node list mid-step wrote velocities the step never
   * computed (NaN) and blanked the graph after a replay.
   */
  admit(count: number, seeds: Float64Array): void {
    if (this.stepping) { this.deferred.push({ count, seeds }); return; }
    this.admitNow(count, seeds);
  }

  private admitNow(count: number, seeds: Float64Array): void {
    const next = Math.max(this.count, Math.min(count, this.nodes.length));
    for (let i = this.count, k = 0; i < next; i++, k++) {
      const node = this.nodes[i];
      node.x = seeds[k * 4]; node.y = seeds[k * 4 + 1]; node.vx = seeds[k * 4 + 2]; node.vy = seeds[k * 4 + 3];
    }
    this.count = next;
    const link = this.sim.force("link") as ForceLink<ReplayNode, ReplayLink>;
    link.links([]);
    this.sim.nodes(this.nodes.slice(0, next));
    link.links(this.links.slice(0, replayLinkCount(this.admitAt, next)));
    reheatGraphSimulation(this.sim).stop();
  }

  get hot(): boolean {
    return this.sim.alpha() > GRAPH_SETTLED_ALPHA;
  }

  step(): void {
    if (this.hot) this.sim.tick();
  }

  /** `step` with the many-body pass spread over helper workers (same result). */
  async stepParallel(helpers: ChargeHelpers): Promise<void> {
    if (!this.hot) return;
    this.stepping = true;
    try {
      await tickParallel(this.sim, helpers);
    } finally {
      this.stepping = false;
      for (const batch of this.deferred.splice(0)) this.admitNow(batch.count, batch.seeds);
    }
  }

  get nodeCount(): number {
    return this.count;
  }

  /** x, y, vx, vy per admitted node, in replay order. */
  state(): Float64Array {
    const out = new Float64Array(this.count * 4);
    for (let i = 0; i < this.count; i++) {
      const node = this.nodes[i];
      out[i * 4] = node.x ?? 0; out[i * 4 + 1] = node.y ?? 0; out[i * 4 + 2] = node.vx ?? 0; out[i * 4 + 3] = node.vy ?? 0;
    }
    return out;
  }
}

/** Worker protocol: main → worker. */
export type GraphPhysicsRequest =
  | { type: "start"; session: number; init: GraphPhysicsInit }
  | { type: "grab" | "move"; session: number; index: number; fx: number; fy: number }
  | { type: "release"; session: number; index: number }
  | { type: "stop"; session: number }
  /** A heavy open is coming: start helper workers for `count` nodes now. */
  | { type: "helpers"; count: number }
  /** Run the open warm-up for `count` nodes on a copy and return it once. */
  | { type: "warm"; session: number; init: GraphPhysicsInit; count: number; startAlpha?: number }
  /** A timelapse replay: node ids in replay order, links as id-index pairs in admission order. */
  | { type: "replay"; session: number; ids: string[]; links: Int32Array; admitAt: Int32Array; settings: GraphForceSettings }
  /** Admit replay nodes up to `count`; `seeds` holds x, y, vx, vy of the newly admitted ones. */
  | { type: "admit"; session: number; count: number; seeds: Float64Array };

/** Worker protocol: worker → main. `idle` means the released graph settled. */
export type GraphPhysicsResponse =
  | { type: "state"; session: number; state: Float64Array; alpha: number }
  | { type: "idle"; session: number; state: Float64Array; alpha: number }
  | { type: "warmed"; session: number; state: Float64Array; alpha: number; ms?: number; helpers?: number };
