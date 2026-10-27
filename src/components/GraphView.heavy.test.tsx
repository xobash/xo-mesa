// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Simulation } from "d3-force";
import type { GraphNode, GraphLink, VaultFile } from "../types";
import { useAppStore } from "../store";
import { buildNotes } from "../lib/graph";
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
let host: HTMLDivElement;
let root: Root;
const initial = useAppStore.getState();
const simulation = () => captured.sim as Simulation<GraphNode, GraphLink>;
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
it("settles heavy graphs in the worker with overlap cleanup and transferred buffers", () => {
  const posted: { message: { type: string; session: number; init?: { grab: number; overlap?: { gap: number } } }; transfer?: unknown[] }[] = [];
  const workers: { onmessage: ((event: { data: unknown }) => void) | null }[] = [];
  vi.stubGlobal("Worker", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { workers.push(this); }
    postMessage(message: (typeof posted)[number]["message"], transfer?: unknown[]) { posted.push({ message, transfer }); }
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
  const sim = simulation();
  expect(sim.alpha()).toBeGreaterThan(0.004);
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
  act(() => workers[0].onmessage!({ data: { type: "idle", session: start.message.session, state, alpha: 0.003 } }));
  runFrame();
  expect(nodes[0].x).toBeCloseTo(first + 3);
  expect(posted.at(-1)!.message).toMatchObject({ type: "stop", session: start.message.session });
  runFrame();
  expect(tick).not.toHaveBeenCalled();
  expect(posted.filter((p) => p.message.type === "start")).toHaveLength(1);
});
