import { describe, expect, it } from "vitest";
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type ForceCollide,
  type Simulation,
} from "d3-force";
import { GraphPhysicsSession, GRAPH_SETTLED_ALPHA, graphPhysicsTransferables, snapshotGraphPhysics } from "./graphPhysics";
import { phaseFromId, resolveOverlaps } from "../components/graphGeometry";

type Node = { id: string; degree: number; x?: number; y?: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null };
type Link = { source: string | Node; target: string | Node };

// GraphView's force shape: accessor-driven per-node and per-link values.
function graphSim(): { sim: Simulation<Node, Link>; nodes: Node[] } {
  const nodes: Node[] = Array.from({ length: 160 }, (_, i) => ({ id: `n${i}`, degree: 0 }));
  const links: Link[] = [];
  for (let i = 1; i < 60; i++) links.push({ source: "n0", target: `n${i}` });
  for (let i = 60; i < 100; i++) links.push({ source: `n${i}`, target: `n${i - 50}` });
  for (const l of links) {
    nodes[+String(l.source).slice(1)].degree++;
    nodes[+String(l.target).slice(1)].degree++;
  }
  nodes.forEach((n, i) => {
    n.x = 400 + Math.cos(i * 2.4) * (40 + i * 2);
    n.y = 300 + Math.sin(i * 2.4) * (40 + i * 2);
  });
  const r = (n: Node) => Math.min(24, 2.4 + 1.75 * Math.sqrt(n.degree));
  const sim = forceSimulation<Node, Link>(nodes)
    .force("charge", forceManyBody<Node>().strength(() => -180).distanceMax(1100).theta(0.9))
    .force(
      "link",
      forceLink<Node, Link>(links)
        .id((d) => d.id)
        .distance((l) => r(l.source as Node) + r(l.target as Node) + 25)
        .strength((l) => 1 / Math.max(1, Math.min((l.source as Node).degree, (l.target as Node).degree)))
    )
    .force("center", forceCenter(400, 300).strength(0.05))
    .force("collide", forceCollide<Node>().radius((n) => r(n) + 6).strength(1).iterations(3))
    .force("x", forceX<Node>(400).strength(() => 0.02))
    .force("y", forceY<Node>(300).strength(() => 0.02))
    .velocityDecay(0.4)
    .alphaDecay(0.06)
    .alpha(0.85)
    .stop();
  sim.tick(40);
  return { sim, nodes };
}

describe("graph drag physics session", () => {
  it("follows the same drag, release and settle path as the main-thread simulation", () => {
    const { sim, nodes } = graphSim();
    const hub = nodes[0];
    hub.fx = hub.x;
    hub.fy = hub.y;
    const init = snapshotGraphPhysics(sim, { collideIterations: 3, velocityCap: 5, doubleTickBelow: 650, grab: hub });
    const session = new GraphPhysicsSession(structuredClone(init));

    // Main-thread drag semantics from GraphView: reheat, one collide pass, cap neighbours.
    sim.alpha(Math.max(sim.alpha(), 0.3)).alphaTarget(0.3);
    const collide = sim.force("collide") as ForceCollide<Node>;
    collide.iterations(1);
    for (let f = 1; f <= 40; f++) {
      hub.fx = hub.x! + 3;
      hub.fy = hub.y! + 1;
      session.move(0, hub.fx, hub.fy);
      sim.tick();
      for (const n of nodes) {
        if (n === hub) continue;
        n.vx = Math.max(-5, Math.min(n.vx!, 5));
        n.vy = Math.max(-5, Math.min(n.vy!, 5));
      }
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

    hub.fx = null;
    hub.fy = null;
    sim.alphaTarget(0);
    collide.iterations(3);
    session.release(0);
    let steps = 0;
    while (!session.settled && steps < 500) {
      sim.tick(sim.alpha() > 0.06 && nodes.length < 650 ? 2 : 1);
      session.step();
      steps++;
    }
    expect(session.settled).toBe(true);
    expect(sim.alpha()).toBeLessThanOrEqual(0.004);
    expectSame();
  });

  it("keeps fixed nodes, link endpoints and per-node force values in the snapshot", () => {
    const { sim, nodes } = graphSim();
    nodes[5].fx = 10;
    nodes[5].fy = 20;
    const init = snapshotGraphPhysics(sim, { collideIterations: 3, velocityCap: 5, doubleTickBelow: 650, grab: null });
    expect(init.grab).toBe(-1);
    expect([init.fixed[10], init.fixed[11]]).toEqual([10, 20]);
    expect(Number.isNaN(init.fixed[0])).toBe(true);
    expect(init.links.length).toBe(2 * 99);
    expect([init.links[0], init.links[1]]).toEqual([0, 1]);
    expect(init.charge[3]).toBe(-180);
    expect(init.collideRadius[0]).toBeCloseTo(Math.min(24, 2.4 + 1.75 * Math.sqrt(nodes[0].degree)) + 6);
    const session = new GraphPhysicsSession(init);
    session.step();
    expect(session.nodes[5].x).toBe(10);
    expect(session.nodes[5].y).toBe(20);
  });
});

describe("graph physics session node indexes", () => {
  it("ignores grab, move and release messages that do not name an in-range node", () => {
    const { sim } = graphSim();
    const session = new GraphPhysicsSession(
      snapshotGraphPhysics(sim, { collideIterations: 3, velocityCap: 5, doubleTickBelow: 650, grab: null }),
    );
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
  it("matches GraphView's frame order: tick while hot, resolve overlaps below 0.02, settle when nothing moves", () => {
    const { sim, nodes } = graphSim();
    sim.alpha(0.12);
    const r = (n: Node) => Math.min(24, 2.4 + 1.75 * Math.sqrt(n.degree));
    const init = snapshotGraphPhysics(sim, {
      collideIterations: 3, velocityCap: 5, doubleTickBelow: 650, grab: null,
      overlap: { gap: 8, radius: r, phase: (n) => phaseFromId(n.id) },
    });
    const session = new GraphPhysicsSession(structuredClone(init));
    // Main-thread reference: the GraphView frame loop without a worker.
    let resolved = false;
    for (let frame = 0; frame < 2000; frame++) {
      if (sim.alpha() > GRAPH_SETTLED_ALPHA) {
        sim.tick(nodes.length < 650 && sim.alpha() > 0.06 ? 2 : 1);
        resolved = false;
      }
      if (sim.alpha() <= 0.02 && !resolved) resolved = !resolveOverlaps(nodes as never, r as never, 8, 2);
      session.step();
      if (resolved && sim.alpha() <= GRAPH_SETTLED_ALPHA) break;
      expect(session.settled).toBe(false);
    }
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
      collideIterations: 3, velocityCap: 5, doubleTickBelow: 650, grab: null,
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
