import { expect, it } from "vitest";
import { ChargeKernel } from "./graphChargeKernel";
import { tickParallel, type ChargeApplyRequest, type ChargeHelpers, type ChargeResponse, type ChargeTreeRequest } from "./graphChargeParallel";
import { GRAPH_FORCE_DEFAULTS, createGraphSimulation, seededRandom, warmGraphSimulation } from "./graphPhysics";

type Node = { id: string; x?: number; y?: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null; index?: number };
type Link = { source: string | Node; target: string | Node };

/** Helpers that run in-process on their own kernels, with copied inputs like worker messages. */
function inProcessHelpers(size: number): ChargeHelpers & { calls: number } {
  const kernels = Array.from({ length: size }, () => new ChargeKernel());
  const built = new Array<boolean>(size).fill(false);
  const helpers = {
    size, calls: 0,
    tree(h: number, m: ChargeTreeRequest) {
      const kernel = kernels[h];
      kernel.reserve(m.n);
      kernel.xs.set(m.xs.slice()); kernel.ys.set(m.ys.slice());
      kernel.strengths = m.strengths.slice();
      kernel.distanceMin2 = m.distanceMin2; kernel.distanceMax2 = m.distanceMax2; kernel.theta2 = m.theta2;
      built[h] = kernel.prepare();
    },
    async apply(h: number, m: ChargeApplyRequest): Promise<ChargeResponse> {
      helpers.calls++;
      const kernel = kernels[h];
      kernel.vx.set(m.vx.slice()); kernel.vy.set(m.vy.slice());
      let jiggled = false;
      if (built[h]) kernel.applyRange(m.from, m.to, m.alpha, () => { jiggled = true; return 0.5; });
      return { id: m.id, from: m.from, vx: kernel.vx.slice(m.from, m.to), vy: kernel.vy.slice(m.from, m.to), jiggled };
    },
  };
  return helpers;
}

function graph(coincident: boolean) {
  const random = seededRandom(11);
  const nodes: Node[] = Array.from({ length: 900 }, (_, i) => ({ id: `n${i}`, x: (random() - 0.5) * 2000, y: (random() - 0.5) * 2000 }));
  if (coincident) { nodes[5].x = nodes[4].x; nodes[5].y = nodes[4].y; }
  nodes[7].fx = 10; nodes[7].fy = -20;
  const links: Link[] = Array.from({ length: 2500 }, (_, i) => ({ source: `n${i % 900}`, target: `n${(i * 13 + 7) % 900}` })).filter((l) => l.source !== l.target);
  return { nodes, links };
}

for (const coincident of [false, true]) {
  it(`ticks bit-identically to d3 with the many-body pass split over helpers${coincident ? ", falling back on a jiggle" : ""}`, async () => {
    const a = graph(coincident), b = graph(coincident);
    const serial = createGraphSimulation<Node, Link>(a.nodes, a.links, GRAPH_FORCE_DEFAULTS);
    const parallel = createGraphSimulation<Node, Link>(b.nodes, b.links, GRAPH_FORCE_DEFAULTS);
    const helpers = inProcessHelpers(3);
    for (let t = 0; t < 25; t++) {
      serial.tick();
      await tickParallel(parallel as never, helpers);
    }
    expect(helpers.calls).toBeGreaterThan(0);
    expect(parallel.alpha()).toBe(serial.alpha());
    a.nodes.forEach((n, i) => {
      const m = b.nodes[i];
      expect(Object.is(n.x, m.x) && Object.is(n.y, m.y) && Object.is(n.vx, m.vx) && Object.is(n.vy, m.vy), `node ${i}`).toBe(true);
    });
  });
}

it("warms up through helpers to the same open layout", async () => {
  const a = graph(false), b = graph(false);
  const serial = createGraphSimulation<Node, Link>(a.nodes, a.links, GRAPH_FORCE_DEFAULTS);
  warmGraphSimulation(serial, a.nodes.length);
  const parallel = createGraphSimulation<Node, Link>(b.nodes, b.links, GRAPH_FORCE_DEFAULTS);
  const { warmGraphSimulationParallel } = await import("./graphPhysics");
  await warmGraphSimulationParallel(parallel, b.nodes.length, inProcessHelpers(2));
  expect(parallel.alpha()).toBe(serial.alpha());
  expect(parallel.alphaDecay()).toBe(serial.alphaDecay());
  a.nodes.forEach((n, i) => expect(Object.is(n.x, b.nodes[i].x) && Object.is(n.y, b.nodes[i].y), `node ${i}`).toBe(true));
});

