import { describe, expect, it } from "vitest";
import type { ForceCollide, ForceLink, ForceManyBody, ForceX, ForceY, Simulation } from "d3-force";
import {
  GRAPH_FORCE_DEFAULTS,
  GRAPH_OVERLAP_ALPHA,
  GRAPH_REHEAT_ALPHA,
  GRAPH_SETTLED_ALPHA,
  GraphPhysicsSession,
  applyGraphForces,
  createGraphSimulation,
  graphForceValues,
  graphOpenWarmup,
  graphPhysicsTransferables,
  reheatGraphSimulation,
  seedGraphNodes,
  seededRandom,
  sliderPosition,
  sliderStrength,
  snapshotGraphPhysics,
  warmGraphSimulation,
  finishGraphWarmup,
  GraphReplaySession,
  replayLinkCount,
  replayLinkOrder,
} from "./graphPhysics";
import { nodeRadius, phaseFromId, resolveOverlaps } from "./graphGeometry";

type Node = { id: string; degree: number; x?: number; y?: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null; index?: number };
type Link = { source: string | Node; target: string | Node };

/** A hub with 59 leaves, 40 second-level links and 60 isolated nodes. */
function graphData(): { nodes: Node[]; links: Link[]; neighbors: Map<string, Set<string>> } {
  const nodes: Node[] = Array.from({ length: 160 }, (_, i) => ({ id: `n${i}`, degree: 0 }));
  const links: Link[] = [];
  for (let i = 1; i < 60; i++) links.push({ source: "n0", target: `n${i}` });
  for (let i = 60; i < 100; i++) links.push({ source: `n${i}`, target: `n${i - 50}` });
  const neighbors = new Map<string, Set<string>>();
  const join = (a: string, b: string) => neighbors.set(a, (neighbors.get(a) ?? new Set()).add(b));
  for (const l of links) {
    nodes[+String(l.source).slice(1)].degree++;
    nodes[+String(l.target).slice(1)].degree++;
    join(String(l.source), String(l.target));
    join(String(l.target), String(l.source));
  }
  return { nodes, links, neighbors };
}

/** GraphView's simulation: seeded, built by the shared builder and warmed as on open. */
function graphSim(): { sim: Simulation<Node, Link>; nodes: Node[] } {
  const { nodes, links, neighbors } = graphData();
  seedGraphNodes(nodes, new Map(), neighbors, seededRandom(nodes.length));
  const sim = createGraphSimulation<Node, Link>(nodes, links, GRAPH_FORCE_DEFAULTS);
  warmGraphSimulation(sim, nodes.length);
  return { sim, nodes };
}

