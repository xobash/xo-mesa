// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { GraphLink, GraphNode } from "../types";
import { drawGraph, type GraphDrawRefs, type GraphLinkEndpoints } from "./graphDraw";
import { LINK_LAYER_MIN_LINKS, LinkLayer, isWebKitCanvas, linkStateInterval } from "./graphLinkLayer";
import { linkAdjacency } from "./graphLinkIndex";

type Calls = { moveTo: number; drawImage: number };
function recorder(calls: Calls, canvas: { width: number; height: number }) {
  const target: Record<string, unknown> = {
    canvas,
    moveTo: () => { calls.moveTo++; },
    drawImage: () => { calls.drawImage++; },
    measureText: (text: string) => ({ width: text.length * 7 }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
  };
  return new Proxy(target, { get: (t, key) => key in t ? t[key as string] : () => {}, set: (t, key, value) => { t[key as string] = value; return true; } }) as unknown as CanvasRenderingContext2D;
}
afterEach(() => vi.restoreAllMocks());

it("draws plain links into one cached layer, redrawn only when a plain link moves, and reused across a pan", () => {
  const main: Calls = { moveTo: 0, drawImage: 0 }, cached: Calls = { moveTo: 0, drawImage: 0 };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) { return recorder(cached, this); } as never);
  vi.stubGlobal("devicePixelRatio", 1);
  const count = LINK_LAYER_MIN_LINKS + 10;
  const nodes: GraphNode[] = Array.from({ length: 2000 }, (_, i) => ({ id: `n${i}`, title: `n${i}`, degree: 1, kind: "note", ext: "md", x: (i % 50) * 10, y: Math.floor(i / 50) * 10 }));
  const links: GraphLink[] = Array.from({ length: count }, (_, i) => ({ source: nodes[i % 2000], target: nodes[(i * 7 + 1) % 2000] }));
  const ref = <T,>(current: T) => ({ current });
  const endpoints: GraphLinkEndpoints = { sx: new Float32Array(count), sy: new Float32Array(count), tx: new Float32Array(count), ty: new Float32Array(count), sId: [], tId: [] };
  const transform = { k: 1, x: 50, y: 50 };
  const refs: GraphDrawRefs = {
    canvasRef: ref({} as HTMLCanvasElement), ctxRef: ref(recorder(main, { width: 900, height: 900 })), sizeRef: ref({ w: 900, h: 900 }),
    transformRef: ref(transform), targetKRef: ref(1), zoomAnchorRef: ref(null), fastDrawUntilRef: ref(0),
    dragRef: ref({ node: null, panning: false }), needsRedrawRef: ref(false), nodesRef: ref(nodes), forceNodesRef: ref(nodes), linksRef: ref(links),
    hoverRef: ref({ id: null }), colorsRef: ref({ link: "#888", linkActive: "#fff", label: "#ccc", flickerRgb: "1,1,1", bloomAlpha: 1, node: "#999", nodeActive: "#fff", thumbBorder: "#fff" } as never),
    graphDisplayRef: ref({ arrows: false, textFade: 0, nodeSize: 1, linkThickness: 1, living: false }), focusRef: ref({ id: null as string | null, k: 0 }),
    neighborsRef: ref(new Map()), motionUntilRef: ref(0), linkEndpointsRef: ref(endpoints), adjacencyRef: ref(linkAdjacency(links)), nodeByIdRef: ref(new Map(nodes.map((n) => [n.id, n]))),
    nodeRadius: () => 8, graphBounds: () => ({ valid: false, cx: 0, cy: 0, radius: 0 }), getImage: () => null, linkLayer: new LinkLayer(),
  };
  let clock = 1000;
  const frame = () => { main.moveTo = 0; main.drawImage = 0; cached.moveTo = 0; drawGraph(refs, (clock += 16), [], false, null); };
  frame(); // new links: drawn into the layer, then blitted
  const full = cached.moveTo;
  expect(full).toBeGreaterThan(LINK_LAYER_MIN_LINKS / 2);
  expect(main.drawImage).toBe(1);
  expect(main.moveTo).toBe(0);
  frame(); // still: blitted, not drawn again
  expect(cached.moveTo).toBe(0);
  expect(main.drawImage).toBe(1);
  transform.x += 30; // a pan: the same layer at an offset
  frame();
  expect(cached.moveTo).toBe(0);
  expect(main.drawImage).toBe(1);
  expect(main.moveTo).toBe(0);
  nodes[0].x! += 5; // moving geometry: the layer is redrawn, never stale
  frame();
  expect(cached.moveTo).toBeGreaterThan(full - 100);
  expect(main.drawImage).toBe(1);
  frame(); // still again
  expect(cached.moveTo).toBe(0);
  refs.focusRef.current = { id: "n3", k: 0.5 }; // a hover: one new layer without the focused links
  frame();
  expect(cached.moveTo).toBeGreaterThan(full - 100);
  expect(cached.moveTo).toBeLessThan(full);
  expect(main.drawImage).toBe(1);
  frame();
  expect(cached.moveTo).toBe(0);
  // Dragging the focused node moves only its own links, which draw on top: no redraw.
  refs.focusRef.current = { id: "n3", k: 1 };
  frame();
  nodes[3].x! += 40;
  frame();
  expect(cached.moveTo).toBe(0);
  expect(main.moveTo).toBeGreaterThan(0);
  expect(main.drawImage).toBe(1);
  // A zoom ease blits the layer scaled, drawing it sharp at most every 50 ms.
  refs.focusRef.current = { id: null, k: 0 };
  frame();
  refs.targetKRef.current = 0.8;
  const draws: number[] = [];
  for (let i = 0; i < 9; i++) { frame(); draws.push(cached.moveTo > 0 ? 1 : 0); expect(main.drawImage).toBe(1); }
  expect(draws.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3);
  refs.targetKRef.current = transform.k; // the ease ends: one sharp draw, then reuse
  frame(); frame();
  frame();
  expect(cached.moveTo).toBe(0);
});

