// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Simulation, ForceCollide, ForceLink, ForceManyBody } from "d3-force";
import type { GraphNode, GraphLink, VaultFile } from "../types";
import { useAppStore } from "../store";
import { buildNotes } from "../lib/graph";
import { bumpActivityAmount } from "../lib/activity";
import { GraphView, resolveOverlaps } from "./GraphView";

const captured = vi.hoisted(() => ({ sim: null as unknown, builds: 0 }));
vi.mock("d3-force", async (original) => {
  const actual = await original<typeof import("d3-force")>();
  return { ...actual, forceSimulation: (...args: Parameters<typeof actual.forceSimulation>) => {
    const sim = actual.forceSimulation(...args);
    captured.sim = sim;
    captured.builds++;
    return sim;
  } };
});
// Only the store-driven open test uses these; other tests never open a vault.
const openIo = vi.hoisted(() => ({ files: [] as VaultFile[], index: null as null | ((options: { onProgress?: (done: number, total: number) => void }) => Promise<unknown>) }));
vi.mock("../lib/vault", async (original) => ({ ...await original<object>(),
  authorizeVaultRoot: async () => {}, assertVaultRootAvailable: async () => {},
  scanVault: async () => openIo.files, recoverWriteArtifacts: async () => ({ restored: [], removed: [] }),
  watchVault: async () => () => {} }));
vi.mock("../lib/vaultIndex", async (original) => ({ ...await original<object>(),
  loadIndexedNotes: (options: { onProgress?: (done: number, total: number) => void }) => openIo.index!(options) }));