describe("Obsidian-parity force model", () => {
  it("maps the default sliders to Obsidian's default force values", () => {
    expect(GRAPH_FORCE_DEFAULTS.center).toBeCloseTo(0.518713248970312, 12);
    expect(GRAPH_FORCE_DEFAULTS).toMatchObject({ repel: 10, linkForce: 1, linkDistance: 250 });
    const values = graphForceValues(GRAPH_FORCE_DEFAULTS);
    expect(values.center).toBeCloseTo(0.1, 12);
    expect(values).toMatchObject({ charge: -1000, link: 1, linkDistance: 250 });
  });

  it("uses Obsidian's slider curves: log for center and link force, cubic for repel", () => {
    expect(sliderStrength(0)).toBe(0);
    expect(sliderStrength(1)).toBe(1);
    expect(sliderStrength(0.5)).toBeCloseTo((0.1 - 0.01) / 0.99, 12);
    for (const strength of [0, 0.03, 0.1, 0.6, 1]) expect(sliderStrength(sliderPosition(strength))).toBeCloseTo(strength, 12);
    expect(graphForceValues({ ...GRAPH_FORCE_DEFAULTS, repel: 15 }).charge).toBe(-3375);
    // A zero repel slider keeps a unit charge so coincident nodes still separate.
    expect(graphForceValues({ ...GRAPH_FORCE_DEFAULTS, repel: 0 }).charge).toBe(-1);
    expect(graphForceValues({ ...GRAPH_FORCE_DEFAULTS, linkDistance: 9999 }).linkDistance).toBe(500);
  });

  it("builds one simulation with Obsidian's forces at every size", () => {
    for (const count of [10, 400, 1200]) {
      const nodes: Node[] = Array.from({ length: count }, (_, i) => ({ id: `n${i}`, degree: 0, x: i, y: -i }));
      const links: Link[] = [{ source: "n0", target: "n1" }, { source: "n0", target: "n2" }, { source: "n3", target: "n0" }];
      const sim = createGraphSimulation<Node, Link>(nodes, links, GRAPH_FORCE_DEFAULTS);
      const charge = sim.force("charge") as ForceManyBody<Node>;
      expect(charge.strength()(nodes[0], 0, nodes)).toBe(-1000);
      expect(charge.distanceMin()).toBe(30);
      expect(charge.distanceMax()).toBe(Infinity);
      expect(charge.theta()).toBeCloseTo(0.9, 12);
      const x = sim.force("x") as ForceX<Node>;
      const y = sim.force("y") as ForceY<Node>;
      expect([x.x()(nodes[0], 0, nodes), y.y()(nodes[0], 0, nodes)]).toEqual([0, 0]);
      expect(x.strength()(nodes[0], 0, nodes)).toBeCloseTo(0.1, 12);
      expect(y.strength()(nodes[0], 0, nodes)).toBeCloseTo(0.1, 12);
      const collide = sim.force("collide") as ForceCollide<Node>;
      expect(collide.radius()(nodes[0], 0, nodes)).toBe(60);
      expect([collide.strength(), collide.iterations()]).toEqual([0.5, 1]);
      const link = sim.force("link") as ForceLink<Node, Link>;
      const all = link.links();
      expect(link.distance()(all[0], 0, all)).toBe(250);
      // Degree-scaled: n0 has three links, each leaf one.
      expect(link.strength()(all[0], 0, all)).toBe(1);
      expect(sim.force("center")).toBeUndefined();
      expect(sim.velocityDecay()).toBeCloseTo(0.4, 12);
      expect(sim.alphaDecay()).toBeCloseTo(1 - Math.pow(0.001, 1 / 300), 12);
      expect(sim.alphaMin()).toBe(GRAPH_SETTLED_ALPHA);
    }
  });

  it("retunes forces in place without moving nodes, changing alpha or stacking the link scale", () => {
    const { sim, nodes } = graphSim();
    const before = nodes.map((n) => [n.x, n.y]);
    const alpha = sim.alpha();
    const link = sim.force("link") as ForceLink<Node, Link>;
    const all = link.links();
    const half = sliderPosition(0.5);
    for (let pass = 0; pass < 3; pass++) applyGraphForces(sim, { center: 0, repel: 5, linkForce: half, linkDistance: 80 });
    expect(nodes.map((n) => [n.x, n.y])).toEqual(before);
    expect(sim.alpha()).toBe(alpha);
    expect((sim.force("charge") as ForceManyBody<Node>).strength()(nodes[0], 0, nodes)).toBe(-125);
    expect((sim.force("x") as ForceX<Node>).strength()(nodes[0], 0, nodes)).toBe(0);
    expect(link.distance()(all[0], 0, all)).toBe(80);
    // Hub link: 0.5 / min(59, 2); repeated retunes must not multiply the factor.
    expect(link.strength()(all[9], 9, all)).toBeCloseTo(0.5 / 2, 12);
    applyGraphForces(sim, { ...GRAPH_FORCE_DEFAULTS, linkForce: 0 });
    expect(link.strength()(all[0], 0, all)).toBe(0);
  });
});