it("keeps a replay finite when a batch is admitted while a parallel step waits for its helpers", async () => {
  const { GraphReplaySession, replayLinkOrder } = await import("./graphPhysics");
  const random = seededRandom(5);
  const order = Array.from({ length: 4000 }, (_, i) => ({ id: `n${i}` }));
  const links = Array.from({ length: 6000 }, (_, i) => ({ source: `n${i % 4000}`, target: `n${(i * 17 + 3) % 4000}` })).filter((l) => l.source !== l.target);
  const { links: sorted, admitAt } = replayLinkOrder(order, links);
  const rank = new Map(order.map((n, i) => [n.id, i]));
  const pairs = Int32Array.from(sorted.flatMap((l) => [rank.get(l.source)!, rank.get(l.target)!]));
  const replay = new GraphReplaySession(order.map((n) => n.id), pairs, admitAt, GRAPH_FORCE_DEFAULTS);
  const seeds = (count: number) => Float64Array.from({ length: count * 4 }, (_, k) => (k % 4 < 2 ? (random() - 0.5) * 3000 : 0));
  replay.admit(3000, seeds(3000));
  // Helpers that answer only after the caller has had a chance to run other work.
  const helpers = inProcessHelpers(2);
  const slow: ChargeHelpers = { size: helpers.size, tree: helpers.tree, apply: async (h, m) => { await new Promise((r) => setTimeout(r, 5)); return helpers.apply(h, m); } };
  const step = replay.stepParallel(slow);
  replay.admit(4000, seeds(1000)); // the next batch arrives mid-step
  await step;
  await replay.stepParallel(slow);
  const state = replay.state();
  expect(state.length).toBe(4000 * 4);
  expect(state.every(Number.isFinite)).toBe(true);
});

it("keeps two simulations sharing helpers apart, and falls back to one core when a helper died", async () => {
  const { createExclusive } = await import("./graphChargeParallel");
  const shared = inProcessHelpers(2);
  // Answers arrive later, so two simulations' messages could interleave on one helper.
  const slow = (exclusive: boolean): ChargeHelpers => ({
    size: shared.size, tree: shared.tree,
    apply: async (h, m) => { await new Promise((r) => setTimeout(r, 2)); return shared.apply(h, m); },
    ...(exclusive ? { exclusive: createExclusive() } : {}),
  });
  const run = async (helpers: ChargeHelpers) => {
    const a = graph(false), b = graph(false);
    for (const n of b.nodes) n.x! *= 1.7; // a different layout sharing the same helpers
    const simA = createGraphSimulation<Node, Link>(a.nodes, a.links, GRAPH_FORCE_DEFAULTS);
    const simB = createGraphSimulation<Node, Link>(b.nodes, b.links, GRAPH_FORCE_DEFAULTS);
    await Promise.all([0, 1, 2].map(async () => { await Promise.all([tickParallel(simA as never, helpers), tickParallel(simB as never, helpers)]); }));
    return a.nodes;
  };
  const expected = graph(false);
  const serial = createGraphSimulation<Node, Link>(expected.nodes, expected.links, GRAPH_FORCE_DEFAULTS);
  for (let t = 0; t < 3; t++) serial.tick();
  const same = (nodes: Node[]) => nodes.every((n, i) => Object.is(n.x, expected.nodes[i].x) && Object.is(n.y, expected.nodes[i].y));
  expect(same(await run(slow(true)))).toBe(true);
  // A dead helper: every apply rejects, each tick redoes the pass on one core.
  const dead: ChargeHelpers = { size: 2, failed: true, tree: () => {}, apply: () => Promise.reject(new Error("charge helper failed")) };
  const c = graph(false);
  const simC = createGraphSimulation<Node, Link>(c.nodes, c.links, GRAPH_FORCE_DEFAULTS);
  for (let t = 0; t < 3; t++) await tickParallel(simC as never, dead);
  expect(same(c.nodes)).toBe(true);
});
