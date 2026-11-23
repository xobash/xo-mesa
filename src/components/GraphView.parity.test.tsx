// @vitest-environment jsdom
// Obsidian-parity contracts for the graph's defaults: filters, forces, open,
// zoom, drawing, hover and pan. Reference values were measured from Obsidian's
// graph renderer and simulation worker (docs/live-graph.md, "Obsidian parity").
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ForceCollide, ForceLink, ForceManyBody, Simulation } from "d3-force";
import type { GraphNode, GraphLink, Settings, VaultFile } from "../types";
import { useAppStore } from "../store";
import { buildNotes } from "../lib/graph";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { nodeRadius } from "../lib/graphGeometry";
import { GRAPH_REHEAT_ALPHA, graphOpenWarmup } from "../lib/graphPhysics";
import { readGraphColors } from "./graphColors";
import { GraphView } from "./GraphView";

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

interface Fill { x: number; y: number; r: number; alpha: number; style: string }
interface Stroke { arcs: number; segments: number; alpha: number; style: string; lineWidth: number }
interface Text { text: string; alpha: number; scale: number; x: number; y: number }

/** A 2D context that records the last frame's fills, strokes and labels. */
function recorder() {
  const frame = { fills: [] as Fill[], strokes: [] as Stroke[], texts: [] as Text[], gradients: 0, view: { x: 0, y: 0, k: 1 } };
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1 };
  let arcs: [number, number, number][] = [];
  let segments = 0;
  let matrix = [1, 0, 0, 1, 0, 0];
  const api: Record<string, unknown> = {
    clearRect: () => { frame.fills = []; frame.strokes = []; frame.texts = []; frame.gradients = 0; },
    setTransform: (...m: number[]) => { matrix = m; },
    translate: (x: number, y: number) => { frame.view.x = x; frame.view.y = y; },
    scale: (k: number) => { frame.view.k = k; },
    beginPath: () => { arcs = []; segments = 0; },
    arc: (x: number, y: number, r: number) => { arcs.push([x, y, r]); },
    lineTo: () => { segments++; },
    fill: () => { for (const [x, y, r] of arcs) frame.fills.push({ x, y, r, alpha: state.globalAlpha as number, style: String(state.fillStyle) }); },
    stroke: () => { frame.strokes.push({ arcs: arcs.length, segments, alpha: state.globalAlpha as number, style: String(state.strokeStyle), lineWidth: state.lineWidth as number }); },
    fillText: (text: string) => { frame.texts.push({ text, alpha: state.globalAlpha as number, scale: matrix[0], x: matrix[4], y: matrix[5] }); },
    createRadialGradient: () => { frame.gradients++; return { addColorStop: () => {} }; },
    measureText: (text: string) => ({ width: text.length * 8 }),
  };
  const context = new Proxy(api, {
    get: (target, key: string) => (key in target ? target[key] : key in state ? state[key] : () => {}),
    set: (_target, key: string, value) => { state[key] = value; return true; },
  });
  return { frame, context: context as unknown as CanvasRenderingContext2D };
}

let host: HTMLDivElement;
let root: Root;
let callback: FrameRequestCallback = () => {};
let raf: ReturnType<typeof vi.fn>;
let rec: ReturnType<typeof recorder>;
const initial = useAppStore.getState();
const simulation = () => captured.sim as Simulation<GraphNode, GraphLink>;
const frames = (count = 1) => { for (let i = 0; i < count; i++) act(() => { vi.advanceTimersByTime(16); callback(performance.now()); }); };
const pointer = (type: string, x: number, y: number) =>
  act(() => host.querySelector(".graph-wrap")!.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })));
const wheel = (deltaY: number, x = 320, y = 240) =>
  act(() => host.querySelector(".graph-canvas")!.dispatchEvent(new WheelEvent("wheel", { deltaY, clientX: x, clientY: y, bubbles: true, cancelable: true })));