describe("graph seeding", () => {
  it("places unlinked nodes in a disc sized for the node count and linked nodes near placed neighbours", () => {
    const fresh: Node[] = Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`, degree: 0 }));
    seedGraphNodes(fresh, new Map(), new Map(), seededRandom(7));
    const limit = Math.sqrt((3600 * 400) / Math.PI);
    let far = 0;
    for (const n of fresh) {
      expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
      expect([n.vx, n.vy, n.fx, n.fy]).toEqual([0, 0, null, null]);
      far = Math.max(far, Math.hypot(n.x!, n.y!));
    }
    expect(far).toBeLessThanOrEqual(limit + 1e-6);
    expect(far).toBeGreaterThan(limit * 0.9);

    // Later data: a linked node lands near its placed neighbour, an unlinked
    // one in the ring outside the placed graph.
    const placed = new Map(fresh.map((n) => [n.id, n]));
    const anchor = fresh[10];
    const linked: Node = { id: "linked", degree: 1 };
    const loose: Node = { id: "loose", degree: 0 };
    seedGraphNodes([linked, loose], placed, new Map([["linked", new Set([anchor.id])]]), seededRandom(9));
    const spread = Math.sqrt(3600 * 2);
    expect(Math.abs(linked.x! - anchor.x!)).toBeLessThanOrEqual(spread / 2);
    expect(Math.abs(linked.y! - anchor.y!)).toBeLessThanOrEqual(spread / 2);
    expect(Math.hypot(loose.x!, loose.y!)).toBeGreaterThanOrEqual(far - 1e-6);
    // Placed nodes never move.
    expect(placed.get(anchor.id)).toBe(anchor);
  });

  it("seeds the same graph the same way every time", () => {
    const a = graphData();
    const b = graphData();
    seedGraphNodes(a.nodes, new Map(), a.neighbors, seededRandom(160));
    seedGraphNodes(b.nodes, new Map(), b.neighbors, seededRandom(160));
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
  });
});

describe("graph open warm-up", () => {
  it("anneals from alpha 1 to the open alpha in the warm ticks, leaves a short tail, and returns to the standard decay on reheat", () => {
    for (const count of [50, 500, 1500]) {
      const { ticks, openAlpha } = graphOpenWarmup(count);
      const nodes: Node[] = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, degree: 0 }));
      seedGraphNodes(nodes, new Map(), new Map(), seededRandom(3));
      const sim = createGraphSimulation<Node, Link>(nodes, [], GRAPH_FORCE_DEFAULTS);
      let ticked = 0;
      const tick = sim.tick.bind(sim);
      sim.tick = ((n?: number) => { ticked += n ?? 1; return tick(n); }) as typeof sim.tick;
      warmGraphSimulation(sim, count);
      expect(ticked).toBe(ticks);
      expect(sim.alpha()).toBe(openAlpha);
      expect(openAlpha).toBeLessThanOrEqual(0.2);
      // The visible tail reaches rest in under 90 frames.
      let tail = 0;
      while (sim.alpha() > GRAPH_SETTLED_ALPHA && tail < 300) { tick(); tail++; }
      expect(tail).toBeLessThan(90);
      // Any later reheat runs at the standard decay and never lowers alpha.
      expect(reheatGraphSimulation(sim).alpha()).toBe(GRAPH_REHEAT_ALPHA);
      expect(sim.alphaDecay()).toBeCloseTo(1 - Math.pow(0.001, 1 / 300), 12);
      sim.alpha(0.9);
      expect(reheatGraphSimulation(sim).alpha()).toBe(0.9);
    }
  });

  it("opens a linked graph laid out: finite, spread at Obsidian's scale and without overlap", () => {
    const { sim, nodes } = graphSim();
    for (const n of nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
    const spread = (list: Node[]) => Math.sqrt(list.reduce((sum, n) => sum + n.x! ** 2 + n.y! ** 2, 0) / list.length);
    const painted = nodes.map((n) => [n.x!, n.y!]);
    const paintedSpread = spread(nodes);
    // Run the visible tail to rest.
    let ticks = 0;
    while (sim.alpha() > GRAPH_SETTLED_ALPHA && ticks < 400) { sim.tick(); ticks++; }
    expect(ticks).toBeLessThan(90);
    // The first painted frame is already the layout: the tail moves a node by
    // a small fraction of the graph's spread.
    const drift = nodes.reduce((sum, n, i) => sum + Math.hypot(n.x! - painted[i][0], n.y! - painted[i][1]), 0) / nodes.length;
    expect(drift).toBeLessThan(paintedSpread * 0.05);
    // And it is the layout Obsidian's full 300-tick settle reaches from the same seed.
    const reference = graphData();
    seedGraphNodes(reference.nodes, new Map(), reference.neighbors, seededRandom(reference.nodes.length));
    const full = createGraphSimulation<Node, Link>(reference.nodes, reference.links, GRAPH_FORCE_DEFAULTS);
    full.alpha(1).tick(300);
    expect(Math.abs(spread(nodes) / spread(reference.nodes) - 1)).toBeLessThan(0.1);
    const hub = nodes[0];
    const leafDistance = nodes.slice(1, 60).map((n) => Math.hypot(n.x! - hub.x!, n.y! - hub.y!));
    const mean = leafDistance.reduce((sum, d) => sum + d, 0) / leafDistance.length;
    // A 59-leaf hub's springs are weak (1/59 at the hub end); leaves sit well beyond the 250 rest length.
    expect(mean).toBeGreaterThan(250);
    expect(mean).toBeLessThan(1500);
    // The soft 60-unit collision keeps every pair further apart than two default node radii.
    let closest = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        closest = Math.min(closest, Math.hypot(nodes[i].x! - nodes[j].x!, nodes[i].y! - nodes[j].y!));
      }
    }
    expect(closest).toBeGreaterThan(nodeRadius(hub) + nodeRadius(nodes[1]));
  });
});

describe("graph drag physics session", () => {
  it("follows the same drag, release and settle path as the main-thread simulation", () => {
    const { sim, nodes } = graphSim();
    const hub = nodes[0];
    hub.fx = hub.x;
    hub.fy = hub.y;
    const init = snapshotGraphPhysics(sim, { grab: hub });
    const session = new GraphPhysicsSession(structuredClone(init));

    // Main-thread drag semantics from GraphView: reheat to the drag target, one tick per frame.
    reheatGraphSimulation(sim).alphaTarget(GRAPH_REHEAT_ALPHA);
    for (let f = 1; f <= 40; f++) {
      hub.fx = hub.x! + 3;
      hub.fy = hub.y! + 1;
      session.move(0, hub.fx, hub.fy);
      sim.tick();
      session.step();
    }
    const expectSame = () => {
      const state = session.state();
      nodes.forEach((n, i) => {
        expect(state[i * 4]).toBeCloseTo(n.x!, 6);
        expect(state[i * 4 + 1]).toBeCloseTo(n.y!, 6);
      });
      expect(session.sim.alpha()).toBeCloseTo(sim.alpha(), 12);
    };
    expectSame();
    expect(session.settled).toBe(false);
    // A drag holds alpha at its target: the neighbourhood keeps following.
    expect(sim.alpha()).toBeCloseTo(GRAPH_REHEAT_ALPHA, 6);

    hub.fx = null;
    hub.fy = null;
    sim.alphaTarget(0);
    session.release(0);
    let steps = 0;
    while (!session.settled && steps < 500) {
      sim.tick();
      session.step();
      steps++;
    }
    expect(session.settled).toBe(true);
    expect(sim.alpha()).toBeLessThanOrEqual(GRAPH_SETTLED_ALPHA);
    expectSame();
  });

  it("warms up in the worker to exactly the main-thread open layout", () => {
    const main = graphData(), copy = graphData();
    for (const g of [main, copy]) seedGraphNodes(g.nodes, new Map(), g.neighbors, seededRandom(g.nodes.length));
    const sim = createGraphSimulation<Node, Link>(main.nodes, main.links, GRAPH_FORCE_DEFAULTS);
    warmGraphSimulation(sim, main.nodes.length);
    // Worker path: snapshot the unwarmed simulation, warm the session, copy back.
    const pending = createGraphSimulation<Node, Link>(copy.nodes, copy.links, GRAPH_FORCE_DEFAULTS);
    const session = new GraphPhysicsSession(structuredClone(snapshotGraphPhysics(pending, { grab: null })));
    warmGraphSimulation(session.sim, copy.nodes.length);
    const state = session.state();
    copy.nodes.forEach((n, i) => { n.x = state[i * 4]; n.y = state[i * 4 + 1]; n.vx = state[i * 4 + 2]; n.vy = state[i * 4 + 3]; });
    finishGraphWarmup(pending, copy.nodes.length);
    main.nodes.forEach((n, i) => {
      expect(Object.is(n.x, copy.nodes[i].x) && Object.is(n.y, copy.nodes[i].y) && Object.is(n.vx, copy.nodes[i].vx), `node ${i}`).toBe(true);
    });
    expect(pending.alpha()).toBe(sim.alpha());
    expect(pending.alphaDecay()).toBe(sim.alphaDecay());
  });

  it("orders replay links by admission so each batch's links are a prefix", () => {
    const order = [{ id: "c" }, { id: "a" }, { id: "b" }];
    const links = [{ source: "a", target: "b" }, { source: "c", target: "a" }, { source: "b", target: "x" }, { source: "c", target: "b" }];
    const { links: sorted, admitAt } = replayLinkOrder(order, links);
    expect(sorted.map((l) => `${l.source}${l.target}`)).toEqual(["ca", "ab", "cb"]);
    expect([...admitAt]).toEqual([2, 3, 3]);
    expect([0, 1, 2, 3].map((n) => replayLinkCount(admitAt, n))).toEqual([0, 0, 1, 3]);
  });

  it("replays in the worker exactly as the main-thread replay simulation", () => {
    const { nodes, links, neighbors } = graphData();
    seedGraphNodes(nodes, new Map(), neighbors, seededRandom(nodes.length));
    const order = [...nodes];
    const { links: sorted, admitAt } = replayLinkOrder(order, links);
    const rank = new Map(order.map((n, i) => [n.id, i]));
    const pairs = Int32Array.from(sorted.flatMap((l) => [rank.get(String(l.source))!, rank.get(String(l.target))!]));
    const worker = new GraphReplaySession(order.map((n) => n.id), pairs, admitAt, GRAPH_FORCE_DEFAULTS);
    const main = createGraphSimulation<Node, Link>([], [], GRAPH_FORCE_DEFAULTS);
    let admitted = 0;
    for (const count of [40, 100, 160]) {
      const seeds = new Float64Array((count - admitted) * 4);
      for (let i = admitted; i < count; i++) seeds.set([order[i].x!, order[i].y!, 0, 0], (i - admitted) * 4);
      for (let i = admitted; i < count; i++) { order[i].vx = 0; order[i].vy = 0; }
      worker.admit(count, seeds);
      const link = main.force("link") as ForceLink<Node, Link>;
      link.links([]);
      main.nodes(order.slice(0, count));
      link.links(sorted.slice(0, replayLinkCount(admitAt, count)));
      reheatGraphSimulation(main).stop();
      admitted = count;
      for (let t = 0; t < 20; t++) { main.tick(); worker.step(); }
      const state = worker.state();
      order.slice(0, count).forEach((n, i) => expect(Object.is(state[i * 4], n.x) && Object.is(state[i * 4 + 1], n.y), `node ${i} at ${count}`).toBe(true));
    }
  });

  it("keeps fixed nodes, link endpoints and per-node force values in the snapshot", () => {
    const { sim, nodes } = graphSim();
    nodes[5].fx = 10;
    nodes[5].fy = 20;
    const init = snapshotGraphPhysics(sim, { grab: null });
    expect(init.grab).toBe(-1);
    expect([init.fixed[10], init.fixed[11]]).toEqual([10, 20]);
    expect(Number.isNaN(init.fixed[0])).toBe(true);
    expect(init.links.length).toBe(2 * 99);
    expect([init.links[0], init.links[1]]).toEqual([0, 1]);
    expect(init.charge[3]).toBe(-1000);
    expect(init.chargeDistanceMin).toBe(30);
    expect(init.collideRadius[0]).toBe(60);
    expect(init.xStrength[0]).toBeCloseTo(0.1, 12);
    expect(init.linkDistance[0]).toBe(250);
    // Degree-scaled: each link's strength is 1 / min(link count of its two ends).
    expect(init.linkStrength[0]).toBeCloseTo(1 / Math.min(nodes[0].degree, nodes[1].degree), 12);
    const session = new GraphPhysicsSession(init);
    session.step();
    expect(session.nodes[5].x).toBe(10);
    expect(session.nodes[5].y).toBe(20);
  });
});

describe("graph physics session node indexes", () => {
  it("ignores grab, move and release messages that do not name an in-range node", () => {
    const { sim } = graphSim();
    const session = new GraphPhysicsSession(snapshotGraphPhysics(sim, { grab: null }));
    const invalid = ["__proto__", "constructor", -1, 1.5, session.nodes.length] as unknown as number[];
    for (const index of invalid) {
      session.grab(index, 1, 2);
      session.move(index, 3, 4);
      session.release(index);
    }
    expect(session.grabbing).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(Array.prototype, "fx")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(Array, "fx")).toBe(false);
    expect(session.nodes.every((node) => node.fx == null)).toBe(true);
  });
});

describe("graph settle session with idle overlap cleanup", () => {
  it("matches GraphView's frame order: tick while hot, resolve overlaps at low alpha, settle when nothing moves", () => {
    const { sim, nodes } = graphSim();
    // Enlarged nodes: the 60-unit collision no longer covers them, so the idle cleanup has work.
    const r = (n: Node) => nodeRadius(n, 4);
    const init = snapshotGraphPhysics(sim, {
      grab: null,
      overlap: { gap: 8, radius: r, phase: (n) => phaseFromId(n.id) },
    });
    const session = new GraphPhysicsSession(structuredClone(init));
    // Main-thread reference: the GraphView frame loop without a worker.
    let resolved = false;
    let cleaned = 0;
    for (let frame = 0; frame < 2000; frame++) {
      if (sim.alpha() > GRAPH_SETTLED_ALPHA) {
        sim.tick();
        resolved = false;
      }
      if (sim.alpha() <= GRAPH_OVERLAP_ALPHA && !resolved) {
        const moved = resolveOverlaps(nodes as never, r as never, 8, 2);
        if (moved) cleaned++;
        resolved = !moved;
      }
      session.step();
      if (resolved && sim.alpha() <= GRAPH_SETTLED_ALPHA) break;
      expect(session.settled).toBe(false);
    }
    expect(cleaned).toBeGreaterThan(0);
    expect(session.settled).toBe(true);
    const state = session.state();
    nodes.forEach((n, i) => {
      expect(state[i * 4]).toBeCloseTo(n.x!, 9);
      expect(state[i * 4 + 1]).toBeCloseTo(n.y!, 9);
    });
  });

  it("transfers every snapshot buffer to the worker instead of copying it", () => {
    const { sim } = graphSim();
    const init = snapshotGraphPhysics(sim, {
      grab: null,
      overlap: { gap: 8, radius: () => 3, phase: () => 0 },
    });
    const buffers = graphPhysicsTransferables(init);
    const arrays = Object.values(init).filter(ArrayBuffer.isView).concat([init.overlap!.radius, init.overlap!.phase]);
    expect(new Set(buffers)).toEqual(new Set(arrays.map((a) => (a as Float64Array).buffer)));
    const channel = new MessageChannel();
    channel.port1.postMessage(init, buffers);
    expect(init.state.byteLength).toBe(0);
    channel.port1.close();
    channel.port2.close();
  });
});
