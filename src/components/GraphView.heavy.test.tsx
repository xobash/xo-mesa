// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Simulation } from "d3-force";
import type { GraphNode, GraphLink, VaultFile } from "../types";
import { useAppStore } from "../store";
import { buildNotes } from "../lib/graph";
import { GraphView } from "./GraphView";
import { GraphPhysicsSession, warmGraphSimulation, type GraphPhysicsInit } from "../lib/graphPhysics";
import { clearGraphLayoutCache, indexedDbLayoutStore, setGraphLayoutStore } from "../lib/graphLayoutCache";


const captured = vi.hoisted(() => ({ sim: null as unknown }));
vi.mock("d3-force", async (original) => {
  const actual = await original<typeof import("d3-force")>();
  return { ...actual, forceSimulation: (...args: Parameters<typeof actual.forceSimulation>) => {
    const sim = actual.forceSimulation(...args);
    captured.sim = sim;
    return sim;
  } };
});
/** Answer an open warm-up exactly as graphPhysics.worker.ts does. */
function answerWarm(worker: { onmessage: ((event: { data: unknown }) => void) | null }, message: { type: string; session: number; init?: unknown; count?: number; startAlpha?: number }): boolean {
  if (message.type !== "warm") return false;
  // The worker's own simulation must not replace the captured GraphView one.
  const shown = captured.sim;
  const session = new GraphPhysicsSession(message.init as GraphPhysicsInit);
  captured.sim = shown;
  warmGraphSimulation(session.sim, message.count!, message.startAlpha);
  worker.onmessage!({ data: { type: "warmed", session: message.session, state: session.state(), alpha: session.sim.alpha() } });
  return true;
}
/** Run a heavy open's deferred steps (layout cache or seeding, then the worker warm-up). */
async function openSteps(): Promise<void> {
  // The layout-reuse lookup may await storage between steps.
  for (let i = 0; i < 8; i++) await act(async () => { vi.advanceTimersByTime(1); });
}
vi.mock("./PreviewCard", () => ({ PreviewCard: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const initial = useAppStore.getState();
const simulation = () => captured.sim as Simulation<GraphNode, GraphLink>;
beforeEach(() => {
  clearGraphLayoutCache();
  // Heavy-open steps hand off through nextTask; its timer fallback runs on the fake clock.
  vi.stubGlobal("MessageChannel", undefined);
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  setGraphLayoutStore(indexedDbLayoutStore);
  act(() => root.unmount()); host.remove();
  useAppStore.setState(initial, true);
  simulation()?.stop();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
it("settles heavy graphs in the worker with overlap cleanup and transferred buffers", async () => {
  const posted: { message: { type: string; session: number; init?: { grab: number; overlap?: { gap: number } } }; transfer?: unknown[] }[] = [];
  const workers: { onmessage: ((event: { data: unknown }) => void) | null }[] = [];
  vi.stubGlobal("Worker", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { workers.push(this); }
    postMessage(message: (typeof posted)[number]["message"], transfer?: unknown[]) { if (!answerWarm(this, message)) posted.push({ message, transfer }); }
    terminate() {}
  });
  const frames = () => (requestAnimationFrame as unknown as { mock: { calls: [FrameRequestCallback][] } }).mock.calls;
  const runFrame = () => act(() => frames()[frames().length - 1][0](performance.now()));
  // 2,100 nodes cross the worker settle threshold; links on about 200 of them
  // keep the fixture's own build and layout cost small.
  const entries = Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [`Note-${i}.md`, i % 10 === 1 ? `[[Note-${(i * 7) % 2100}]]` : ""]));
  const files: VaultFile[] = Object.keys(entries).map((relPath) => ({ path: `/demo/${relPath}`, relPath, name: relPath.slice(0, -3), ext: "md", isMarkdown: true }));
  act(() => {
    useAppStore.setState({ files, notes: buildNotes(files, new Map(Object.entries(entries))),
      settings: { ...initial.settings, graphShowTags: false, graphShowOrphans: true, animations: false } });
    root.render(<GraphView />);
  });
  await openSteps();
  const sim = simulation();
  expect(sim.alpha()).toBeGreaterThan(0.001);
  const tick = vi.spyOn(sim, "tick");
  runFrame();
  const start = posted.find((p) => p.message.type === "start")!;
  expect(start.message.init).toMatchObject({ grab: -1, overlap: { gap: 8 } });
  expect(start.transfer?.length).toBeGreaterThan(5);
  expect(tick).not.toHaveBeenCalled();
  const nodes = sim.nodes();
  const state = new Float64Array(nodes.length * 4);
  nodes.forEach((n, i) => { state[i * 4] = n.x! + 3; state[i * 4 + 1] = n.y!; });
  const first = nodes[0].x!;
  act(() => workers[0].onmessage!({ data: { type: "idle", session: start.message.session, state, alpha: 0.0005 } }));
  runFrame();
  expect(nodes[0].x).toBeCloseTo(first + 3);
  expect(posted.at(-1)!.message).toMatchObject({ type: "stop", session: start.message.session });
  runFrame();
  expect(tick).not.toHaveBeenCalled();
  expect(posted.filter((p) => p.message.type === "start")).toHaveLength(1);
}, 30000);
it("restarts a heavy worker settle with the new radii when node size changes mid-settle", async () => {
  type Start = { type: string; session: number; init?: { overlap?: { radius: Float64Array } } };
  const posted: Start[] = [];
  vi.stubGlobal("Worker", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    postMessage(message: Start) { if (!answerWarm(this, message)) posted.push(message); }
    terminate() {}
  });
  const frames = () => (requestAnimationFrame as unknown as { mock: { calls: [FrameRequestCallback][] } }).mock.calls;
  const runFrame = () => act(() => frames()[frames().length - 1][0](performance.now()));
  const files: VaultFile[] = Array.from({ length: 2100 }, (_, i) => ({ path: `/demo/N${i}.md`, relPath: `N${i}.md`, name: `N${i}`, ext: "md", isMarkdown: true }));
  act(() => {
    useAppStore.setState({ files, notes: buildNotes(files, new Map(files.map((f) => [f.relPath, ""]))),
      settings: { ...initial.settings, graphShowTags: false, graphShowOrphans: true, animations: false } });
    root.render(<GraphView />);
  });
  await openSteps();
  runFrame();
  const first = posted.find((p) => p.type === "start")!;
  act(() => useAppStore.setState({ settings: { ...useAppStore.getState().settings, graphNodeSize: 2 } }));
  expect(posted.at(-1)).toMatchObject({ type: "stop", session: first.session });
  runFrame();
  const second = posted.filter((p) => p.type === "start").at(-1)!;
  expect(second.session).toBeGreaterThan(first.session);
  expect(second.init!.overlap!.radius[0]).toBeCloseTo(first.init!.overlap!.radius[0] * 2);
}, 30000);
it("turns on All files in a 4,165-file vault in place: one simulation, every file, settled in the worker", async () => {
  const posted: { type: string }[] = [];
  vi.stubGlobal("Worker", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    postMessage(message: { type: string; session: number }) { if (!answerWarm(this, message)) posted.push(message); }
    terminate() {}
  });
  const frames = () => (requestAnimationFrame as unknown as { mock: { calls: [FrameRequestCallback][] } }).mock.calls;
  const kinds = ["png", "pdf", "docx", "mp3", "zip", "bin", "", "csv"];
  const files: VaultFile[] = Array.from({ length: 4165 }, (_, i) => {
    const ext = i < 2300 ? "md" : kinds[i % kinds.length];
    const name = `f${i}`;
    const relPath = `d${i % 31}/${name}${ext ? `.${ext}` : ""}`;
    return { path: `/v/${relPath}`, relPath, name, ext, isMarkdown: ext === "md" };
  });
  // Three in four notes embed a file; the rest are orphans.
  const text = new Map(files.filter((f) => f.ext === "md").map((f, i) => [f.relPath, i % 4 ? `![[${files[2300 + (i % 1865)].relPath}]]` : ""]));
  act(() => {
    useAppStore.setState({ files, notes: buildNotes(files, text),
      settings: { ...initial.settings, graphShowTags: false, graphShowOrphans: false, graphShowAttachments: false, animations: false } });
    root.render(<GraphView />);
  });
  await openSteps();
  const sim = simulation();
  expect(sim.nodes().length).toBeLessThan(files.length);
  act(() => useAppStore.getState().setSetting("graphShowAllFiles", true));
  expect(simulation()).toBe(sim);
  expect(sim.nodes().map((n) => n.id).sort()).toEqual(files.map((f) => f.relPath).sort());
  act(() => frames()[frames().length - 1][0](performance.now()));
  expect(posted.some((m) => m.type === "start")).toBe(true);
}, 30000);

