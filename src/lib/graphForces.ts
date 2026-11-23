/**
 * Flat-array copies of d3-force 3.0.0's `forceManyBody` and `forceCollide`
 * over a d3-quadtree 3.0.1 tree. They build the same tree, visit it in the
 * same order and do the same arithmetic in the same order, so velocities are
 * bit-identical to d3's (`graphForces.test.ts` compares them on every field).
 * Only the storage differs: typed arrays instead of one object per quad and a
 * closure per visit. Re-check parity on any d3-force or d3-quadtree upgrade.
 */

import { ChargeKernel } from "./graphChargeKernel";
import { FlatQuadtree } from "./graphQuadtree";

type ForceNode = { index?: number; x?: number; y?: number; vx?: number; vy?: number };
type NodeValue<N> = number | ((node: N, i: number, nodes: N[]) => number);

function jiggle(random: () => number): number {
  return (random() - 0.5) * 1e-6;
}

function perNode<N extends ForceNode>(value: NodeValue<N>, nodes: N[]): Float64Array<ArrayBuffer> {
  const out = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    out[node.index ?? i] = typeof value === "function" ? +value(node, i, nodes) : +value;
  }
  return out;
}

/** Load node positions and velocities into flat arrays. */
function load<N extends ForceNode>(nodes: N[], xs: Float64Array, ys: Float64Array, vx: Float64Array, vy: Float64Array): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    xs[i] = node.x as number; ys[i] = node.y as number;
    vx[i] = node.vx as number; vy[i] = node.vy as number;
  }
}

function store<N extends ForceNode>(nodes: N[], vx: Float64Array, vy: Float64Array): void {
  for (let i = 0; i < nodes.length; i++) { nodes[i].vx = vx[i]; nodes[i].vy = vy[i]; }
}

export interface FlatManyBody<N extends ForceNode> {
  (alpha: number): void;
  initialize(nodes: N[], random: () => number): void;
  strength(): (node: N, i: number, nodes: N[]) => number;
  strength(value: NodeValue<N>): FlatManyBody<N>;
  distanceMin(): number;
  distanceMin(value: number): FlatManyBody<N>;
  distanceMax(): number;
  distanceMax(value: number): FlatManyBody<N>;
  theta(): number;
  theta(value: number): FlatManyBody<N>;
  /** Load node positions into the kernel for a parallel tick (no tree); null without nodes. */
  loadPositions(): ChargeKernel | null;
  /** Load node velocities into the kernel (after the link force). */
  loadVelocities(): void;
  /** Write the kernel's velocities back to the nodes. */
  commitKernel(): void;
}

/** d3 `forceManyBody()` (Barnes-Hut), same defaults: strength -30, theta 0.9. */
export function flatManyBody<N extends ForceNode>(): FlatManyBody<N> {
  let nodes: N[] = [];
  let random: () => number = Math.random;
  let strength: NodeValue<N> = -30;
  const kernel = new ChargeKernel();

  const prepareKernel = (): ChargeKernel | null => {
    kernel.reserve(nodes.length);
    load(nodes, kernel.xs, kernel.ys, kernel.vx, kernel.vy);
    return kernel.prepare() ? kernel : null;
  };
  const force = ((alpha: number) => {
    if (!prepareKernel()) return;
    kernel.applyRange(0, nodes.length, alpha, random);
    store(nodes, kernel.vx, kernel.vy);
  }) as FlatManyBody<N>;

  force.loadPositions = () => {
    if (nodes.length === 0) return null;
    kernel.reserve(nodes.length);
    for (let i = 0; i < nodes.length; i++) { kernel.xs[i] = nodes[i].x as number; kernel.ys[i] = nodes[i].y as number; }
    return kernel;
  };
  force.loadVelocities = () => {
    for (let i = 0; i < nodes.length; i++) { kernel.vx[i] = nodes[i].vx as number; kernel.vy[i] = nodes[i].vy as number; }
  };
  force.commitKernel = () => store(nodes, kernel.vx, kernel.vy);
  force.initialize = (next, nextRandom) => { nodes = next; random = nextRandom; kernel.strengths = perNode(strength, nodes); };
  force.strength = ((value?: NodeValue<N>) => {
    if (value === undefined) return typeof strength === "function" ? strength : (() => strength as number);
    strength = value; kernel.strengths = perNode(strength, nodes);
    return force;
  }) as FlatManyBody<N>["strength"];
  force.distanceMin = ((value?: number) => {
    if (value === undefined) return Math.sqrt(kernel.distanceMin2);
    kernel.distanceMin2 = value * value; return force;
  }) as FlatManyBody<N>["distanceMin"];
  force.distanceMax = ((value?: number) => {
    if (value === undefined) return Math.sqrt(kernel.distanceMax2);
    kernel.distanceMax2 = value * value; return force;
  }) as FlatManyBody<N>["distanceMax"];
  force.theta = ((value?: number) => {
    if (value === undefined) return Math.sqrt(kernel.theta2);
    kernel.theta2 = value * value; return force;
  }) as FlatManyBody<N>["theta"];
  return force;
}