/** Hub.md links to A, B and a missing note; Lone.md is an orphan; pic.png is an attachment. */
const VAULT = { "Hub.md": "[[A]] [[B]] [[Missing]]", "A.md": "[[Hub]]", "B.md": "", "Lone.md": "" };
function open(settings: Partial<Settings> = {}, entries: Record<string, string> = VAULT) {
  const files: VaultFile[] = Object.keys(entries).map((relPath) => ({ path: `/demo/${relPath}`, relPath, name: relPath.slice(0, -3), ext: "md", isMarkdown: true }));
  const notes = buildNotes(files, new Map(Object.entries(entries)));
  files.push({ path: "/demo/pic.png", relPath: "pic.png", name: "pic", ext: "png", isMarkdown: false });
  act(() => {
    useAppStore.setState({ notes, files, settings: { ...DEFAULT_SETTINGS, animations: false, ...settings }, openDocWindow: vi.fn().mockResolvedValue(undefined) });
    root.render(<GraphView />);
  });
  return { files, notes };
}
/** Stop the simulation and put the nodes on a known row, 100 world units apart, centred on the origin. */
function arrange() {
  const sim = simulation();
  sim.alpha(0);
  const byId = new Map(sim.nodes().map((n) => [n.id, n]));
  const order = ["Hub.md", "A.md", "B.md", "Lone.md"].map((id) => byId.get(id)!);
  order.forEach((n, i) => { n.x = (i - 1.5) * 100; n.y = 0; });
  const phantom = sim.nodes().find((n) => n.kind === "phantom");
  if (phantom) { phantom.x = 0; phantom.y = 150; }
  frames(3);
  return { hub: order[0], a: order[1], b: order[2], lone: order[3], phantom };
}
const fillAt = (n: GraphNode) => rec.frame.fills.find((f) => f.x === n.x && f.y === n.y)!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  raf = vi.fn((next: FrameRequestCallback) => { callback = next; return 1; });
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  rec = recorder();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(rec.context);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480, toJSON: () => ({}) });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  useAppStore.setState(initial, true);
  simulation()?.stop();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("opens at Obsidian's default filters and forces, already warmed", () => {
  open();
  const sim = simulation();
  // Notes and the unresolved link are shown; attachments and tags are not.
  expect(sim.nodes().map((n) => `${n.kind}:${n.title}`).sort()).toEqual(["note:A", "note:B", "note:Hub", "note:Lone", "phantom:Missing"]);
  expect((sim.force("charge") as ForceManyBody<GraphNode>).strength()(sim.nodes()[0], 0, sim.nodes())).toBe(-1000);
  const link = sim.force("link") as ForceLink<GraphNode, GraphLink>;
  expect(link.distance()(link.links()[0], 0, link.links())).toBe(250);
  expect((sim.force("collide") as ForceCollide<GraphNode>).radius()(sim.nodes()[0], 0, sim.nodes())).toBe(60);
  // The warm ticks ran before the first frame, and mounting did not reheat past the open alpha.
  expect(raf).toHaveBeenCalled();
  expect(sim.alpha()).toBe(graphOpenWarmup(5).openAlpha);
  expect(sim.nodes().every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  // No unstyled mode classes: only living motion changes the wrap.
  expect(host.querySelector(".graph-wrap")!.className).toBe("graph-wrap");
});

it("opens the same graph in the same layout every time", () => {
  open();
  const first = simulation().nodes().map((n) => [n.id, n.x, n.y]);
  act(() => root.unmount());
  root = createRoot(host);
  open();
  expect(simulation().nodes().map((n) => [n.id, n.x, n.y])).toEqual(first);
});

it("never cuts a settle short on a content-only refresh, and reheats on a topology change", () => {
  const { files, notes } = open();
  const sim = simulation();
  const openAlpha = sim.alpha();
  const before = new Map(sim.nodes().map((n) => [n.id, [n.x, n.y]]));
  // Same links, new metadata object: no energy added, none removed, nothing moves.
  act(() => useAppStore.setState({ notes: { ...notes } }));
  expect(simulation()).toBe(sim);
  expect(sim.alpha()).toBe(openAlpha);
  expect(sim.nodes().every((n) => before.get(n.id)![0] === n.x && before.get(n.id)![1] === n.y)).toBe(true);
  // A new link is new graph data: alpha rises to the reheat level and existing nodes keep their place.
  const linked = buildNotes(files.filter((f) => f.isMarkdown), new Map(Object.entries({ ...VAULT, "Lone.md": "[[B]]" })));
  act(() => useAppStore.setState({ notes: linked }));
  expect(sim.alpha()).toBe(GRAPH_REHEAT_ALPHA);
  expect(sim.nodes().every((n) => before.get(n.id)![0] === n.x && before.get(n.id)![1] === n.y)).toBe(true);
});

it("reheats to 0.3 for a force slider and not at all for node size or a display setting", () => {
  open();
  const sim = simulation();
  sim.alpha(0);
  for (const [key, value] of [["graphNodeSize", 2], ["graphLinkThickness", 3], ["graphTextFade", 1], ["graphArrows", true]] as const) {
    act(() => useAppStore.getState().setSetting(key, value));
    expect(sim.alpha()).toBe(0);
  }
  act(() => useAppStore.getState().setSetting("graphCenterForce", 1));
  expect(simulation()).toBe(sim);
  expect(sim.alpha()).toBe(GRAPH_REHEAT_ALPHA);
  expect(sim.alphaTarget()).toBe(0);
});

it("zooms one wheel notch by 1.5x toward the cursor when zooming in and about the centre when zooming out", () => {
  open();
  const { hub } = arrange();
  const view = rec.frame.view;
  // A small graph opens at one device pixel per world unit, centred.
  expect(view.k).toBe(1);
  expect([view.x, view.y]).toEqual([320, 240 - 75]);
  const screenX = () => hub.x! * view.k + view.x;
  const cursor = screenX();
  wheel(-120, cursor, 240);
  frames(80);
  expect(view.k).toBeCloseTo(1.5, 1);
  // The world point under the cursor stayed there.
  expect(screenX()).toBeCloseTo(cursor, 6);
  const centre = (320 - view.x) / view.k;
  wheel(120, 20, 20);
  frames(80);
  expect(view.k).toBeCloseTo(1, 1);
  expect((320 - view.x) / view.k).toBeCloseTo(centre, 6);
  // Limits: 8 device px per world unit in, 1/128 out. The ease stops within 1% of its target.
  wheel(-12000);
  frames(200);
  expect(view.k).toBeLessThanOrEqual(8);
  expect(view.k).toBeGreaterThan(8 * 0.99);
  wheel(1e6);
  frames(400);
  expect(view.k).toBeGreaterThanOrEqual(1 / 128);
  expect(view.k).toBeLessThan(1.01 / 128);
});

it("draws nodes, links and labels in Obsidian's default style", () => {
  open();
  const { hub, a, lone, phantom } = arrange();
  const colors = readGraphColors();
  const { frame } = rec;
  // Node radius follows the link count (Hub: 4 links → 8 minimum); every note uses one fill.
  expect(fillAt(hub)).toMatchObject({ r: nodeRadius(hub), alpha: 1, style: colors.node });
  expect(nodeRadius(hub)).toBe(8);
  expect(fillAt(lone)).toMatchObject({ r: 8, alpha: 1, style: colors.node });
  // An unresolved link draws at half strength.
  expect(fillAt(phantom!)).toMatchObject({ alpha: 0.5, style: colors.nodePhantom });
  // All links in one stroke, one device pixel wide, in the link colour.
  const lines = frame.strokes.filter((s) => s.segments > 0);
  expect(lines).toEqual([{ arcs: 0, segments: 4, alpha: 1, style: colors.link, lineWidth: 1 }]);
  // No bloom, glow or halo at the defaults.
  expect(frame.gradients).toBe(0);
  // Every node is labelled at full strength at this zoom, below the node, sized by its radius.
  expect(frame.texts.map((t) => t.text).sort()).toEqual(["A", "B", "Hub", "Lone", "Missing"]);
  const label = frame.texts.find((t) => t.text === "A")!;
  expect(label.alpha).toBe(1);
  expect(label.scale).toBeCloseTo((14 + 8 / 4) / 16, 9);
  expect(label.x).toBeCloseTo(a.x! + 320, 9);
  expect(label.y).toBeCloseTo(a.y! + 8 + 5 + rec.frame.view.y, 9);

  // Half the zoom: labels are gone, nodes draw sqrt(2) larger in world units, links stay one pixel.
  wheel(240);
  frames(120);
  const k = frame.view.k;
  expect(k).toBeLessThan(0.5);
  expect(frame.texts).toEqual([]);
  expect(fillAt(hub).r).toBeCloseTo(8 / Math.sqrt(k), 9);
  expect(frame.strokes.find((s) => s.segments > 0)!.lineWidth).toBeCloseTo(1 / k, 9);
  // The text-fade setting shifts the range: at -1 the same zoom shows labels again.
  act(() => useAppStore.getState().setSetting("graphTextFade", -1));
  frames(2);
  expect(frame.texts).toHaveLength(5);
  expect(frame.texts[0].alpha).toBeCloseTo(Math.log2(k) + 2, 9);
});

it("highlights a hovered node's neighbourhood and fades the rest to 20%", () => {
  open();
  const { hub, a, b, lone } = arrange();
  const colors = readGraphColors();
  const { frame } = rec;
  pointer("pointermove", hub.x! + frame.view.x, hub.y! + frame.view.y);
  frames(120);
  expect(fillAt(hub)).toMatchObject({ alpha: 1, style: colors.nodeActive });
  expect(fillAt(a)).toMatchObject({ alpha: 1, style: colors.node });
  expect(fillAt(b).alpha).toBe(1);
  expect(fillAt(lone).alpha).toBeCloseTo(0.2, 6);
  // Its links take the accent colour; an accent ring surrounds it.
  const accent = frame.strokes.filter((s) => s.style === colors.linkActive);
  expect(accent).toEqual([{ arcs: 0, segments: 4, alpha: 1, style: colors.linkActive, lineWidth: 1 }]);
  expect(frame.strokes.some((s) => s.arcs === 1 && s.style === colors.nodeActive && s.lineWidth === 1)).toBe(true);
  // Labels: the neighbourhood stays readable, the rest fades, the hovered label drops 15 px.
  const text = (title: string) => frame.texts.find((t) => t.text === title)!;
  expect(text("A").alpha).toBe(1);
  expect(text("Lone").alpha).toBeCloseTo(0.2, 6);
  expect(text("Hub").y).toBeCloseTo(hub.y! + 8 + 5 + 15 + frame.view.y, 6);
  // Leaving the node restores everything.
  pointer("pointermove", 5, 5);
  frames(160);
  expect(fillAt(lone).alpha).toBe(1);
  expect(fillAt(hub).style).toBe(colors.node);
  expect(frame.strokes.some((s) => s.style === colors.linkActive)).toBe(false);
});

it("keeps the highlight on a grabbed node, holds alpha at 0.3 while dragging and releases without a kick", () => {
  open();
  const { hub, lone } = arrange();
  const sim = simulation();
  const { frame } = rec;
  const x = hub.x! + frame.view.x, y = hub.y! + frame.view.y;
  pointer("pointerdown", x, y);
  pointer("pointermove", x + 40, y + 10);
  expect([sim.alpha(), sim.alphaTarget()]).toEqual([GRAPH_REHEAT_ALPHA, GRAPH_REHEAT_ALPHA]);
  frames(60);
  // The grabbed node sits exactly under the pointer, and alpha holds at the drag target.
  expect([hub.x, hub.y]).toEqual([-150 + 40, 10]);
  expect(sim.alpha()).toBeCloseTo(GRAPH_REHEAT_ALPHA, 6);
  expect(fillAt(lone).alpha).toBeLessThan(0.3);
  const alpha = sim.alpha();
  pointer("pointerup", x + 40, y + 10);
  expect(sim.alpha()).toBe(alpha);
  expect(sim.alphaTarget()).toBe(0);
  expect(hub.fx).toBeNull();
  expect(useAppStore.getState().openDocWindow).not.toHaveBeenCalled();
});

it("coasts after a moving background pan is released, then stops and sleeps", () => {
  open();
  arrange();
  const view = rec.frame.view;
  const drag = (pause: number) => {
    pointer("pointerdown", 600, 440);
    for (let i = 1; i <= 6; i++) { act(() => { vi.advanceTimersByTime(16); }); pointer("pointermove", 600 - i * 12, 440); }
    const held = view.x;
    act(() => { vi.advanceTimersByTime(pause); });
    pointer("pointerup", 600 - 72, 440);
    frames(1);
    return held;
  };
  const start = view.x;
  const released = drag(0);
  expect(released).toBe(start);
  frames(2);
  // The drag moved the view 72 px; the coast carries it further the same way.
  expect(view.x).toBeLessThan(start - 72);
  frames(200);
  const rest = view.x;
  raf.mockClear();
  frames(3);
  expect(view.x).toBe(rest);
  expect(raf).not.toHaveBeenCalled();
  // A drag that pauses before release does not coast.
  pointer("pointermove", 10, 10);
  drag(300);
  const stopped = view.x;
  frames(20);
  expect(view.x).toBe(stopped);
});

it("sleeps once settled at the defaults, and adds bloom and ambient frames only with living motion on", () => {
  open({ animations: true });
  arrange();
  frames(30);
  raf.mockClear();
  frames(5);
  // Animations are on, but Obsidian's graph is still at rest: no frames, no gradients.
  expect(raf).not.toHaveBeenCalled();
  expect(rec.frame.gradients).toBe(0);
  act(() => useAppStore.getState().setSetting("graphLivingMotion", true));
  expect(host.querySelector(".graph-wrap")!.className).toContain("living");
  act(() => { vi.advanceTimersByTime(40); });
  frames(4);
  expect(rec.frame.gradients).toBeGreaterThan(0);
  raf.mockClear();
  frames(3);
  expect(raf).toHaveBeenCalled();
});