it("warms a large graph in the worker: the frame never runs warm ticks, nothing draws until the same layout returns", async () => {
  const warms: { type: string; session: number; init?: unknown; count?: number }[] = [];
  const workers: { onmessage: ((event: { data: unknown }) => void) | null }[] = [];
  vi.stubGlobal("Worker", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { workers.push(this); }
    postMessage(message: { type: string; session: number }) { if (message.type === "warm") warms.push(message); }
    terminate() {}
  });
  const entries = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`N${i}.md`, i % 3 ? `[[N${(i * 7) % 1200}]]` : ""]));
  const files: VaultFile[] = Object.keys(entries).map((relPath) => ({ path: `/demo/${relPath}`, relPath, name: relPath.slice(0, -3), ext: "md", isMarkdown: true }));
  act(() => {
    useAppStore.setState({ files, notes: buildNotes(files, new Map(Object.entries(entries))),
      settings: { ...initial.settings, graphShowTags: false, graphShowOrphans: true, animations: false } });
    root.render(<GraphView />);
  });
  // The render returns before seeding or the simulation: the pane paints first.
  expect(warms).toHaveLength(0);
  expect(host.textContent).toContain("Laying out 1,200 nodes");
  await openSteps();
  // The open returned without laying out: the worker holds the warm-up.
  expect(warms).toHaveLength(1);
  expect(warms[0].count).toBe(1200);
  expect(host.textContent).toContain("Laying out 1,200 nodes");
  const pending = simulation();
  expect(pending.alpha()).toBe(1);
  // The worker answers with the warmed layout (bit-identical: graphPhysics.test.ts).
  act(() => { answerWarm(workers[0], warms[0]); });
  expect(host.textContent).not.toContain("Laying out");
  const shown = simulation().nodes();
  expect(shown).toHaveLength(1200);
  expect(shown.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  expect(simulation().alpha()).toBeCloseTo(0.12, 12);
  // Reopening the same graph in this window reuses the layout: no warm-up at all.
  const positions = shown.map((n) => [n.x, n.y]);
  act(() => root.unmount());
  root = createRoot(host);
  act(() => root.render(<GraphView />));
  await openSteps();
  expect(warms).toHaveLength(1);
  expect(host.textContent).not.toContain("Laying out");
  expect(simulation().nodes().map((n) => [n.x, n.y])).toEqual(positions);
  expect(simulation().alpha()).toBeCloseTo(0.12, 12);
}, 30000);