export interface FlatCollide<N extends ForceNode> {
  (alpha: number): void;
  initialize(nodes: N[], random: () => number): void;
  radius(): (node: N, i: number, nodes: N[]) => number;
  radius(value: NodeValue<N>): FlatCollide<N>;
  strength(): number;
  strength(value: number): FlatCollide<N>;
  iterations(): number;
  iterations(value: number): FlatCollide<N>;
}

/** d3 `forceCollide(radius)`, same defaults: strength 1, one iteration. */
export function flatCollide<N extends ForceNode>(initialRadius: NodeValue<N> = 1): FlatCollide<N> {
  let nodes: N[] = [];
  let random: () => number = Math.random;
  let radius: NodeValue<N> = initialRadius;
  let radii = new Float64Array(0);
  let strength = 1, iterations = 1;
  const tree = new FlatQuadtree();
  let xs = new Float64Array(0), ys = new Float64Array(0), vx = new Float64Array(0), vy = new Float64Array(0);

  /** d3 `prepare`: a leaf takes its head's radius, a quad its largest child's. */
  /**
   * Highest point index in each quad's subtree (a leaf counts only its head,
   * as d3 does). Node i acts only on partners with a higher index, so a
   * subtree whose highest index is at most i has no effect and is skipped;
   * the visit order of everything else is unchanged.
   */
  let maxIndex = new Int32Array(0);

  function prepare(): void {
    const { head, kids, value } = tree;
    if (maxIndex.length < tree.count) maxIndex = new Int32Array(tree.head.length);
    for (let q = 0; q < tree.count; q++) if (head[q] >= 0) { value[q] = radii[head[q]]; maxIndex[q] = head[q]; }
    const internals = tree.internals;
    for (let k = internals.length - 1; k >= 0; k--) {
      const q = internals[k];
      let r = 0, top = -1;
      for (let i = 0; i < 4; i++) {
        const c = kids[q * 4 + i];
        if (c < 0) continue;
        if (value[c] > r) r = value[c];
        if (maxIndex[c] > top) top = maxIndex[c];
      }
      value[q] = r;
      maxIndex[q] = top;
    }
  }

  function applyTo(i: number, px: Float64Array, py: Float64Array): void {
    const { head, kids, value, stack, bx0, by0, bx1, by1 } = tree;
    const ri = radii[i], ri2 = ri * ri;
    const xi = px[i] + vx[i], yi = py[i] + vy[i];
    if (maxIndex[tree.root] <= i) return;
    stack[0] = tree.root;
    let top = 1;
    while (top > 0) {
      const q = stack[--top];
      let rj = value[q], r = ri + rj;
      const data = head[q];
      if (data >= 0) {
        if (data > i) {
          let x = xi - px[data] - vx[data], y = yi - py[data] - vy[data], l = x * x + y * y;
          if (l < r * r) {
            if (x === 0) { x = jiggle(random); l += x * x; }
            if (y === 0) { y = jiggle(random); l += y * y; }
            l = (r - (l = Math.sqrt(l))) / l * strength;
            vx[i] += (x *= l) * (r = (rj *= rj) / (ri2 + rj));
            vy[i] += (y *= l) * r;
            vx[data] -= x * (r = 1 - r);
            vy[data] -= y * r;
          }
        }
        continue;
      }
      if (bx0[q] > xi + r || bx1[q] < xi - r || by0[q] > yi + r || by1[q] < yi - r) continue;
      const k = q * 4;
      let c = kids[k + 3]; if (c >= 0 && maxIndex[c] > i) stack[top++] = c;
      c = kids[k + 2]; if (c >= 0 && maxIndex[c] > i) stack[top++] = c;
      c = kids[k + 1]; if (c >= 0 && maxIndex[c] > i) stack[top++] = c;
      c = kids[k]; if (c >= 0 && maxIndex[c] > i) stack[top++] = c;
    }
  }

  let px = new Float64Array(0), py = new Float64Array(0);
  const force = ((_alpha: number) => {
    const n = nodes.length;
    if (xs.length < n) {
      xs = new Float64Array(n); ys = new Float64Array(n); vx = new Float64Array(n); vy = new Float64Array(n);
      px = new Float64Array(n); py = new Float64Array(n);
    }
    load(nodes, px, py, vx, vy);
    for (let k = 0; k < iterations; k++) {
      // The tree holds predicted positions x + vx at the start of each pass.
      for (let i = 0; i < n; i++) { xs[i] = px[i] + vx[i]; ys[i] = py[i] + vy[i]; }
      tree.build(xs, ys, n);
      if (tree.root < 0) continue;
      prepare();
      tree.ensureStack();
      for (let i = 0; i < n; i++) applyTo(i, px, py);
    }
    store(nodes, vx, vy);
  }) as FlatCollide<N>;

  force.initialize = (next, nextRandom) => { nodes = next; random = nextRandom; radii = perNode(radius, nodes); };
  force.radius = ((value?: NodeValue<N>) => {
    if (value === undefined) return typeof radius === "function" ? radius : (() => radius as number);
    radius = value; radii = perNode(radius, nodes);
    return force;
  }) as FlatCollide<N>["radius"];
  force.strength = ((value?: number) => {
    if (value === undefined) return strength;
    strength = +value; return force;
  }) as FlatCollide<N>["strength"];
  force.iterations = ((value?: number) => {
    if (value === undefined) return iterations;
    iterations = +value; return force;
  }) as FlatCollide<N>["iterations"];
  return force;
}

