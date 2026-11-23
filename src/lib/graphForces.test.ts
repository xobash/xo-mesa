import { forceCollide, forceLink, forceManyBody, type SimulationNodeDatum } from "d3-force";
import { describe, expect, it } from "vitest";
import { flatCollide, flatLink, flatManyBody } from "./graphForces";
import { seededRandom } from "./graphPhysics";

type Node = SimulationNodeDatum & { index: number; x: number; y: number; vx: number; vy: number };

/** Clustered points with exact duplicates, shared axes and a far outlier. */
function layout(n: number, seed: number): Node[] {
  const random = seededRandom(seed);
  const nodes: Node[] = [];
  for (let i = 0; i < n; i++) {
    const cluster = i % 7;
    let x = cluster * 300 + (random() - 0.5) * 400, y = (cluster % 3) * 250 + (random() - 0.5) * 400;
    if (i % 41 === 5 && i > 0) { x = nodes[i - 1].x; y = nodes[i - 1].y; }
    if (i % 53 === 7 && i > 0) x = nodes[i - 1].x;
    if (i === n - 1) { x = 1e6; y = -3.5; }
    nodes.push({ index: i, x, y, vx: (random() - 0.5) * 3, vy: (random() - 0.5) * 3 });
  }
  return nodes;
}
const clone = (nodes: Node[]) => nodes.map((n) => ({ ...n }));
function expectIdentical(a: Node[], b: Node[]) {
  for (let i = 0; i < a.length; i++) {
    expect(Object.is(a[i].vx, b[i].vx) && Object.is(a[i].vy, b[i].vy), `node ${i}: ${a[i].vx},${a[i].vy} vs ${b[i].vx},${b[i].vy}`).toBe(true);
  }
}

describe("flat forces equal d3-force bit for bit", () => {
  for (const [n, seed] of [[1, 1], [2, 2], [40, 3], [3000, 4]] as const) {
    it(`many-body on ${n} nodes, Mesa's settings and d3 defaults`, () => {
      for (const configure of [
        (f: ReturnType<typeof forceManyBody<Node>> | ReturnType<typeof flatManyBody<Node>>) => f.strength(-1000).distanceMin(30),
        (f: ReturnType<typeof forceManyBody<Node>> | ReturnType<typeof flatManyBody<Node>>) => f.strength((d: Node) => -10 - (d.index % 5)).distanceMax(500).theta(0.6),
        (f: ReturnType<typeof forceManyBody<Node>> | ReturnType<typeof flatManyBody<Node>>) => f,
      ]) {
        const base = layout(n, seed);
        const a = clone(base), b = clone(base);
        const d3 = forceManyBody<Node>(), flat = flatManyBody<Node>();
        configure(d3 as never); configure(flat as never);
        d3.initialize!(a, seededRandom(9));
        flat.initialize(b, seededRandom(9));
        for (const alpha of [1, 0.4, 0.02]) { d3(alpha); flat(alpha); }
        if (n > 2) expect(a.some((node, i) => node.vx !== base[i].vx)).toBe(true);
        expectIdentical(a, b);
      }
    });

    it(`collide on ${n} nodes, constant and per-node radii`, () => {
      for (const [radius, strength, iterations] of [[60, 0.5, 1], [(d: Node) => 5 + (d.index % 9) * 4, 1, 2]] as const) {
        const base = layout(n, seed + 10);
        const a = clone(base), b = clone(base);
        const d3 = forceCollide<Node>(radius as never).strength(strength).iterations(iterations);
        const flat = flatCollide<Node>(radius as never).strength(strength).iterations(iterations);
        d3.initialize!(a, seededRandom(5));
        flat.initialize(b, seededRandom(5));
        for (let t = 0; t < 3; t++) {
          d3(1); flat(1);
          for (const nodes of [a, b]) for (const node of nodes) { node.x += node.vx; node.y += node.vy; }
        }
        if (n > 2) expect(a.some((node, i) => node.vx !== base[i].vx)).toBe(true);
        expectIdentical(a, b);
      }
    });
  }

  type L = { source: string | number | Node; target: string | number | Node; index?: number };
  type Configurable = { id(fn: (d: Node) => string): Configurable; distance(fn: (l: L) => number): Configurable; strength(fn: (l: L) => number): Configurable; iterations(n: number): Configurable };
  for (const n of [2, 300, 3000]) {
    it(`link on ${n} nodes, default degree strength and per-link values, string and index endpoints`, () => {
      const base = layout(n, n + 3);
      const random = seededRandom(n);
      const pairs = Array.from({ length: n * 3 }, () => [Math.floor(random() * n), Math.floor(random() * n)] as const);
      const setups: [string, (f: Configurable) => void][] = [
        ["id", (f) => f.id((d) => `n${d.index}`)],
        ["index", (f) => f.distance((l) => 20 + (l.index! % 7)).strength((l) => 0.1 + (l.index! % 3) / 10).iterations(2)],
      ];
      for (const [endpoint, configure] of setups) {
        const linksFor = (): L[] => pairs.map(([s, t]) => endpoint === "id" ? { source: `n${s}`, target: `n${t}` } : { source: s, target: t });
        const a = clone(base), b = clone(base);
        const d3 = forceLink<Node, L & { source: Node; target: Node }>(linksFor() as (L & { source: Node; target: Node })[]);
        const flat = flatLink<Node, L>(linksFor());
        configure(d3 as unknown as Configurable); configure(flat as unknown as Configurable);
        d3.initialize!(a, seededRandom(2)); flat.initialize(b, seededRandom(2));
        for (const alpha of [1, 0.3]) { d3(alpha); flat(alpha); }
        expect(a.some((node, i) => node.vx !== base[i].vx)).toBe(true);
        expectIdentical(a, b);
        expect((flat.links()[0].source as Node).index).toBe(d3.links()[0].source.index);
        expect(flat.strength()(flat.links()[0], 0, flat.links())).toBe(d3.strength()(d3.links()[0], 0, d3.links()));
      }
    });
  }

  it("reports the same configuration back", () => {
    const charge = flatManyBody<Node>().strength(-1000).distanceMin(30);
    expect(charge.strength()({} as Node, 0, [])).toBe(-1000);
    expect(charge.distanceMin()).toBe(30);
    expect(charge.theta()).toBeCloseTo(0.9);
    const collide = flatCollide<Node>(60).strength(0.5);
    expect(collide.radius()({} as Node, 0, [])).toBe(60);
    expect(collide.strength()).toBe(0.5);
    expect(collide.iterations()).toBe(1);
  });
});