it("replays a heavy graph with worker physics: batches admit in the worker, the frame never ticks, the full graph returns", async () => {
  const posted: { type: string; session: number; ids?: string[]; count?: number; seeds?: Float64Array }[] = [];
  const workers: { onmessage: ((event: { data: unknown }) => void) | null }[] = [];
  vi.stubGlobal("Worker", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { workers.push(this); }
    postMessage(message: (typeof posted)[number]) { if (!answerWarm(this, message)) posted.push(message); }
    terminate() {}
  });
  const frames = () => (requestAnimationFrame as unknown as { mock: { calls: [FrameRequestCallback][] } }).mock.calls;
  const runFrame = () => act(() => frames()[frames().length - 1][0](performance.now()));
  const entries = Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [`N${i}.md`, i % 4 ? `[[N${(i * 13) % 2100}]]` : ""]));
  const files: VaultFile[] = Object.keys(entries).map((relPath, i) => ({ path: `/demo/${relPath}`, relPath, name: relPath.slice(0, -3), ext: "md", isMarkdown: true, createdAt: 1000 + i }));
  act(() => {
    useAppStore.setState({ files, notes: buildNotes(files, new Map(Object.entries(entries))),
      settings: { ...initial.settings, graphShowTags: false, graphShowOrphans: true, animations: false } });
    root.render(<GraphView />);
  });
  await openSteps();
  const sim = simulation();
  const tick = vi.spyOn(sim, "tick");
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Start timelapse animation"]')!.click());
  const replay = posted.find((m) => m.type === "replay")!;
  expect(replay.ids).toHaveLength(2100);
  act(() => { vi.advanceTimersByTime(1000); });
  const admits = posted.filter((m) => m.type === "admit" && m.session === replay.session);
  expect(admits.length).toBeGreaterThan(5);
  const last = admits.at(-1)!;
  // Admits grow and carry seeds for exactly the new nodes.
  expect(admits.reduce((sum, m) => sum + m.seeds!.length / 4, 0)).toBe(last.count);
  // The worker's state lands on the admitted nodes; the frame runs no tick.
  const state = new Float64Array(last.count! * 4).fill(7);
  act(() => workers[0].onmessage!({ data: { type: "state", session: replay.session, state, alpha: 0.2 } }));
  runFrame();
  expect(tick).not.toHaveBeenCalled();
  // The first admitted node (earliest created) took the worker's position.
  const first = sim.nodes().find((n) => n.id === "N0.md")!;
  expect([first.x, first.y]).toEqual([7, 7]);
  // The main simulation keeps the full graph; only the worker holds the replay.
  expect(sim.nodes()).toHaveLength(2100);
  act(() => { vi.advanceTimersByTime(8000); });
  expect(posted.some((m) => m.type === "stop" && m.session === replay.session)).toBe(true);
  expect(sim.nodes()).toHaveLength(2100);
  expect(host.querySelector('[aria-label="Start timelapse animation"]')).not.toBeNull();
}, 30000);