it("paces worker states only for a heavy graph on a slow-drawing engine", () => {
  expect(linkStateInterval(3, false)).toBe(0);
  expect(linkStateInterval(30, false)).toBe(60);
  expect(linkStateInterval(400, false)).toBe(100);
  expect(linkStateInterval(3, true)).toBe(50);
  const layer = new LinkLayer();
  expect(layer.stateInterval(true)).toBe(0);
  layer.active = true;
  expect(layer.stateInterval(true)).toBe(50);
  expect(isWebKitCanvas("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe(true);
  expect(isWebKitCanvas("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0")).toBe(false);
});

it("leaves plain links of a heavy graph to WebGL and draws only highlighted links in 2D", () => {
  const main: Calls = { moveTo: 0, drawImage: 0 };
  vi.stubGlobal("devicePixelRatio", 1);
  const count = LINK_LAYER_MIN_LINKS + 10;
  const nodes: GraphNode[] = Array.from({ length: 2000 }, (_, i) => ({ id: `n${i}`, title: `n${i}`, degree: 1, kind: "note", ext: "md", x: (i % 50) * 30, y: Math.floor(i / 50) * 30 }));
  const links: GraphLink[] = Array.from({ length: count }, (_, i) => ({ source: nodes[i % 2000], target: nodes[(i * 7 + 1) % 2000] }));
  const ref = <T,>(current: T) => ({ current });
  const glDraws: { count: number; skipped: number }[] = [];
  const linkGl = { ready: () => true, clear: () => {}, release: () => {}, linksChanged: () => false,
    draw: (_canvas: HTMLCanvasElement, frame: { count: number; s: Int32Array; t: Int32Array; skipNodes: Uint8Array | null }) => { let skipped = 0; for (let i = 0; i < frame.count; i++) if (frame.skipNodes && (frame.skipNodes[frame.s[i]] || frame.skipNodes[frame.t[i]])) skipped++; glDraws.push({ count: frame.count, skipped }); return true; } };
  const refs: GraphDrawRefs = {
    canvasRef: ref(document.createElement("canvas")), ctxRef: ref(recorder(main, { width: 1600, height: 1600 })), sizeRef: ref({ w: 1600, h: 1600 }),
    transformRef: ref({ k: 1, x: 20, y: 20 }), targetKRef: ref(1), zoomAnchorRef: ref(null), fastDrawUntilRef: ref(0),
    dragRef: ref({ node: null, panning: false }), needsRedrawRef: ref(false), nodesRef: ref(nodes), forceNodesRef: ref(nodes), linksRef: ref(links),
    hoverRef: ref({ id: null }), colorsRef: ref({ link: "#888", linkActive: "#fff", label: "#ccc", flickerRgb: "1,1,1", bloomAlpha: 1, node: "#999", nodeActive: "#fff", thumbBorder: "#fff" } as never),
    graphDisplayRef: ref({ arrows: false, textFade: 0, nodeSize: 1, linkThickness: 1, living: false }), focusRef: ref({ id: "n5", k: 1 }),
    neighborsRef: ref(new Map()), motionUntilRef: ref(0), linkEndpointsRef: ref({ sx: new Float32Array(count), sy: new Float32Array(count), tx: new Float32Array(count), ty: new Float32Array(count), sId: [], tId: [] }),
    adjacencyRef: ref(linkAdjacency(links)), nodeByIdRef: ref(new Map(nodes.map((n) => [n.id, n]))),
    nodeRadius: () => 4, graphBounds: () => ({ valid: false, cx: 0, cy: 0, radius: 0 }), getImage: () => null,
    linkLayer: new LinkLayer(), linkGl: linkGl as never,
  };
  drawGraph(refs, 1000, [], false, null);
  expect(glDraws).toHaveLength(1);
  const incident = linkAdjacency(links).get("n5")!.length;
  expect(glDraws[0].skipped).toBe(incident);
  // Only the highlighted node's links reach the 2D canvas (twice: the cross-fade's two strokes).
  expect(main.moveTo).toBeLessThanOrEqual(incident * 2);
  expect(main.moveTo).toBeGreaterThan(0);
  expect(main.drawImage).toBe(0);
});