type LinkNode = ForceNode & { index?: number };
type FlatLinkDatum<N> = { source: string | number | N; target: string | number | N; index?: number };
type LinkValue<L> = number | ((link: L, i: number, links: L[]) => number);

export interface FlatLink<N extends LinkNode, L extends FlatLinkDatum<N>> {
  (alpha: number): void;
  initialize(nodes: N[], random: () => number): void;
  links(): L[];
  links(value: L[]): FlatLink<N, L>;
  id(): (node: N, i: number, nodes: N[]) => string | number;
  id(value: (node: N, i: number, nodes: N[]) => string | number): FlatLink<N, L>;
  strength(): (link: L, i: number, links: L[]) => number;
  strength(value: LinkValue<L>): FlatLink<N, L>;
  distance(): (link: L, i: number, links: L[]) => number;
  distance(value: LinkValue<L>): FlatLink<N, L>;
  iterations(): number;
  iterations(value: number): FlatLink<N, L>;
}

/**
 * d3 `forceLink(links)` with typed per-link coefficients: the same endpoint
 * resolution (strings and numbers become node objects), counts, bias,
 * strengths and distances, and the same tick arithmetic in the same order.
 */
export function flatLink<N extends LinkNode, L extends FlatLinkDatum<N>>(initial: L[] = []): FlatLink<N, L> {
  let links = initial;
  let nodes: N[] | null = null;
  let random: () => number = Math.random;
  let id: (node: N, i: number, nodes: N[]) => string | number = (node) => node.index as number;
  let count = new Float64Array(0);
  let bias = new Float64Array(0), strengths = new Float64Array(0), distances = new Float64Array(0);
  let iterations = 1;
  const defaultStrength = (link: L) => 1 / Math.min(count[(link.source as N).index!], count[(link.target as N).index!]);
  let strength: (link: L, i: number, links: L[]) => number = defaultStrength;
  let distance: (link: L, i: number, links: L[]) => number = () => 30;

  const force = ((alpha: number) => {
    const n = links.length;
    for (let k = 0; k < iterations; ++k) {
      for (let i = 0; i < n; ++i) {
        const link = links[i], source = link.source as Required<ForceNode>, target = link.target as Required<ForceNode>;
        let x = target.x + target.vx - source.x - source.vx || (random() - 0.5) * 1e-6;
        let y = target.y + target.vy - source.y - source.vy || (random() - 0.5) * 1e-6;
        let l = Math.sqrt(x * x + y * y);
        l = (l - distances[i]) / l * alpha * strengths[i];
        x *= l; y *= l;
        let b = bias[i];
        target.vx -= x * b;
        target.vy -= y * b;
        b = 1 - b;
        source.vx += x * b;
        source.vy += y * b;
      }
    }
  }) as FlatLink<N, L>;

  function find(byId: Map<string | number, N>, key: string | number): N {
    const node = byId.get(key);
    if (!node) throw new Error("node not found: " + key);
    return node;
  }

  function initialize(): void {
    if (!nodes) return;
    const n = nodes.length, m = links.length;
    const byId = new Map<string | number, N>();
    for (let i = 0; i < n; i++) byId.set(id(nodes[i], i, nodes), nodes[i]);
    count = new Float64Array(n);
    for (let i = 0; i < m; ++i) {
      const link = links[i];
      link.index = i;
      if (typeof link.source !== "object") link.source = find(byId, link.source);
      if (typeof link.target !== "object") link.target = find(byId, link.target);
      count[(link.source as N).index!] += 1;
      count[(link.target as N).index!] += 1;
    }
    bias = new Float64Array(m);
    for (let i = 0; i < m; ++i) {
      const s = count[(links[i].source as N).index!], t = count[(links[i].target as N).index!];
      bias[i] = s / (s + t);
    }
    initializeStrength();
    initializeDistance();
  }
  function initializeStrength(): void {
    if (!nodes) return;
    strengths = new Float64Array(links.length);
    for (let i = 0; i < links.length; ++i) strengths[i] = +strength(links[i], i, links);
  }
  function initializeDistance(): void {
    if (!nodes) return;
    distances = new Float64Array(links.length);
    for (let i = 0; i < links.length; ++i) distances[i] = +distance(links[i], i, links);
  }

  force.initialize = (next, nextRandom) => { nodes = next; random = nextRandom; initialize(); };
  force.links = ((value?: L[]) => {
    if (value === undefined) return links;
    links = value; initialize(); return force;
  }) as FlatLink<N, L>["links"];
  force.id = ((value?: (node: N, i: number, nodes: N[]) => string | number) => {
    if (value === undefined) return id;
    id = value; return force;
  }) as FlatLink<N, L>["id"];
  force.iterations = ((value?: number) => {
    if (value === undefined) return iterations;
    iterations = +value; return force;
  }) as FlatLink<N, L>["iterations"];
  force.strength = ((value?: LinkValue<L>) => {
    if (value === undefined) return strength;
    strength = typeof value === "function" ? value : (() => value); initializeStrength(); return force;
  }) as FlatLink<N, L>["strength"];
  force.distance = ((value?: LinkValue<L>) => {
    if (value === undefined) return distance;
    distance = typeof value === "function" ? value : (() => value); initializeDistance(); return force;
  }) as FlatLink<N, L>["distance"];
  return force;
}