it("shows a heavy graph laid out in an earlier session at once, without waiting for the worker", async () => {
  const saved = new Map<string, Float64Array>();
  setGraphLayoutStore({ get: async (key) => saved.get(key) ?? null, put: async (key, state) => void saved.set(key, state) });
  const warms: { type: string; session: number; init?: unknown; count?: number }[] = [];
  const workers: { onmessage: ((event: { data: unknown }) => void) | null }[] = [];
  vi.stubGlobal("Worker", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { workers.push(this); }
    postMessage(message: { type: string; session: number }) { if (message.type === "warm") warms.push(message); }
    terminate() {}
  });
  const entries = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`P${i}.md`, i % 2 ? `[[P${(i * 3) % 1100}]]` : ""]));
  const files: VaultFile[] = Object.keys(entries).map((relPath) => ({ path: `/demo/${relPath}`, relPath, name: relPath.slice(0, -3), ext: "md", isMarkdown: true }));
  const mount = () => act(() => {
    useAppStore.setState({ files, notes: buildNotes(files, new Map(Object.entries(entries))),
      settings: { ...initial.settings, graphShowTags: false, graphShowOrphans: true, animations: false } });
    root.render(<GraphView />);
  });
  // First session: the worker lays it out and the layout is saved.
  mount();
  await openSteps();
  await act(async () => { answerWarm(workers[0], warms[0]); await Promise.resolve(); });
  const positions = simulation().nodes().map((n) => [n.x, n.y]);
  expect(saved.size).toBe(1);
  // A new session (empty memory cache): the saved layout shows before any worker answer.
  act(() => root.unmount());
  clearGraphLayoutCache();
  root = createRoot(host);
  mount();
  expect(host.textContent).toContain("Laying out");
  await openSteps();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(warms).toHaveLength(2);
  expect(host.textContent).not.toContain("Laying out");
  expect(simulation().nodes().map((n) => [n.x, n.y])).toEqual(positions);
}, 30000);

