// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Simulation, ForceLink, ForceManyBody } from "d3-force";
import type { GraphNode, GraphLink, VaultFile } from "../types";
import { useAppStore } from "../store";
import { buildNotes } from "../lib/graph";
import { GraphView, resolveOverlaps } from "./GraphView";

const captured = vi.hoisted(() => ({ sim: null as unknown }));
vi.mock("d3-force", async (original) => {
  const actual = await original<typeof import("d3-force")>();
  return { ...actual, forceSimulation: (...args: Parameters<typeof actual.forceSimulation>) => {
    const sim = actual.forceSimulation(...args);
    captured.sim = sim;
    return sim;
  } };
});
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

it("separates enlarged hubs across spatial cells using their displayed radii", () => {
  const nodes = [
    { id: "A", title: "A", kind: "note", degree: 300, x: 60, y: 0 },
    { id: "B", title: "B", kind: "note", degree: 300, x: 165, y: 0 },
  ] as GraphNode[];
  expect(resolveOverlaps(nodes, () => 48, 8, 2)).toBe(true);
  expect(Math.abs(nodes[1].x! - nodes[0].x!)).toBeGreaterThanOrEqual(112);
});

// The app's TypeScript configuration deliberately excludes Node globals.
declare const process: { env: Record<string, string | undefined> };
it.skipIf(!process.env.MESA_GRAPH_FIXTURE)("replays and drags the supplied real-vault graph without non-finite physics", async () => {
  const { readFileSync } = await vi.importActual<{
    readFileSync(path: string, encoding: "utf8"): string;
  }>("node:fs");
  const fixture = JSON.parse(readFileSync(process.env.MESA_GRAPH_FIXTURE!, "utf8"));
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
  for (const node of [hub, orphan]) {
    const x = node.x!, y = node.y!;
    pointer("pointerdown", x, y);
    expect(node.fx).toBeCloseTo(x);
    for (let i = 1; i <= 60; i++) {
      pointer("pointermove", x + i * 4, y + i);
      sim.tick();
      expect(node.x).toBeCloseTo(x + i * 4);
      expect(node.y).toBeCloseTo(y + i);
    }
    const alpha = sim.alpha();
    pointer("pointerup", x + 240, y + 60);
    expect(sim.alpha()).toBe(alpha);
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
}, 20000);