vi.mock("../lib/vaultMetadata", () => ({ hydrateVaultMetadata: async () => {} }));
vi.mock("./PreviewCard", () => ({ PreviewCard: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const initial = useAppStore.getState();
const simulation = () => captured.sim as Simulation<GraphNode, GraphLink>;
const linkForce = () => simulation().force("link") as ForceLink<GraphNode, GraphLink>;
function mount() {
  const entries = { "Newest.md": "[[Middle]]", "Oldest.md": "[[Middle]]", "Middle.md": "", "Orphan.md": "" };
  const dates = [300, 100, 200, 400];
  const files: VaultFile[] = Object.keys(entries).map((relPath, i) => ({ path: `/demo/${relPath}`, relPath, name: relPath.slice(0, -3), ext: "md", isMarkdown: true, createdAt: dates[i] }));
  act(() => {
    useAppStore.setState({ notes: buildNotes(files, new Map(Object.entries(entries))), files,
      settings: { ...initial.settings, animations: false, graphShowOrphans: true, graphShowTags: false },
      openDocWindow: vi.fn().mockResolvedValue(undefined) });
    root.render(<GraphView />);
  });
}
function click(label: string) {
  const button = host.querySelector(`[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
function pointer(type: string, x: number, y: number, button = 0) {
  act(() => host.querySelector(".graph-wrap")!.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button })));
}
beforeEach(() => {
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
  act(() => root.unmount()); host.remove();
  useAppStore.setState(initial, true);
  simulation()?.stop();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
it("replays creation order with only admitted nodes and links in the real force engine", () => {
  mount(); const sim = simulation();
  click("Start timelapse animation");
  expect(sim.nodes().map(n => n.id)).toEqual(["Oldest.md"]);
  expect(linkForce().links()).toHaveLength(0);
  act(() => vi.advanceTimersByTime(1000));
  expect(sim.nodes().map(n => n.id)).toEqual(["Oldest.md", "Middle.md"]);
  expect(linkForce().links()).toHaveLength(1);
  sim.tick(20);
  expect(sim.nodes().every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  act(() => vi.advanceTimersByTime(4000));
  expect(sim.nodes()).toHaveLength(4);
  expect(linkForce().links()).toHaveLength(2);
  expect(host.querySelector('[aria-label="Start timelapse animation"]')).not.toBeNull();
  expect(simulation()).toBe(sim);
});
it("runs large-graph drag physics in a worker while the canvas keeps the grabbed node at the pointer", () => {
  const posted: { type: string; session: number; index?: number; fx?: number; init?: { grab: number; collideIterations: number } }[] = [];
  const workers: { onmessage: ((event: { data: unknown }) => void) | null }[] = [];
  vi.stubGlobal("Worker", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { workers.push(this); }
    postMessage(message: (typeof posted)[number]) { posted.push(message); }
    terminate() {}
  });
  const frames = () => (requestAnimationFrame as unknown as { mock: { calls: [FrameRequestCallback][] } }).mock.calls;
  const runFrame = () => act(() => frames()[frames().length - 1][0](performance.now()));
  const entries = Object.fromEntries(Array.from({ length: 700 }, (_, i) =>
    [`Node-${i}.md`, i > 0 && i < 100 ? "[[Node-0]]" : ""]));
  const files: VaultFile[] = Object.keys(entries).map((relPath) => ({
    path: `/demo/${relPath}`, relPath, name: relPath.slice(0, -3), ext: "md", isMarkdown: true,
  }));
  act(() => {
    useAppStore.setState({ files, notes: buildNotes(files, new Map(Object.entries(entries))),
      settings: { ...initial.settings, graphShowTags: false, graphShowOrphans: true, animations: false },
      openDocWindow: vi.fn().mockResolvedValue(undefined) });
    root.render(<GraphView />);
  });
  const sim = simulation();
  const nodes = sim.nodes();
  const hubIndex = nodes.findIndex(n => n.degree > 50);
  const hub = nodes[hubIndex];
  const other = nodes[(hubIndex + 1) % nodes.length];
  const x = hub.x!, y = hub.y!;
  pointer("pointerdown", x, y);
  pointer("pointermove", x + 8, y + 2);
  const start = posted.find(m => m.type === "start")!;
  expect(start.init!.grab).toBe(hubIndex);
  expect(start.init!.collideIterations).toBeGreaterThan(1);
  pointer("pointermove", x + 20, y + 5);
  expect(posted.at(-1)).toMatchObject({ type: "move", session: start.session, index: hubIndex, fx: x + 20 });
  expect(hub.x).toBeCloseTo(x + 20);

  const tick = vi.spyOn(sim, "tick");
  const state = new Float64Array(nodes.length * 4);
  nodes.forEach((n, i) => { state[i * 4] = n.x! + 7; state[i * 4 + 1] = n.y!; });
  const otherX = other.x!;
  act(() => workers[0].onmessage!({ data: { type: "state", session: start.session, state, alpha: 0.25 } }));
  runFrame();
  expect(tick).not.toHaveBeenCalled();
  expect(other.x).toBeCloseTo(otherX + 7);
  expect(hub.x).toBeCloseTo(x + 20);
  expect(sim.alpha()).toBe(0.25);

  pointer("pointerup", x + 20, y + 5);
  expect(posted.at(-1)).toMatchObject({ type: "release", session: start.session, index: hubIndex });
  state.fill(0);
  nodes.forEach((n, i) => { state[i * 4] = n.x!; state[i * 4 + 1] = n.y!; });
  act(() => workers[0].onmessage!({ data: { type: "idle", session: start.session, state, alpha: 0.003 } }));
  runFrame();
  expect(posted.at(-1)).toMatchObject({ type: "stop", session: start.session });
  expect(Number.isFinite(hub.x)).toBe(true);
});
it("keeps large-graph hubs and isolated nodes free in the shared simulation", () => {
  const entries = new Map<string, string>();
  entries.set("Hub.md", Array.from({ length: 139 }, (_, i) => `[[Linked-${i}]]`).join(" "));
  for (let i = 0; i < 139; i++) entries.set(`Linked-${i}.md`, "");
  for (let i = 0; i < 210; i++) entries.set(`Orphan-${i}.md`, "");
  const files: VaultFile[] = [...entries.keys()].map((relPath) => ({
    path: `/demo/${relPath}`, relPath, name: relPath.slice(0, -3), ext: "md", isMarkdown: true,
  }));
  act(() => {
    useAppStore.setState({ notes: buildNotes(files, entries), files,
      settings: { ...initial.settings, animations: false, graphShowOrphans: true, graphShowAttachments: false } });
    root.render(<GraphView />);
  });
  const hub = simulation().nodes().find((node) => node.id === "Hub.md")!;
  const orphan = simulation().nodes().find((node) => node.id === "Orphan-0.md")!;
  expect(hub.degree).toBe(139);
  expect(hub.fx).toBeNull();
  expect(hub.fy).toBeNull();
  expect(orphan.fx).toBeNull();
  expect(orphan.fy).toBeNull();
  expect(simulation().force("flower-x")).toBeUndefined();
  simulation().tick(10);
  expect(Number.isFinite(hub.x)).toBe(true);
  expect(Number.isFinite(orphan.x)).toBe(true);
});
it("stops and restarts playback, and cancels it on filter changes without stale links", () => {
  mount(); click("Start timelapse animation"); click("Stop timelapse animation");
  expect(simulation().nodes()).toHaveLength(4);
  click("Start timelapse animation");
  act(() => useAppStore.getState().setSetting("graphShowOrphans", false));
  expect(simulation().nodes()).toHaveLength(3);
  act(() => vi.advanceTimersByTime(5000));
  simulation().tick(20);
  expect(simulation().nodes()).toHaveLength(3);
  expect(simulation().nodes().every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
});
it("retunes low hub link strengths without a floor or a layout reset", () => {
  mount(); const sim = simulation(); const nodes = sim.nodes();
  const positions = nodes.map(n => [n.x, n.y]);
  nodes.forEach(n => n.degree = 100);
  act(() => useAppStore.getState().setSetting("graphLinkForce", 0.1));
  const link = linkForce().links()[0];
  expect(linkForce().strength()(link, 0, linkForce().links())).toBeCloseTo(0.001);
  expect(simulation()).toBe(sim);
  expect(sim.nodes()).toBe(nodes);
  expect(nodes.map(n => [n.x, n.y])).toEqual(positions);
});
it("grabs without snapping, preserves the grab offset, and releases without a hub kick", () => {
  mount(); const sim = simulation(); const node = sim.nodes()[0];
  sim.nodes().forEach((n, i) => { n.x = 100 + i * 100; n.y = 100; });
  sim.alpha(0);
  pointer("pointerdown", 104, 100);
  expect(node.fx).toBe(100);
  expect(sim.alpha()).toBe(0);
  pointer("pointermove", 154, 120);
  expect(node.fx).toBe(150); expect(node.fy).toBe(120);
  expect(sim.alphaTarget()).toBe(0.3);
  node.degree = 1000;
  const alpha = sim.alpha();
  pointer("pointerup", 154, 120);
  expect(node.fx).toBeNull(); expect(sim.alphaTarget()).toBe(0);
  expect(sim.alpha()).toBe(alpha);
  expect(useAppStore.getState().openDocWindow).not.toHaveBeenCalled();
});
it("chooses the closest hit target and ignores secondary-button presses", () => {
  mount(); const nodes = simulation().nodes();
  nodes.forEach((n, i) => { n.x = 100 + i * 5; n.y = 100; });
  pointer("pointerdown", 100, 100, 2);
  expect(nodes.every(n => n.fx == null)).toBe(true);
  pointer("pointerdown", 100, 100);
  expect(nodes[0].fx).toBe(100);
  expect(nodes[3].fx).toBeNull();
  pointer("pointercancel", 100, 100);
  expect(nodes[0].fx).toBeNull();
  expect(useAppStore.getState().openDocWindow).not.toHaveBeenCalled();
});
it("keeps toolbar pointer presses out of canvas drag capture", () => {
  mount();
  for (const selector of ['[aria-label="Start timelapse animation"]', '[title="Fit the graph to the view"]']) {
    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    act(() => host.querySelector(selector)!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    pointer("pointerup", 10, 10);
  }
});

it("waits for note metadata before its first build so an opening vault paints the full graph settled", () => {
  const entries = { "A.md": "[[B]]", "B.md": "" };
  const files: VaultFile[] = [
    ...Object.keys(entries).map((relPath) => ({ path: `/demo/${relPath}`, relPath, name: relPath.slice(0, -3), ext: "md", isMarkdown: true })),
    { path: "/demo/pic.png", relPath: "pic.png", name: "pic", ext: "png", isMarkdown: false },
  ];
  captured.sim = null;
  act(() => {
    useAppStore.setState({ files, notes: {}, indexingTextFiles: 2, notesIndexPending: true,
      settings: { ...initial.settings, animations: false, graphShowOrphans: true, graphShowTags: false, graphShowAttachments: true } });
    root.render(<GraphView />);
  });
  // The catalog alone (one attachment) must not build or warm a simulation.
  expect(captured.sim).toBeNull();
  expect(host.textContent).toContain("before the graph is drawn");
  act(() => { useAppStore.setState({ notes: buildNotes(files, new Map(Object.entries(entries))), indexingTextFiles: 0, notesIndexPending: false }); });
  // The first build runs the synchronous warm ticks and leaves the open alpha.
  const sim = simulation();
  expect(sim.nodes().map((n) => n.id).sort()).toEqual(["A.md", "B.md", "pic.png"]);
  expect(sim.alpha()).toBeLessThanOrEqual(0.2);
  expect(host.textContent).not.toContain("before the graph is drawn");
  // A vault with no text files is not gated: attachments draw at once.
  act(() => { useAppStore.setState({ files: [files[2]], notes: {}, indexingTextFiles: 0 }); });
  expect(simulation().nodes().map((n) => n.id)).toEqual(["pic.png"]);
});

it("keeps an opening vault unbuilt while the directly selected note is published, then builds once", async () => {
  const files: VaultFile[] = [
    { path: "/v/A.md", relPath: "A.md", name: "A", ext: "md", isMarkdown: true },
    { path: "/v/pic.png", relPath: "pic.png", name: "pic", ext: "png", isMarkdown: false },
  ];
  openIo.files = files;
  let finishIndex!: () => void;
  const indexed = buildNotes(files, new Map([["A.md", "![](pic.png)"]]));
  openIo.index = async (options) => {
    await new Promise<void>((resolve) => { finishIndex = resolve; });
    options.onProgress?.(1, 1);
    return { notes: indexed, cache: { "A.md": "![](pic.png)" }, reused: 0, read: 1, skipped: [], failed: [], changed: new Map() };
  };
  // Mirrors the document controller: opening a note adds its metadata.
  const selectFile = vi.fn(async (rel: string) => {
    useAppStore.setState({ activePath: rel, notes: { ...useAppStore.getState().notes, [rel]: { relPath: rel, title: "A", rawLinks: [], tags: [], aliases: [] } } });
  });
  captured.sim = null;
  captured.builds = 0;
  act(() => {
    useAppStore.setState({ selectFile, settings: { ...initial.settings, animations: false, graphShowOrphans: true, graphShowTags: false, graphShowAttachments: true } });
    root.render(<GraphView />);
  });
  const buildsBeforeOpen = captured.builds;
  await act(async () => { await useAppStore.getState().openVault("/v"); });
  await act(async () => { await vi.waitFor(() => expect(finishIndex).toBeTypeOf("function")); });
  expect(selectFile).toHaveBeenCalledWith("A.md");
  expect(Object.keys(useAppStore.getState().notes)).toEqual(["A.md"]);
  expect(useAppStore.getState().notesIndexPending).toBe(true);
  expect(captured.builds).toBe(buildsBeforeOpen);
  expect(host.textContent).toContain("before the graph is drawn");
  await act(async () => { finishIndex(); await vi.waitFor(() => expect(useAppStore.getState().notesIndexPending).toBe(false)); });
  expect(captured.builds).toBe(buildsBeforeOpen + 1);
  expect(simulation().nodes().map((n) => n.id).sort()).toEqual(["A.md", "pic.png"]);
  expect(host.textContent).not.toContain("before the graph is drawn");
});

it("paints no previous-vault labels while the next vault waits for its index", () => {
  let frame: FrameRequestCallback | null = null;
  const labels: string[] = [];
  const context = new Proxy({
    fillText: (value: string) => { labels.push(value); },
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    measureText: (value: string) => ({ width: value.length * 7 }),
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480, toJSON: () => ({}),
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }));
  const entries = { "Alpha one.md": "[[Alpha two]]", "Alpha two.md": "" };
  const filesA: VaultFile[] = Object.keys(entries).map((relPath) => ({ path: `/a/${relPath}`, relPath, name: relPath.slice(0, -3), ext: "md", isMarkdown: true }));
  act(() => {
    useAppStore.setState({ files: filesA, notes: buildNotes(filesA, new Map(Object.entries(entries))), activePath: "Alpha one.md",
      settings: { ...initial.settings, animations: false, graphShowOrphans: true, graphShowTags: false } });
    root.render(<GraphView />);
  });
  const runFrame = () => act(() => { vi.advanceTimersByTime(50); frame?.(performance.now()); });
  for (let i = 0; i < 120 && !labels.some((label) => label.startsWith("Alpha")); i++) runFrame();
  expect(labels.some((label) => label.startsWith("Alpha"))).toBe(true);
  // Vault B's open publication: a catalog, no index yet.
  const filesB: VaultFile[] = [{ path: "/b/Beta.md", relPath: "Beta.md", name: "Beta", ext: "md", isMarkdown: true }];
  act(() => { useAppStore.setState({ files: filesB, notes: {}, activePath: null, notesIndexPending: true, indexingTextFiles: 1 }); });
  labels.length = 0;
  for (let i = 0; i < 40; i++) runFrame();
  expect(labels.filter((label) => label.startsWith("Alpha"))).toEqual([]);
});

it("paints visible nodes on its first fitted frame with an ordinary 2D context", () => {
  let frame: FrameRequestCallback | null = null;
  const arcs: Array<[number, number, number]> = [];
  const scales: number[] = [];
  const context = new Proxy({
    arc: (x: number, y: number, radius: number) => { arcs.push([x, y, radius]); },
    scale: (k: number) => { scales.push(k); },
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    measureText: (value: string) => ({ width: value.length * 7 }),
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined });
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480,
    width: 640, height: 480, toJSON: () => ({}),
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }));
  mount();
  expect(getContext).toHaveBeenCalledWith("2d");
  expect(getContext).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain("Graph drawing is unavailable");
  act(() => { frame?.(performance.now()); });
  expect(scales.some(k => Number.isFinite(k) && k > 0)).toBe(true);
  expect(arcs.some(([x, y, r]) => Number.isFinite(x) && Number.isFinite(y) && r > 0 && r < 50)).toBe(true);
});

it("separates enlarged hubs across spatial cells using their displayed radii", () => {
  const nodes = [
    { id: "A", title: "A", kind: "note", degree: 300, x: 60, y: 0 },
    { id: "B", title: "B", kind: "note", degree: 300, x: 165, y: 0 },
  ] as GraphNode[];
  expect(resolveOverlaps(nodes, () => 48, 8, 2)).toBe(true);
  expect(Math.abs(nodes[1].x! - nodes[0].x!)).toBeGreaterThanOrEqual(112);
});

it("replays and drags a synthetic large graph without non-finite physics", () => {
  const entries = Object.fromEntries(Array.from({ length: 2100 }, (_, i) =>
    [`Node-${i}.md`, i > 0 && i < 100 ? "[[Node-0]]" : ""]));
  const files: VaultFile[] = Object.keys(entries).map((relPath, i) => ({
    path: `/demo/${relPath}`, relPath, name: relPath.slice(0, -3), ext: "md",
    isMarkdown: true, createdAt: i,
  }));
  const fixture = { files, notes: buildNotes(files, new Map(Object.entries(entries))) };
  act(() => {
    useAppStore.setState({ files: fixture.files, notes: fixture.notes,
      settings: { ...initial.settings, graphShowTags: false, graphShowAttachments: true, graphShowOrphans: true, graphExistingFilesOnly: true, animations: false },
      openDocWindow: vi.fn().mockResolvedValue(undefined) });
    root.render(<GraphView />);
  });
  const sim = simulation();
  const fullCount = sim.nodes().length;
  expect(fullCount).toBeGreaterThan(2000);
  const hub = [...sim.nodes()].sort((a, b) => b.degree - a.degree)[0];
  const orphan = sim.nodes().find(n => n.degree === 0)!;
  expect(hub.degree).toBeGreaterThan(50);
  const collide = sim.force("collide") as ForceCollide<GraphNode>;
  const collidePasses = collide.iterations();
  expect(collidePasses).toBeGreaterThan(1);
  for (const node of [hub, orphan]) {
    const x = node.x!, y = node.y!;
    pointer("pointerdown", x, y);
    expect(node.fx).toBeCloseTo(x);
    for (let i = 1; i <= 60; i++) {
      pointer("pointermove", x + i * 4, y + i);
      if (i > 1) expect(collide.iterations()).toBe(1);
      sim.tick();
      expect(node.x).toBeCloseTo(x + i * 4);
      expect(node.y).toBeCloseTo(y + i);
    }
    const alpha = sim.alpha();
    pointer("pointerup", x + 240, y + 60);
    expect(sim.alpha()).toBe(alpha);
    expect(collide.iterations()).toBe(collidePasses);
    sim.tick(100);
    expect(sim.nodes().every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  }
  const charge = sim.force("charge") as ForceManyBody<GraphNode>;
  const originalCharge = charge.strength()(sim.nodes()[0], 0, sim.nodes());
  click("Start timelapse animation");
  act(() => useAppStore.getState().setSetting("graphRepelForce", (initial.settings.graphRepelForce ?? 10) * 2));
  expect(charge.strength()(sim.nodes()[0], 0, sim.nodes())).toBeCloseTo(originalCharge * 2);
  const first = sim.nodes()[0];
  pointer("pointerdown", first.x!, first.y!);
  pointer("pointermove", first.x! + 10, first.y! + 10);
  act(() => vi.advanceTimersByTime(32));
  expect(sim.alphaTarget()).toBe(0.3);
  pointer("pointercancel", first.x!, first.y!);
  let previousTime = -Infinity;
  let previousCount = 0;
  for (let i = 0; i < 260; i++) {
    act(() => vi.advanceTimersByTime(32));
    sim.tick();
    const nodes = sim.nodes();
    if (!host.querySelector('[aria-label="Stop timelapse animation"]')) break;
    expect(nodes.length).toBeGreaterThanOrEqual(previousCount);
    for (const node of nodes.slice(previousCount)) {
      expect(node.timelineTime!).toBeGreaterThanOrEqual(previousTime);
      previousTime = node.timelineTime!;
    }
    previousCount = nodes.length;
    const ids = new Set(nodes.map(n => n.id));
    expect(linkForce().links().every(l => ids.has((l.source as GraphNode).id) && ids.has((l.target as GraphNode).id))).toBe(true);
    expect(nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  }
  expect(sim.nodes()).toHaveLength(fullCount);
  expect(simulation()).toBe(sim);
}, 60000);

function frameHarness() {
  let callback: FrameRequestCallback = () => {};
  const clear = vi.fn();
  const context = new Proxy({clearRect:clear,createRadialGradient:()=>({addColorStop:()=>{}}),measureText:(text:string)=>({width:text.length*7})}, {get:(target,key)=>key in target?target[key as keyof typeof target]:()=>{}});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:640,bottom:480,width:640,height:480,toJSON:()=>({})});
  const raf = vi.fn((next:FrameRequestCallback)=>{callback=next;return 1;});vi.stubGlobal('requestAnimationFrame',raf);
  mount();simulation().alpha(0);simulation().nodes().forEach((node,i)=>{node.x=i*100;node.y=100;});
  const tick=()=>act(()=>callback(performance.now()));
  return {clear,raf,tick};
}
it('honours reduced motion and draws no ambient frames after settling',()=>{
  vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  const f=frameHarness();act(()=>useAppStore.setState({settings:{...useAppStore.getState().settings,animations:true}}));
  for(let i=0;i<20;i++)f.tick();f.clear.mockClear();
  for(let i=0;i<60;i++)f.tick();expect(f.clear).not.toHaveBeenCalled();
});
it('stops hidden frames and resumes once on visibility change',()=>{
  const f=frameHarness();f.tick();const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(true);
  f.raf.mockClear();f.tick();expect(f.raf).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);act(()=>document.dispatchEvent(new Event('visibilitychange')));expect(f.raf).toHaveBeenCalledOnce();
});
it('stops off-screen frames, resumes on intersection and ignores callbacks after cleanup',()=>{
  let notify!: (entries:IntersectionObserverEntry[])=>void;const disconnect=vi.fn();
  vi.stubGlobal('IntersectionObserver',class{constructor(cb:typeof notify){notify=cb;}observe(){}disconnect=disconnect;});
  const f=frameHarness();act(()=>notify([{isIntersecting:false} as IntersectionObserverEntry]));f.raf.mockClear();f.tick();expect(f.raf).not.toHaveBeenCalled();
  act(()=>notify([{isIntersecting:true} as IntersectionObserverEntry]));expect(f.raf).toHaveBeenCalledOnce();
  act(()=>root.unmount());f.raf.mockClear();act(()=>notify([{isIntersecting:true} as IntersectionObserverEntry]));expect(f.raf).not.toHaveBeenCalled();expect(disconnect).toHaveBeenCalledOnce();
});

it('updates reduced motion while mounted and removes the subscription',()=>{
  let notify!: (event:MediaQueryListEvent)=>void;const remove=vi.fn();
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener:(_name:string,listener:typeof notify)=>{notify=listener;},removeEventListener:remove}));
  const f=frameHarness();act(()=>useAppStore.setState({settings:{...useAppStore.getState().settings,animations:true}}));
  for(let i=0;i<20;i++){vi.advanceTimersByTime(20);f.tick();}
  f.clear.mockClear();for(let i=0;i<3;i++){vi.advanceTimersByTime(20);f.tick();}expect(f.clear).toHaveBeenCalled();
  act(()=>notify({matches:true} as MediaQueryListEvent));f.tick();f.clear.mockClear();
  for(let i=0;i<60;i++){vi.advanceTimersByTime(20);f.tick();}expect(f.clear).not.toHaveBeenCalled();
  act(()=>root.unmount());expect(remove).toHaveBeenCalledWith('change',notify);
});

it('sleeps after reduced-motion settling and wakes on pointer input', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const f = frameHarness();
  act(() => useAppStore.setState({ settings: { ...useAppStore.getState().settings, animations: true } }));
  for (let i = 0; i < 20; i++) { vi.advanceTimersByTime(20); f.tick(); }
  f.raf.mockClear();
  for (let i = 0; i < 60; i++) { vi.advanceTimersByTime(20); f.tick(); }
  expect(f.raf).not.toHaveBeenCalled();
  pointer('pointermove', 10, 10);
  expect(f.raf).toHaveBeenCalledOnce();
  for (let i = 0; i < 20; i++) { vi.advanceTimersByTime(20); f.tick(); }
  f.raf.mockClear();
  act(() => bumpActivityAmount('Newest.md', 1));
  expect(f.raf).toHaveBeenCalledOnce();
  for (let i = 0; i < 250; i++) { vi.advanceTimersByTime(20); f.tick(); }
  f.raf.mockClear();
  for (let i = 0; i < 20; i++) { vi.advanceTimersByTime(20); f.tick(); }
  expect(f.raf).not.toHaveBeenCalled();
  await act(async () => { document.documentElement.dataset.mode = 'light'; await Promise.resolve(); });
  expect(f.raf).toHaveBeenCalledOnce();
  delete document.documentElement.dataset.mode;
});

it('stops settled ambient frames after 15 seconds and resumes once on input and activity', () => {
  const f = frameHarness();
  act(() => useAppStore.setState({ settings: { ...useAppStore.getState().settings, animations: true } }));
  for (let i = 0; i < 500; i++) { vi.advanceTimersByTime(20); f.tick(); }
  act(() => window.dispatchEvent(new Event('focus')));
  vi.advanceTimersByTime(15_000); f.tick();
  f.raf.mockClear();
  vi.advanceTimersByTime(1000);
  expect(f.raf).not.toHaveBeenCalled();
  pointer('pointermove', 10, 10); pointer('pointermove', 10, 10);
  expect(f.raf).toHaveBeenCalledOnce();
  f.tick();
  vi.mocked(document.hasFocus).mockReturnValue(false);
  f.tick(); f.raf.mockClear();
  vi.advanceTimersByTime(1000); expect(f.raf).not.toHaveBeenCalled();
  act(() => bumpActivityAmount('Newest.md', 1));
  expect(f.raf).toHaveBeenCalledOnce();
  f.raf.mockClear(); f.tick();
  expect(f.raf).toHaveBeenCalledOnce();
  expect(simulation().alpha()).toBe(0);
});