it("reopens a heavy graph after a small change from its last layout: kept nodes stay, the warm-up starts at alpha 0.3", async () => {
  const warms: { type: string; session: number; init?: GraphPhysicsInit; count?: number; startAlpha?: number }[] = [];
  const workers: { onmessage: ((event: { data: unknown }) => void) | null }[] = [];
  vi.stubGlobal("Worker", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { workers.push(this); }
    postMessage(message: { type: string; session: number }) { if (message.type === "warm") warms.push(message); }
    terminate() {}
  });
  const entries: Record<string, string> = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`R${i}.md`, i % 3 ? `[[R${(i * 7) % 1200}]]` : ""]));
  const mount = () => act(() => {
    const files: VaultFile[] = Object.keys(entries).map((relPath) => ({ path: `/demo/${relPath}`, relPath, name: relPath.slice(0, -3), ext: "md", isMarkdown: true }));
    useAppStore.setState({ files, notes: buildNotes(files, new Map(Object.entries(entries))),
      settings: { ...initial.settings, graphShowTags: false, graphShowOrphans: true, animations: false } });
    root.render(<GraphView />);
  });
  mount();
  await openSteps();
  expect(warms[0].startAlpha ?? 1).toBe(1);
  act(() => { answerWarm(workers[0], warms[0]); });
  const before = new Map(simulation().nodes().map((n) => [n.id, [n.x!, n.y!]]));
  act(() => root.unmount());
  // One new note linking to two kept ones: today's key misses the cache.
  entries["R new.md"] = "[[R1]] [[R2]]";
  root = createRoot(host);
  mount();
  await openSteps();
  expect(warms).toHaveLength(2);
  expect(warms[1].startAlpha).toBe(0.3);
  // The worker starts from the last layout: every kept node at its old place.
  const sent = simulation().nodes();
  for (const node of sent) {
    const old = before.get(node.id);
    if (!old) continue;
    const i = sent.indexOf(node);
    expect([warms[1].init!.state[i * 4], warms[1].init!.state[i * 4 + 1]]).toEqual(old);
  }
  act(() => { answerWarm(workers[workers.length - 1], warms[1]); });
  expect(host.textContent).not.toContain("Laying out");
  const moved = simulation().nodes().filter((n) => before.has(n.id)).map((n) => Math.hypot(n.x! - before.get(n.id)![0], n.y! - before.get(n.id)![1])).sort((a, b) => a - b);
  // A fresh layout would move kept nodes thousands of units; reuse keeps them close.
  expect(moved[Math.floor(moved.length / 2)]).toBeLessThan(200);
}, 30000);

it("reuses a layout saved by an earlier session when the graph changed in between", async () => {
  const saved = new Map<string, { state: Float64Array; ids?: Uint32Array }>();
  setGraphLayoutStore({
    get: async (key) => saved.get(key)?.state ?? null,
    put: async (key, state, ids) => void saved.set(key, { state, ids }),
    recent: async () => [...saved].reverse().map(([key, entry]) => ({ key, ...entry })),
  });
  const warms: { type: string; session: number; init?: GraphPhysicsInit; count?: number; startAlpha?: number }[] = [];
  const workers: { onmessage: ((event: { data: unknown }) => void) | null }[] = [];
  vi.stubGlobal("Worker", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { workers.push(this); }
    postMessage(message: { type: string; session: number }) { if (message.type === "warm") warms.push(message); }
    terminate() {}
  });
  const entries: Record<string, string> = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`S${i}.md`, i % 2 ? `[[S${(i * 3) % 1100}]]` : ""]));
  const mount = () => act(() => {
    const files: VaultFile[] = Object.keys(entries).map((relPath) => ({ path: `/demo/${relPath}`, relPath, name: relPath.slice(0, -3), ext: "md", isMarkdown: true }));
    useAppStore.setState({ files, notes: buildNotes(files, new Map(Object.entries(entries))),
      settings: { ...initial.settings, graphShowTags: false, graphShowOrphans: true, animations: false } });
    root.render(<GraphView />);
  });
  mount();
  await openSteps();
  await act(async () => { answerWarm(workers[0], warms[0]); await Promise.resolve(); });
  expect(saved.size).toBe(1);
  // A new session (empty memory cache) after a note was added elsewhere.
  act(() => root.unmount());
  clearGraphLayoutCache();
  entries["S new.md"] = "[[S1]]";
  root = createRoot(host);
  mount();
  await openSteps();
  expect(warms).toHaveLength(2);
  expect(warms[1].startAlpha).toBe(0.3);
}, 30000);
