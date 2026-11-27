import { prefersReducedMotion, onReducedMotionChange } from "../lib/motion";
import { useEffect, useRef, useState } from "react";
import type { ForceLink, Simulation } from "d3-force";
import type { GraphNode, GraphLink, NoteMeta } from "../types";
import { useAppStore, getStore } from "../store";
import { createGraphBuilder, buildNeighbors, graphFileSnapshot, sameGraphFiles, sameGraphNotes, sameGraphTopology, type GraphFileSnapshot, type GraphTopology } from "../lib/graph";
import {
  decayActivity,
  activeRecords,
  onActivityChange,
} from "../lib/activity";
import { urlForPath } from "../lib/vault";

import { clamp } from "../lib/clamp";
import { GraphHitIndex, graphLinkNodeId, maxNodeDegree, nearestNodeLinear, nodeDrawScale, nodeRadius, phaseFromId, resolveOverlaps, timelineSortValue } from "../lib/graphGeometry";
import { readGraphColors, type GraphColors } from "./graphColors";
import { LazyLinkIndex, linkAdjacency, neighborsOf } from "./graphLinkIndex";
import { LINK_LAYER_MIN_LINKS, LinkLayer, isWebKitCanvas } from "./graphLinkLayer";
import { nextTask } from "./nextTask";
import { GlLinkRenderer } from "./graphLinkGl";
import { OVERLAP_GAP, clampZoom, drawGraph, isZooming, type GraphBounds, type GraphDisplay, type GraphDrawRefs, type GraphLinkEndpoints, type Transform } from "./graphDraw";
import { GraphActivityCards, updateActivityCards, updateGraphHover, type ActivityCard, type GraphCardRefs, type GraphHoverCard } from "./GraphActivityCards";
import { useGraphPointer, type DragPerf, type DragState } from "./useGraphPointer";
import { GearIcon, GraphRangeRow, GraphSettingRow, GraphSettingSection, TimelapseIcon } from "./GraphSettingsControls";
import { GRAPH_OVERLAP_ALPHA, GRAPH_REHEAT_ALPHA, GRAPH_SETTLED_ALPHA, applyGraphForces, reheatGraphSimulation, createGraphSimulation, graphPhysicsTransferables, seedFromReusedLayout, seedGraphNodes, seededRandom, snapshotGraphPhysics, warmGraphSimulation, finishGraphWarmup, replayLinkCount, replayLinkOrder, type GraphPhysicsRequest, type GraphPhysicsResponse } from "../lib/graphPhysics";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { markMesaPerf } from "../lib/mesaPerf";
import { cachedGraphLayout, graphLayoutKey, persistedGraphLayout, persistedReusableLayout, rememberGraphLayout, reusableGraphLayout, type ReusableLayout } from "../lib/graphLayoutCache";
import { THUMB_CACHE_MAX, WORKER_DRAG_MIN_NODES, WORKER_SETTLE_MIN_NODES, WORKER_WARM_MIN_NODES, HEAVY_STEP_MS, ambientFrameMs } from "./graphViewTuning";

/** "Restore display defaults" covers these; filters are not display settings. */
const GRAPH_DISPLAY_KEYS = [
  "graphArrows", "graphTextFade", "graphNodeSize", "graphLinkThickness", "graphLivingMotion",
  "graphCenterForce", "graphRepelForce", "graphLinkForce", "graphLinkDistance",
] as const;

export function GraphView() {
  const notes = useAppStore((s) => s.notes);
  const indexingTextFiles = useAppStore((s) => s.indexingTextFiles);
  const files = useAppStore((s) => s.files);
  const theme = useAppStore((s) => s.theme);
  const animations = useAppStore((s) => s.settings.animations);
  const graphShowTags = useAppStore((s) => s.settings.graphShowTags);
  const graphExistingFilesOnly = useAppStore((s) => s.settings.graphExistingFilesOnly);
  const graphShowOrphans = useAppStore((s) => s.settings.graphShowOrphans);
  const graphShowAttachments = useAppStore((s) => s.settings.graphShowAttachments);
  const graphShowAllFiles = useAppStore((s) => s.settings.graphShowAllFiles);
  const graphArrows = useAppStore((s) => s.settings.graphArrows);
  const graphTextFade = useAppStore((s) => s.settings.graphTextFade);
  const graphNodeSize = useAppStore((s) => s.settings.graphNodeSize);
  const graphLinkThickness = useAppStore((s) => s.settings.graphLinkThickness);
  const graphCenterForce = useAppStore((s) => s.settings.graphCenterForce);
  const graphRepelForce = useAppStore((s) => s.settings.graphRepelForce);
  const graphLinkForce = useAppStore((s) => s.settings.graphLinkForce);
  const graphLinkDistance = useAppStore((s) => s.settings.graphLinkDistance);
  const graphLivingMotion = useAppStore((s) => s.settings.graphLivingMotion);
  const setSetting = useAppStore((s) => s.setSetting);
  const [shownCount, setShownCount] = useState(0);
  const [canvasUnavailable, setCanvasUnavailable] = useState(false);
  const [drawingFailed, setDrawingFailed] = useState(false);
  // Graph-specific settings popover (gear button in the toolbar).
  const [graphSettingsOpen, setGraphSettingsOpen] = useState(false);
  const [timelapseOn, setTimelapseOn] = useState(false);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Heavy graphs draw plain links with WebGL on this canvas, under `canvasRef`.
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  // Bounded per-drag frame samples, summarized into one local `graph-drag` mark.
  const dragPerfRef = useRef<DragPerf | null>(null);
  // Off-thread drag physics: while active, the worker owns ticking and the
  // frame loop copies its latest state into these node objects.
  const physicsRef = useRef<{
    worker: Worker | null;
    failed: boolean;
    active: boolean;
    session: number;
    nodes: GraphNode[];
    index: Map<GraphNode, number>;
    pending: GraphPhysicsResponse | null;
    /** The session is a timelapse replay (never idles; replay batches admit nodes). */
    replay: boolean;
  }>({ worker: null, failed: false, active: false, session: 0, nodes: [], index: new Map(), pending: null, replay: false });
  // Replay links in admission order (visible links are a prefix) and the
  // lookups grown batch by batch instead of rebuilt.
  const replayRef = useRef<{ links: GraphLink[]; admitAt: Int32Array; linkCount: number; adjacency: Map<string, number[]>; neighbors: Map<string, Set<string>>; byId: Map<string, GraphNode> }>(
    { links: [], admitAt: new Int32Array(0), linkCount: 0, adjacency: new Map(), neighbors: new Map(), byId: new Map() });
  // An open warm-up running in the worker: nothing paints until it returns.
  const warmRef = useRef<{ session: number; sim: Simulation<GraphNode, GraphLink>; nodes: GraphNode[]; links: GraphLink[]; layoutKey: string } | null>(null);
  const warmSessionRef = useRef(0);
  const [warmingCount, setWarmingCount] = useState(0);
  // Bumped when a stepped heavy build has resolved every note.
  const [prepareTick, setPrepareTick] = useState(0);
  const nodesRef = useRef<GraphNode[]>([]);
  const forceNodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  const timelineNodesRef = useRef<GraphNode[]>([]);
  const timelineLinksRef = useRef<GraphLink[]>([]);
  const timelineOrderRef = useRef<GraphNode[]>([]);
  const timelineNeighborsRef = useRef<Map<string, Set<string>>>(new Map());
  const timelineVisibleCountRef = useRef(0);
  const timelineStartRef = useRef(0);
  const timelineDurationRef = useRef(0);
  const replayCameraRef = useRef(false);
  const replayCameraAtRef = useRef(0);
  const replayFrameRef = useRef<Transform | null>(null);
  const topologyRef = useRef<GraphTopology | null>(null);
  // Reuses each unchanged note's resolved links between builds.
  const buildGraphRef = useRef(createGraphBuilder());
  const nodeByIdRef = useRef<Map<string, GraphNode>>(new Map());
  // For each node id, the indices of links that touch it (hover cards, focus
  // and activity links), and undirected neighbour sets for the hover focus.
  // Both derive from the shown links on first use.
  const [adjacencyRef] = useState(() => new LazyLinkIndex(() => linksRef.current, linkAdjacency, new Map<string, number[]>()));
  const [neighborsRef] = useState(() => new LazyLinkIndex(() => linksRef.current, (links) => buildNeighbors(links as GraphLink[]), new Map<string, Set<string>>()));
  // Hover focus animation: `id` is the node whose neighborhood is highlighted,
  // `k` eases 0→1 on hover and 1→0 on leave so the dim/undim glides instead of
  // snapping. `id` is kept during fade-out so the highlight releases in place.
  const focusRef = useRef<{ id: string | null; k: number }>({ id: null, k: 0 });
  // Pre-computed flat arrays of link endpoints for fast iteration.
  const linkEndpointsRef = useRef<GraphLinkEndpoints>({ sx: new Float32Array(0), sy: new Float32Array(0), tx: new Float32Array(0), ty: new Float32Array(0), sId: [], tId: [] });
  // Dirty flag: when false and sim is settled, we skip the expensive redraw.
  const resumeRef = useRef<() => void>(() => {});
  const needsRedrawRef = useRef(true);
  const reducedMotionRef = useRef(prefersReducedMotion());
  const canvasVisibleRef = useRef(true);
  // Skip idle overlap checks once settled; simulation ticks re-arm them.
  // Ambient motion changes render coordinates only, not layout x/y.
  const layoutSettledRef = useRef(false);
  // Grid over frozen layout positions; rebuilt on the first hit-test after the
  // layout re-freezes (layoutSettledRef false → true drops it).
  const hitIndexRef = useRef<GraphHitIndex | null>(null);
  const hitIndexSizeRef = useRef(1);
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 });
  const targetKRef = useRef(1); // for smooth wheel zoom
  // Screen point the eased zoom holds still (the cursor when zooming in).
  const zoomAnchorRef = useRef<{ x: number; y: number } | null>(null);
  // Pan inertia after a background drag is released, in CSS px per ms.
  const panVelocityRef = useRef({ x: 0, y: 0, at: 0 });
  const sizeRef = useRef({ w: 800, h: 600 });
  const fitPendingRef = useRef(true);
  const imgCache = useRef<Map<string, { img: HTMLImageElement; frame: number }>>(new Map());
  const pointerRef = useRef({ x: 0, y: 0, inside: false });
  const dragRef = useRef<DragState>({
    node: null,
    panning: false,
    lastX: 0,
    lastY: 0,
    moved: false,
  });
  const hoverRef = useRef<{ id: string | null; since: number; preview: boolean }>({
    id: null,
    since: 0,
    preview: false,
  });
  const shownIdRef = useRef<string | null>(null);
  // Toolbar controls sit above the canvas. While the pointer is over them,
  // their interaction must take priority over the canvas node hit-test below.
  const graphControlsHoverRef = useRef(false);
  const colorsRef = useRef<GraphColors>(readGraphColors());
  const themeDirtyRef = useRef(true);
  const graphDisplayRef = useRef<GraphDisplay>({ arrows: false, textFade: 0, nodeSize: 1, linkThickness: 1, living: false });
  const timelapseRef = useRef(false);
  graphDisplayRef.current = {
    arrows: graphArrows,
    textFade: graphTextFade,
    nodeSize: graphNodeSize,
    linkThickness: graphLinkThickness,
    living: graphLivingMotion,
  };
  timelapseRef.current = timelapseOn;
  const forceSettings = { center: graphCenterForce, repel: graphRepelForce, linkForce: graphLinkForce, linkDistance: graphLinkDistance };
  // Force values the simulation currently holds; a retune runs only when they change.
  const appliedForcesRef = useRef(forceSettings);

  // Most links on any node of the built graph: the largest node's reference.
  const maxDegreeRef = useRef(0);
  /** Zoom-independent world radius: layout, collision and bounds use it. */
  const graphNodeRadius = (n: GraphNode) =>
    nodeRadius(n, graphDisplayRef.current.nodeSize, maxDegreeRef.current);
  /** Draw-size factor at the current zoom (nodes grow in world units when zoomed out). */
  const drawScale = () => nodeDrawScale(transformRef.current.k, window.devicePixelRatio || 1);
  /** World radius as drawn at the current zoom. */
  const graphDrawRadius = (n: GraphNode) => graphNodeRadius(n) * drawScale();

  const [hover, setHover] = useState<GraphHoverCard | null>(null);
  const clearGraphHover = () => {
    hoverRef.current.id = null;
    hoverRef.current.since = 0;
    shownIdRef.current = null;
    setHover(null);
    resumeRef.current();
  };
  const suppressGraphHover = () => {
    graphControlsHoverRef.current = true;
    clearGraphHover();
  };
  const releaseGraphHover = () => {
    graphControlsHoverRef.current = false;
    pointerRef.current.inside = false;
    clearGraphHover();
  };
  // Live activity cards (files being read/edited/written/created) — same card as
  // the hover preview, floated over each active node.
  const [activity, setActivity] = useState<ActivityCard[]>([]);
  const activityRef = useRef<ActivityCard[]>([]);
  const lastActAtRef = useRef(0);
  const activitySigRef = useRef("");
  const activityHoldUntilRef = useRef(0);
  const activityClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDrawAtRef = useRef(0);
  const lastHoverAtRef = useRef(0);
  const motionUntilRef = useRef(0);
  const lastImpulseAtRef = useRef(0);
  const fastDrawUntilRef = useRef(0);
  const lastRectRef = useRef<DOMRectReadOnly | null>(null);
  const lastWindowPosRef = useRef<{ x: number; y: number } | null>(null);
  const { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave, endDrag } = useGraphPointer({
    wrapRef, transformRef, dragRef, pointerRef, simRef, physicsRef, dragPerfRef,
    needsRedrawRef, motionUntilRef, fastDrawUntilRef, replayCameraRef,
    fitPendingRef, resumeRef, forceNodesRef, panVelocityRef,
    nodeAtScreen, kickGraph, startDragPhysics, postPhysics,
  });

  function publishVisibleGraph(
    visibleNodes: GraphNode[],
    allLinks: GraphLink[],
    reheat = true
  ): void {
    stopDragPhysics();
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleLinks = allLinks.filter(
      (l) =>
        visibleIds.has(graphLinkNodeId(l.source)) &&
        visibleIds.has(graphLinkNodeId(l.target))
    );
    nodesRef.current = visibleNodes;
    forceNodesRef.current = visibleNodes;
    linksRef.current = visibleLinks;
    setShownCount(visibleNodes.length);
    nodeByIdRef.current = new Map(visibleNodes.map((n) => [n.id, n]));
    // Adjacency and neighbours rebuild from `linksRef` on first use.

    reserveLinkEndpoints(visibleLinks.length);

    const sim = simRef.current;
    if (sim) {
      const linkForce = sim.force("link") as ForceLink<GraphNode, GraphLink> | null;
      // d3 reinitializes every force in nodes(). Remove old links first:
      // their indices belong to the previous node array.
      linkForce?.links([]);
      sim.nodes(visibleNodes);
      linkForce?.links(visibleLinks);
      if (reheat) reheatGraphSimulation(sim).stop();
    }
    layoutSettledRef.current = false;
    needsRedrawRef.current = true;
    resumeRef.current();
  }

  useEffect(() => {
    themeDirtyRef.current = true;
    resumeRef.current();
  }, [theme]);

  // Dismiss the graph-settings popover on any outside click or window blur.
  useEffect(() => {
    if (!graphSettingsOpen) return;
    const close = () => setGraphSettingsOpen(false);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [graphSettingsOpen]);

  // ---- ref-only helpers (safe to capture once) ---------------------------
  /**
   * Flat link-endpoint buffers for the draw loop, which refills the first
   * `count` entries every frame. Grow only; replay batches and filters reuse them.
   */
  function reserveLinkEndpoints(count: number): void {
    const le = linkEndpointsRef.current;
    if (le.sx.length >= count) return;
    const capacity = Math.max(count, Math.ceil(le.sx.length * 1.5));
    le.sx = new Float32Array(capacity);
    le.sy = new Float32Array(capacity);
    le.tx = new Float32Array(capacity);
    le.ty = new Float32Array(capacity);
  }

  function nodeAtScreen(sx: number, sy: number): GraphNode | null {
    const t = transformRef.current;
    const gx = (sx - t.x) / t.k;
    const gy = (sy - t.y) / t.k;
    // Every node is interactive. Hit targets use layout x/y and the radius as
    // drawn at this zoom, and keep at least ~9 screen px at any zoom.
    const nodes = nodesRef.current;
    const scale = drawScale();
    const frozen = layoutSettledRef.current && !physicsRef.current.active && !dragRef.current.node;
    if (!frozen) return nearestNodeLinear(nodes, gx, gy, t.k, graphNodeRadius, scale);
    let index = hitIndexRef.current;
    if (!index || index.nodes !== nodes || hitIndexSizeRef.current !== graphDisplayRef.current.nodeSize) {
      index = new GraphHitIndex(nodes, graphNodeRadius);
      hitIndexRef.current = index;
      hitIndexSizeRef.current = graphDisplayRef.current.nodeSize;
    }
    return index.nearest(gx, gy, t.k, scale);
  }

  function graphBounds(nodes: GraphNode[]): GraphBounds {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let valid = false;
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      const r = graphNodeRadius(n) + 24;
      minX = Math.min(minX, n.x - r);
      maxX = Math.max(maxX, n.x + r);
      minY = Math.min(minY, n.y - r);
      maxY = Math.max(maxY, n.y + r);
      valid = true;
    }
    // The world origin is the layout centre.
    if (!valid) return { cx: 0, cy: 0, radius: 0, valid: false };
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return {
      cx,
      cy,
      radius: Math.max(maxX - cx, cx - minX, maxY - cy, cy - minY),
      valid: true,
    };
  }

  /**
   * Cached thumbnail for a drawn node, or null when the cache is full of
   * images drawn this frame (the node then draws as a dot instead of thrashing).
   */
  function getImage(path: string, frame: number): HTMLImageElement | null {
    const cache = imgCache.current;
    const hit = cache.get(path);
    if (hit) {
      // Most recently drawn last; the oldest entry is evicted first.
      cache.delete(path);
      hit.frame = frame;
      cache.set(path, hit);
      return hit.img;
    }
    if (cache.size >= THUMB_CACHE_MAX) {
      const [oldestPath, oldest] = cache.entries().next().value as [string, { img: HTMLImageElement; frame: number }];
      if (oldest.frame === frame) return null;
      oldest.img.onload = null;
      oldest.img.removeAttribute("src");
      cache.delete(oldestPath);
    }
    const img = new Image();
    img.onload = () => {
      needsRedrawRef.current = true;
      resumeRef.current();
    };
    img.src = urlForPath(path);
    cache.set(path, { img, frame });
    return img;
  }

  /** Living motion only: a render-layer impulse from panning or moving the window. */
  function kickGraph(dx: number, dy: number, strength = 1): void {
    const settings = getStore().settings;
    if (!settings.animations || !settings.graphLivingMotion) return;
    // Heavy graphs keep nodes in place under living motion (`drawGraph`).
    if (linksRef.current.length >= LINK_LAYER_MIN_LINKS) return;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.6) return;
    const now = performance.now();
    if (now - lastImpulseAtRef.current < 18 && strength <= 1) return;
    lastImpulseAtRef.current = now;

    const nodes = forceNodesRef.current;
    if (!nodes.length) return;

    const k = Math.max(0.35, transformRef.current.k);
    const vx = clamp((dx / k) * 0.12 * strength, -10, 10);
    const vy = clamp((dy / k) * 0.12 * strength, -10, 10);
    const stride = nodes.length > 1800 ? 4 : nodes.length > 1000 ? 2 : 1;
    for (let i = 0; i < nodes.length; i += stride) {
      const n = nodes[i];
      if (n.x == null || n.y == null) continue;
      const phase = n.renderPhase ?? phaseFromId(n.id);
      n.renderPhase = phase;
      const radial = 1 / Math.max(140, Math.hypot(n.x, n.y));
      const jitter = 0.58 + 0.32 * Math.sin(phase);
      n.renderKickVx = (n.renderKickVx ?? 0) + vx * jitter - dy * radial * 1.1 * strength;
      n.renderKickVy = (n.renderKickVy ?? 0) + vy * jitter + dx * radial * 1.1 * strength;
    }

    motionUntilRef.current = now + 1200;
    needsRedrawRef.current = true;
    resumeRef.current();
  }

  /** Lay out a new graph's open warm-up in the worker; false when no worker can take it. */
  function startWorkerWarmup(sim: Simulation<GraphNode, GraphLink>, nodes: GraphNode[], links: GraphLink[], layoutKey: string, session: number, startAlpha: number): boolean {
    const worker = physicsWorker();
    if (!worker) return false;
    const init = snapshotGraphPhysics(sim, { grab: null });
    warmRef.current = { session, sim, nodes, links, layoutKey };
    // Nothing draws or hit-tests until the warmed layout is adopted.
    nodesRef.current = [];
    forceNodesRef.current = [];
    linksRef.current = [];
    setWarmingCount(nodes.length);
    worker.postMessage({ type: "warm", session, init, count: nodes.length, startAlpha } satisfies GraphPhysicsRequest, graphPhysicsTransferables(init));
    // A layout saved earlier for the same graph wins the race with the worker.
    void persistedGraphLayout(layoutKey, nodes.length).then((state) => { if (state) adoptWarmup(session, state); });
    return true;
  }

  /** End any heavy open in progress: its pending steps and its worker warm-up. */
  function cancelWarmup(): void {
    warmSessionRef.current += 1;
    if (!warmRef.current && warmingCount === 0) return;
    warmRef.current = null;
    setWarmingCount(0);
  }

  /**
   * Open a large graph in steps so the pane paints between them: the layout
   * cache or seeding first, then the simulation and the worker warm-up. Each
   * step returns at once if the open was cancelled or replaced. Measured at
   * 10,302 nodes: one 135 ms block became steps of at most 65 ms.
   */
  function beginHeavyOpen(nodes: GraphNode[], links: GraphLink[], settings: typeof appliedForcesRef.current): void {
    const session = warmSessionRef.current;
    nodesRef.current = [];
    forceNodesRef.current = [];
    linksRef.current = [];
    setWarmingCount(nodes.length);
    const live = () => warmSessionRef.current === session && !simRef.current;
    const settle = (sim: Simulation<GraphNode, GraphLink>, layoutKey: string) => {
      warmRef.current = { session, sim, nodes, links, layoutKey };
      adoptWarmup(session, null);
    };
    const later = (run: () => void) => nextTask(() => { if (live()) run(); });
    markMesaPerf("graph-open-step", { step: "built", nodes: nodes.length });
    later(() => {
      const layoutKey = graphLayoutKey(nodes, links, settings);
      const cached = cachedGraphLayout(layoutKey, nodes.length);
      if (cached) {
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          n.x = cached[i * 4]; n.y = cached[i * 4 + 1]; n.vx = cached[i * 4 + 2]; n.vy = cached[i * 4 + 3];
        }
        later(() => {
          const sim = createGraphSimulation<GraphNode, GraphLink>(nodes, links, settings);
          appliedForcesRef.current = settings;
          finishGraphWarmup(sim, nodes.length);
          settle(sim, layoutKey);
        });
        return;
      }
      // After a small change, start from the last layout of this graph
      // (this window's, else one saved earlier) instead of a fresh one.
      const seed = (reuse: ReusableLayout | null) => later(() => {
        const neighbors = neighborsOf(new Set(nodes.map((n) => n.id)), links);
        if (reuse) seedFromReusedLayout(nodes, reuse.positions, neighbors, seededRandom(nodes.length));
        else seedGraphNodes(nodes, new Map(), neighbors, seededRandom(nodes.length));
        markMesaPerf("graph-open-step", { step: "seeded", reused: reuse?.kept ?? 0 });
        const startAlpha = reuse ? GRAPH_REHEAT_ALPHA : 1;
        later(() => {
          const sim = createGraphSimulation<GraphNode, GraphLink>(nodes, links, settings);
          appliedForcesRef.current = settings;
          if (startWorkerWarmup(sim, nodes, links, layoutKey, session, startAlpha)) {
            markMesaPerf("graph-open-step", { step: "warm-posted" });
            return;
          }
          warmGraphSimulation(sim, nodes.length, startAlpha);
          settle(sim, layoutKey);
        });
      });
      const reuse = reusableGraphLayout(nodes, settings);
      if (reuse) seed(reuse);
      else void persistedReusableLayout(nodes, settings).then(seed);
    });
  }

  /**
   * Take a warmed layout (`state` from the worker, or null when the main
   * thread already warmed `sim`) and show the graph exactly as a main-thread
   * open would. Reads refs and the store only: the worker handler keeps it.
   */
  function adoptWarmup(session: number, state: Float64Array | null): void {
    const warm = warmRef.current;
    if (!warm || warm.session !== session) return;
    warmRef.current = null;
    const { sim, nodes, links } = warm;
    if (state) {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        n.x = state[i * 4]; n.y = state[i * 4 + 1]; n.vx = state[i * 4 + 2]; n.vy = state[i * 4 + 3];
      }
      finishGraphWarmup(sim, nodes.length);
    }
    rememberGraphLayout(warm.layoutKey, nodes);
    nodesRef.current = nodes;
    forceNodesRef.current = nodes;
    linksRef.current = links;
    hitIndexRef.current = null;
    layoutSettledRef.current = false;
    completeOpen(sim, nodes);
    // A force slider moved while the worker warmed: retune now.
    const s = getStore().settings;
    const next = { center: s.graphCenterForce, repel: s.graphRepelForce, linkForce: s.graphLinkForce, linkDistance: s.graphLinkDistance };
    const applied = appliedForcesRef.current;
    if (applied.center !== next.center || applied.repel !== next.repel || applied.linkForce !== next.linkForce || applied.linkDistance !== next.linkDistance) {
      appliedForcesRef.current = next;
      applyGraphForces(sim, next);
      reheatGraphSimulation(sim).alphaTarget(0).stop();
    }
    setWarmingCount(0);
    needsRedrawRef.current = true;
    resumeRef.current();
  }

  /** The end of every open: finite positions, the visible tail, a pending fit. */
  function completeOpen(sim: Simulation<GraphNode, GraphLink>, nodes: GraphNode[]): void {
    // Safety: if the force layout ever produced a non-finite position, reset
    // it so the node still renders (otherwise it would silently vanish).
    for (const n of nodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
        const a = phaseFromId(n.id);
        n.x = Math.cos(a) * 120;
        n.y = Math.sin(a) * 120;
        n.vx = 0;
        n.vy = 0;
      }
    }
    motionUntilRef.current = performance.now() + 2400;
    simRef.current = sim;
    fitPendingRef.current = true;
  }

  function physicsWorker(): Worker | null {
    const p = physicsRef.current;
    if (p.worker || p.failed) return p.worker;
    if (typeof Worker === "undefined") {
      p.failed = true;
      return null;
    }
    try {
      const worker = new Worker(new URL("../lib/graphPhysics.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<GraphPhysicsResponse>) => {
        if (event.data.type === "warmed") {
          markMesaPerf("graph-warmup", { nodes: event.data.state.length / 4, ms: event.data.ms ?? null, helpers: event.data.helpers ?? 0 });
          adoptWarmup(event.data.session, event.data.state);
          return;
        }
        const current = physicsRef.current;
        if (!current.active || event.data.session !== current.session) return;
        current.pending = event.data;
        if (dragPerfRef.current) dragPerfRef.current.physics++;
        needsRedrawRef.current = true;
        resumeRef.current();
      };
      worker.onerror = () => {
        const current = physicsRef.current;
        current.failed = true;
        stopDragPhysics();
        worker.terminate();
        current.worker = null;
        // A warm-up the worker never returned finishes on the main thread.
        const warm = warmRef.current;
        if (warm) {
          warmGraphSimulation(warm.sim, warm.nodes.length);
          adoptWarmup(warm.session, null);
        }
      };
      p.worker = worker;
    } catch {
      p.failed = true;
    }
    return p.worker;
  }

  function copyPhysicsState(message: GraphPhysicsResponse): void {
    const { nodes } = physicsRef.current;
    const grabbed = dragRef.current.node;
    const state = message.state;
    // A replay state covers only the admitted prefix of `nodes`.
    const count = Math.min(nodes.length, state.length / 4);
    for (let i = 0; i < count; i++) {
      const n = nodes[i];
      // The grabbed node already sits at the pointer; the worker trails it.
      if (n !== grabbed) {
        n.x = state[i * 4];
        n.y = state[i * 4 + 1];
      }
      n.vx = state[i * 4 + 2];
      n.vy = state[i * 4 + 3];
    }
    simRef.current?.alpha(message.alpha);
  }

  /**
   * Apply the newest worker state. Returns "settled" when the worker finished,
   * including idle overlap cleanup, "moved" for other new state, or null.
   */
  function applyDragPhysics(): "moved" | "settled" | null {
    const p = physicsRef.current;
    const message = p.pending;
    if (!message) return null;
    p.pending = null;
    copyPhysicsState(message);
    if (message.type === "idle" && !(dragRef.current.node && dragRef.current.moved)) {
      stopDragPhysics();
      return "settled";
    }
    return "moved";
  }

  /** Return physics to the main-thread simulation with the latest worker state. */
  function stopDragPhysics(): void {
    const p = physicsRef.current;
    if (!p.active) return;
    if (p.pending) copyPhysicsState(p.pending);
    p.pending = null;
    p.active = false;
    p.replay = false;
    p.worker?.postMessage({ type: "stop", session: p.session } satisfies GraphPhysicsRequest);
  }

  function postPhysics(message: GraphPhysicsRequest): void {
    physicsRef.current.worker?.postMessage(message);
  }

  /**
   * Move a large graph's drag physics, or a heavy graph's settle (`node`
   * null), off the UI thread; a grab re-uses a running session.
   */
  function startDragPhysics(node: GraphNode | null): void {
    const p = physicsRef.current;
    const sim = simRef.current;
    if (!sim || timelapseRef.current) return;
    if (p.active) {
      if (!node) return;
      const index = p.index.get(node);
      if (index == null) stopDragPhysics();
      else postPhysics({ type: "grab", session: p.session, index, fx: node.fx ?? node.x ?? 0, fy: node.fy ?? node.y ?? 0 });
      return;
    }
    const nodes = sim.nodes();
    if (nodes.length < (node ? WORKER_DRAG_MIN_NODES : WORKER_SETTLE_MIN_NODES)) return;
    const worker = physicsWorker();
    if (!worker) return;
    const init = snapshotGraphPhysics(sim, {
      grab: node,
      overlap: {
        gap: OVERLAP_GAP,
        radius: graphNodeRadius,
        phase: (n) => phaseFromId(n.id),
      },
    });
    p.session += 1;
    p.active = true;
    p.nodes = nodes;
    p.index = new Map(nodes.map((n, i) => [n, i]));
    p.pending = null;
    worker.postMessage({ type: "start", session: p.session, init } satisfies GraphPhysicsRequest, graphPhysicsTransferables(init));
  }

  /** Hand a heavy graph's settle to the worker. Returns true when the worker owns physics. */
  function startSettlePhysics(): boolean {
    startDragPhysics(null);
    return physicsRef.current.active;
  }

  useEffect(() => () => {
    // Pending heavy-open steps stop; they must not start a new worker, and a
    // saved layout that loads after unmount must find no warm-up to adopt.
    warmSessionRef.current += 1;
    warmRef.current = null;
    physicsRef.current.worker?.terminate();
    physicsRef.current.worker = null;
    physicsRef.current.active = false;
    // A remount that keeps refs (StrictMode, a pane move in the dev app) must
    // build again: the open this cleanup cancelled never finishes otherwise.
    builtFromRef.current = null;
  }, []);

  // Center + scale so the whole graph fits the viewport.
  function fitView(): boolean {
    // Frame the whole graph. A small graph opens at Obsidian's default zoom
    // (one device pixel per world unit) instead of being blown up.
    const nodes = nodesRef.current;
    const { w, h } = sizeRef.current;
    if (nodes.length === 0 || w < 10) return false;
    const bounds = graphBounds(nodes);
    if (!bounds.valid) return false;
    const gw = Math.max(1, bounds.radius * 2);
    const gh = Math.max(1, bounds.radius * 2);
    const pad = 48;
    const dpr = window.devicePixelRatio || 1;
    const k = clampZoom(Math.min(1 / dpr, (w - pad) / gw, (h - pad) / gh), dpr);
    const t = transformRef.current;
    zoomAnchorRef.current = null;
    panVelocityRef.current = { x: 0, y: 0, at: 0 };
    t.k = k;
    targetKRef.current = k;
    t.x = w / 2 - bounds.cx * k;
    t.y = h / 2 - bounds.cy * k;
    return true;
  }

  // The graph waits for note metadata before its first build. A vault open
  // publishes the file catalog (and the selected note) before the note index:
  // a stored index arrives when it is loaded, a fresh index when indexing
  // finishes. Building from the catalog would paint and warm a partial graph,
  // then rebuild and re-settle every node when the index arrives. A vault with
  // no text files has nothing to wait for.
  const awaitingNotes = useAppStore((s) => s.notesIndexPending);

  // Inputs of the current build. A save republishes `files` with a new size
  // and mtime and `notes` with a new record for the saved note; when neither
  // changes what the graph reads, nothing rebuilds, no grab is released and
  // no replay ends (`sameGraphFiles`, `sameGraphNotes`).
  const builtFromRef = useRef<{ notes: Record<string, NoteMeta>; filters: string; files: GraphFileSnapshot } | null>(null);

  // ---- build / update the graph when notes change ------------------------
  useEffect(() => {
    const filters = [graphShowTags, graphExistingFilesOnly, graphShowOrphans, graphShowAttachments, graphShowAllFiles].join();
    const built = builtFromRef.current;
    if (!awaitingNotes && built && built.filters === filters && sameGraphNotes(built.notes, notes) && sameGraphFiles(built.files, files)) {
      built.notes = notes;
      return;
    }
    builtFromRef.current = awaitingNotes ? null : { notes, filters, files: graphFileSnapshot(files) };
    // A filter or metadata refresh replaces node objects. Release any grab
    // before replacing them so it cannot pin a stale node or keep alpha hot.
    if (dragRef.current.node || dragRef.current.panning) endDrag(false);
    stopDragPhysics();
    if (awaitingNotes) {
      // Drop any previous vault's graph and simulation so the first build of
      // this vault takes the fresh-simulation path and paints settled. Clear
      // every derived lookup too, so no previous label or hover can paint.
      cancelWarmup();
      simRef.current?.stop();
      simRef.current = null;
      nodesRef.current = [];
      forceNodesRef.current = [];
      linksRef.current = [];
      timelapseRef.current = false;
      replayCameraRef.current = false;
      setTimelapseOn(false);
      timelineNodesRef.current = [];
      timelineLinksRef.current = [];
      timelineNeighborsRef.current = new Map();
      timelineOrderRef.current = [];
      timelineVisibleCountRef.current = 0;
      nodeByIdRef.current = new Map();
      adjacencyRef.current = new Map();
      neighborsRef.current = new Map();
      linkEndpointsRef.current = { sx: new Float32Array(0), sy: new Float32Array(0), tx: new Float32Array(0), ty: new Float32Array(0), sId: [], tId: [] };
      focusRef.current = { id: null, k: 0 };
      hitIndexRef.current = null;
      topologyRef.current = null;
      clearGraphHover();
      setShownCount(0);
      needsRedrawRef.current = true;
      resumeRef.current();
      return;
    }
    const buildOptions = {
      showTags: graphShowTags,
      existingOnly: graphExistingFilesOnly,
      showOrphans: graphShowOrphans,
      showAttachments: graphShowAttachments,
      showAllFiles: graphShowAllFiles,
    };
    // A heavy first build resolves its notes in short timer steps, then this
    // effect runs again and only assembles (`prepareTick`). Measured at
    // 20,000 notes: one 150 ms build became steps of about 16 ms.
    const noteCount = Object.keys(notes).length;
    // Helper workers load while the main thread prepares a heavy open.
    if (!simRef.current && noteCount >= WORKER_WARM_MIN_NODES) physicsWorker()?.postMessage({ type: "helpers", count: noteCount } satisfies GraphPhysicsRequest);
    if (!simRef.current && noteCount >= WORKER_WARM_MIN_NODES && physicsWorker() &&
      !buildGraphRef.current.prepare(notes, files, buildOptions, performance.now() + HEAVY_STEP_MS)) {
      cancelWarmup();
      builtFromRef.current = null;
      const session = warmSessionRef.current;
      nodesRef.current = [];
      forceNodesRef.current = [];
      linksRef.current = [];
      setWarmingCount(noteCount);
      markMesaPerf("graph-open-step", { step: "prepare-start", notes: noteCount });
      const step = () => {
        if (warmSessionRef.current !== session || simRef.current) return;
        if (buildGraphRef.current.prepare(notes, files, buildOptions, performance.now() + HEAVY_STEP_MS)) {
          markMesaPerf("graph-open-step", { step: "prepared" });
          setPrepareTick((t) => t + 1);
        }
        else nextTask(step);
      };
      nextTask(step);
      needsRedrawRef.current = true;
      resumeRef.current();
      return;
    }
    const { nodes, links, topology } = buildGraphRef.current(notes, files, buildOptions);
    maxDegreeRef.current = maxNodeDegree(nodes);
    // A filter or vault change starts a fresh replay timeline. The complete
    // graph remains the source of truth; the timelapse only changes which
    // already-built nodes are admitted to the live force simulation.
    timelapseRef.current = false;
    replayCameraRef.current = false;
    timelineVisibleCountRef.current = nodes.length;
    timelineNodesRef.current = nodes;
    timelineLinksRef.current = links;
    // The replay order and its neighbour map are built when a replay starts.
    timelineOrderRef.current = [];
    setTimelapseOn(false);
    const topologyChanged = !sameGraphTopology(topologyRef.current, topology);
    topologyRef.current = topology;
    setShownCount(nodes.length);
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    // Kept nodes hold their place; new nodes are seeded next to their placed
    // neighbours, or in a ring outside the placed graph.
    const kept = new Map<string, GraphNode>();
    const fresh: GraphNode[] = [];
    for (const n of nodes) {
      const p = prev.get(n.id);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        n.x = p.x;
        n.y = p.y;
        n.vx = topologyChanged ? p.vx ?? 0 : 0;
        n.vy = topologyChanged ? p.vy ?? 0 : 0;
        kept.set(n.id, n);
      } else {
        fresh.push(n);
      }
      n.renderPhase = p?.renderPhase ?? phaseFromId(n.id);
    }
    // A rebuild during a heavy open starts that open again with this data.
    cancelWarmup();
    if (!simRef.current && nodes.length >= WORKER_WARM_MIN_NODES && physicsWorker()) {
      nodeByIdRef.current = new Map(nodes.map((n) => [n.id, n]));
      reserveLinkEndpoints(links.length);
      layoutSettledRef.current = false;
      hitIndexRef.current = null;
      beginHeavyOpen(nodes, links, forceSettings);
      needsRedrawRef.current = true;
      resumeRef.current();
      return;
    }
    if (fresh.length > 0) {
      // Seeding reads only the new nodes' neighbours.
      seedGraphNodes(fresh, kept, neighborsOf(new Set(fresh.map((n) => n.id)), links), seededRandom(nodes.length));
    }
    nodesRef.current = nodes;
    // Every node (notes, tags, unresolved links and attachments) joins one
    // force simulation, so all of them can be dragged.
    forceNodesRef.current = nodes;
    linksRef.current = links;
    nodeByIdRef.current = new Map(nodes.map((n) => [n.id, n]));

    // Adjacency and neighbours rebuild from `linksRef` on first use.

    reserveLinkEndpoints(links.length);
    layoutSettledRef.current = false;
    hitIndexRef.current = null;

    let sim = simRef.current;
    if (!sim) {
      sim = createGraphSimulation<GraphNode, GraphLink>(nodes, links, forceSettings);
      appliedForcesRef.current = forceSettings;
      // The graph is laid out before its first painted frame, and only a
      // low-energy tail remains visible. A large graph warms in the worker
      // and paints nothing until the same layout returns.
      // The same graph warms to the same layout: reuse it when this window
      // already laid it out.
      const layoutKey = graphLayoutKey(nodes, links, forceSettings);
      const cached = cachedGraphLayout(layoutKey, nodes.length);
      if (cached) {
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          n.x = cached[i * 4]; n.y = cached[i * 4 + 1]; n.vx = cached[i * 4 + 2]; n.vy = cached[i * 4 + 3];
        }
        finishGraphWarmup(sim, nodes.length);
      } else {
        // After a small change, start from this window's last layout.
        const reuse = reusableGraphLayout(nodes, forceSettings);
        if (reuse) seedFromReusedLayout(nodes, reuse.positions, neighborsOf(new Set(nodes.map((n) => n.id)), links), seededRandom(nodes.length));
        warmGraphSimulation(sim, nodes.length, reuse ? GRAPH_REHEAT_ALPHA : 1);
        rememberGraphLayout(layoutKey, nodes);
      }
      completeOpen(sim, nodes);
    } else {
      const lf = sim.force("link") as ForceLink<GraphNode, GraphLink>;
      lf.links([]);
      sim.nodes(nodes);
      lf.links(links);
      // A topology change reheats, as Obsidian does on new graph data. A
      // content-only refresh never adds energy and never cuts a settle short.
      if (topologyChanged) reheatGraphSimulation(sim);
      sim.stop();
    }
    needsRedrawRef.current = true;
    resumeRef.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the next effect retunes force settings without rebuilding nodes
  }, [
    notes,
    files,
    awaitingNotes,
    prepareTick,
    graphShowTags,
    graphExistingFilesOnly,
    graphShowOrphans,
    graphShowAttachments,
    graphShowAllFiles,
  ]);

  // Retune the current force graph in place when a force slider changes.
  // Rebuilding and synchronously warming a large vault for every range-input
  // event can starve the native webview while the user drags a slider. Keeping
  // the existing simulation preserves positions and makes the controls safe
  // to scrub continuously.
  useEffect(() => {
    const sim = simRef.current;
    const applied = appliedForcesRef.current;
    const next = { center: graphCenterForce, repel: graphRepelForce, linkForce: graphLinkForce, linkDistance: graphLinkDistance };
    if (!sim) return;
    // Mounting, or a rebuild that created the simulation with these values, is not a retune.
    if (applied.center === next.center && applied.repel === next.repel &&
        applied.linkForce === next.linkForce && applied.linkDistance === next.linkDistance) return;
    appliedForcesRef.current = next;
    stopDragPhysics();
    applyGraphForces(sim, next);
    reheatGraphSimulation(sim).alphaTarget(0).stop();
    layoutSettledRef.current = false;
    needsRedrawRef.current = true;
    resumeRef.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stopDragPhysics only reads refs; force settings drive this effect
  }, [graphCenterForce, graphRepelForce, graphLinkForce, graphLinkDistance]);

  // Node size changes drawing, hit targets and the idle overlap cleanup; it
  // is not a force, so it never reheats the simulation.
  // A heavy settle in the worker holds the old radii: hand it back so the
  // next frame restarts it with the new ones (a held grab keeps its session).
  useEffect(() => {
    if (!dragRef.current.node && !physicsRef.current.replay) stopDragPhysics();
    layoutSettledRef.current = false;
    hitIndexRef.current = null;
    needsRedrawRef.current = true;
    resumeRef.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stopDragPhysics only reads refs; node size drives this effect
  }, [graphNodeSize]);

  useEffect(() => {
    needsRedrawRef.current = true;
    resumeRef.current();
  }, [graphArrows, graphTextFade, graphLinkThickness, graphLivingMotion]);

  // ---- size the canvas to its container ----------------------------------
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    // WKWebView can grant a desynchronized 2D context while never presenting
    // its backing store. The graph then reports nodes but stays blank. The
    // ordinary 2D context is already hardware accelerated by the webview.
    ctxRef.current = canvas.getContext("2d");
    setCanvasUnavailable(ctxRef.current === null);
    // Stretch the bitmap for small resize deltas; debounce reallocation and fit.
    // Large growth reallocates immediately to keep the bitmap readable.
    let resizeTimer: number | null = null;
    const applyResize = () => {
      resizeTimer = null;
      const rect = wrap.getBoundingClientRect();
      const prev = lastRectRef.current;
      if (prev) {
        const moveDx = rect.left - prev.left;
        const moveDy = rect.top - prev.top;
        const sizeDx = rect.width - prev.width;
        const sizeDy = rect.height - prev.height;
        kickGraph(moveDx + sizeDx * 0.18, moveDy + sizeDy * 0.18, 0.9);
      }
      lastRectRef.current = rect;
      sizeRef.current = { w: rect.width, h: rect.height };
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
      // Paint the reallocated backing store immediately. Setting width/height
      // resets it to transparent per spec, but an explicit clear marks the new
      // surface dirty for the compositor so it can never be presented holding
      // stale/uninitialized rows before the next rAF draw lands.
      const ctx = ctxRef.current;
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      fitPendingRef.current = true; // re-fit when the pane resizes
      fastDrawUntilRef.current = performance.now() + 700;
      needsRedrawRef.current = true;
      resumeRef.current();
    };
    const ro = new ResizeObserver(() => {
      // Cheap per-tick: let the current bitmap scale to the new box so the
      // graph keeps filling the pane during the animation.
      const rect = wrap.getBoundingClientRect();
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
      if (resizeTimer != null) clearTimeout(resizeTimer);
      // Reallocate immediately for large growth; stretching is reserved for small resize deltas.
      const dpr = window.devicePixelRatio || 1;
      const grewALot =
        rect.width * dpr > canvas.width * 1.2 + 2 ||
        rect.height * dpr > canvas.height * 1.2 + 2;
      if (grewALot) {
        resizeTimer = null;
        applyResize();
        return;
      }
      resizeTimer = window.setTimeout(applyResize, 90);
    });
    // Display scaling can change while the CSS box does not (the window moves
    // to a monitor with another scale), so the ResizeObserver never fires.
    // Reallocate only the backing store: no re-fit, no kick, no reheat.
    const reallocForScale = () => {
      const dpr = window.devicePixelRatio || 1;
      const { w, h } = sizeRef.current;
      const width = Math.max(1, Math.floor(w * dpr));
      const height = Math.max(1, Math.floor(h * dpr));
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      const ctx = ctxRef.current;
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, height);
      }
      needsRedrawRef.current = true;
      resumeRef.current();
    };
    let scaleQuery: MediaQueryList | null = null;
    const onScaleChange = () => {
      reallocForScale();
      watchScale(); // a resolution query matches one scale; re-arm for the new one
    };
    const watchScale = () => {
      scaleQuery?.removeEventListener("change", onScaleChange);
      scaleQuery =
        typeof window.matchMedia === "function"
          ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
          : null;
      scaleQuery?.addEventListener?.("change", onScaleChange);
    };
    applyResize(); // size correctly on mount without waiting for the debounce
    ro.observe(wrap);
    watchScale();
    return () => {
      ro.disconnect();
      scaleQuery?.removeEventListener?.("change", onScaleChange);
      if (resizeTimer != null) clearTimeout(resizeTimer);
    };
  }, []);

  // ---- smooth, non-passive wheel zoom ------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      replayCameraRef.current = false;
      panVelocityRef.current = { x: 0, y: 0, at: 0 };
      // Obsidian's curve: one wheel notch (120 px) zooms by a factor of 1.5.
      const delta = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
      const target = clampZoom(targetKRef.current * Math.pow(1.5, -delta / 120), window.devicePixelRatio || 1);
      targetKRef.current = target;
      // Zooming in holds the point under the cursor; zooming out holds the view centre.
      if (target < transformRef.current.k) {
        zoomAnchorRef.current = null;
      } else {
        const rect = canvas.getBoundingClientRect();
        zoomAnchorRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }
      motionUntilRef.current = performance.now() + 2400;
      fastDrawUntilRef.current = performance.now() + 280;
      needsRedrawRef.current = true;
      resumeRef.current();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  function stopTimelapse(): void {
    timelapseRef.current = false;
    // End a worker replay with its latest state before the full graph returns.
    if (physicsRef.current.replay) stopDragPhysics();
    timelineVisibleCountRef.current = timelineNodesRef.current.length;
    publishVisibleGraph(timelineNodesRef.current, timelineLinksRef.current);
    setTimelapseOn(false);
    motionUntilRef.current = performance.now() + 1800;
  }

  /** Begin a replay: admission-ordered links, and the worker for a heavy graph. */
  function startReplay(order: GraphNode[]): void {
    const { links, admitAt } = replayLinkOrder(order, timelineLinksRef.current);
    replayRef.current = { links, admitAt, linkCount: 0, adjacency: new Map(), neighbors: new Map(), byId: new Map() };
    stopDragPhysics();
    timelineVisibleCountRef.current = 0;
    const worker = order.length >= WORKER_SETTLE_MIN_NODES ? physicsWorker() : null;
    if (worker) {
      const p = physicsRef.current;
      const rank = new Map(order.map((n, i) => [n.id, i]));
      const pairs = new Int32Array(links.length * 2);
      links.forEach((l, i) => { pairs[i * 2] = rank.get(graphLinkNodeId(l.source))!; pairs[i * 2 + 1] = rank.get(graphLinkNodeId(l.target))!; });
      p.session += 1;
      p.active = true;
      p.replay = true;
      p.nodes = order;
      p.index = new Map(order.map((n, i) => [n, i]));
      p.pending = null;
      worker.postMessage({ type: "replay", session: p.session, ids: order.map((n) => n.id), links: pairs, admitAt, settings: appliedForcesRef.current } satisfies GraphPhysicsRequest, [pairs.buffer, admitAt.buffer.slice(0)]);
      // `admitAt` stays here for prefix counts; the worker got a copy.
    }
    publishReplayBatch(0);
  }

  /**
   * Show the first `count` replay nodes. Lookups grow by the new links only;
   * the worker (heavy graphs) or the main simulation admits the batch.
   */
  function publishReplayBatch(count: number): void {
    const order = timelineOrderRef.current;
    const r = replayRef.current;
    const previous = timelineVisibleCountRef.current;
    timelineVisibleCountRef.current = count;
    const visible = order.slice(0, count);
    for (let i = previous; i < count; i++) r.byId.set(order[i].id, order[i]);
    const linkCount = replayLinkCount(r.admitAt, count);
    const join = (a: string, b: string) => { let set = r.neighbors.get(a); if (!set) r.neighbors.set(a, (set = new Set())); set.add(b); };
    for (let i = r.linkCount; i < linkCount; i++) {
      const source = graphLinkNodeId(r.links[i].source), target = graphLinkNodeId(r.links[i].target);
      for (const id of [source, target]) { let list = r.adjacency.get(id); if (!list) r.adjacency.set(id, (list = [])); list.push(i); }
      join(source, target); join(target, source);
    }
    r.linkCount = linkCount;
    const visibleLinks = r.links.slice(0, linkCount);
    nodesRef.current = visible;
    forceNodesRef.current = visible;
    linksRef.current = visibleLinks;
    nodeByIdRef.current = r.byId;
    adjacencyRef.current = r.adjacency;
    neighborsRef.current = r.neighbors;
    setShownCount(count);
    reserveLinkEndpoints(linkCount);
    const p = physicsRef.current;
    if (p.replay && p.active) {
      const seeds = new Float64Array((count - previous) * 4);
      for (let i = previous, k = 0; i < count; i++, k++) {
        const n = order[i];
        seeds[k * 4] = n.x ?? 0; seeds[k * 4 + 1] = n.y ?? 0; seeds[k * 4 + 2] = n.vx ?? 0; seeds[k * 4 + 3] = n.vy ?? 0;
      }
      p.worker?.postMessage({ type: "admit", session: p.session, count, seeds } satisfies GraphPhysicsRequest, [seeds.buffer]);
    } else {
      const sim = simRef.current;
      if (sim) {
        const linkForce = sim.force("link") as ForceLink<GraphNode, GraphLink> | null;
        linkForce?.links([]);
        sim.nodes(visible);
        linkForce?.links(visibleLinks);
        if (count > 0) reheatGraphSimulation(sim).stop();
      }
    }
    layoutSettledRef.current = false;
    hitIndexRef.current = null;
    needsRedrawRef.current = true;
    resumeRef.current();
  }

  function advanceTimelapse(now: number): boolean {
    const order = timelineOrderRef.current;
    if (order.length === 0) {
      stopTimelapse();
      return false;
    }
    const progress = clamp(
      (now - timelineStartRef.current) / timelineDurationRef.current,
      0,
      1
    );
    // Reveal in timestamp order. The batch grows with the graph size so a
    // large all-file Mesa vault still completes in a few seconds instead of
    // spending a minute on one dot at a time.
    const targetCount = Math.max(1, Math.ceil(progress * order.length));
    if (targetCount > timelineVisibleCountRef.current) {
      // Each batch is seeded like new graph data: next to its admitted
      // neighbours, or in a ring outside the admitted graph.
      seedGraphNodes(
        order.slice(timelineVisibleCountRef.current, targetCount),
        replayRef.current.byId,
        timelineNeighborsRef.current,
        seededRandom(targetCount)
      );
      publishReplayBatch(targetCount);
    }
    if (progress >= 1) {
      stopTimelapse();
      return false;
    }
    return true;
  }

  // Replay uses its own timer because idle graph frames run at a lower cadence.
  useEffect(() => {
    if (!timelapseOn) return;
    let timer: number | null = null;
    const tick = () => {
      try {
        if (advanceTimelapse(performance.now())) {
          timer = window.setTimeout(tick, 32);
        }
      } catch (error) {
        console.error("Graph timelapse stopped after an unexpected error", error);
        stopTimelapse();
      }
    };
    tick();
    return () => {
      if (timer != null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Timelapse state changes drive this effect.
  }, [timelapseOn]);

  // ---- animation loop ----------------------------------------------------
  useEffect(() => {
    let raf = 0;

    // Built once per loop lifetime so a frame passes them without allocating.
    const linkLayer = new LinkLayer();
    const linkGl = new GlLinkRenderer(() => glCanvasRef.current);
    const webkitCanvas = isWebKitCanvas(navigator.userAgent);
    const drawRefs: GraphDrawRefs = {
      canvasRef, ctxRef, sizeRef, transformRef, targetKRef, zoomAnchorRef,
      fastDrawUntilRef, dragRef, needsRedrawRef, nodesRef, forceNodesRef,
      linksRef, hoverRef, colorsRef, graphDisplayRef, focusRef, neighborsRef,
      motionUntilRef, linkEndpointsRef, adjacencyRef, nodeByIdRef,
      nodeRadius: graphNodeRadius,
      graphBounds,
      getImage,
      linkLayer,
      linkGl,
    };
    const cardRefs: GraphCardRefs = {
      transformRef, sizeRef, adjacencyRef, linksRef, nodeByIdRef,
      graphControlsHoverRef, dragRef, hoverRef, shownIdRef, pointerRef,
      activityRef, lastActAtRef, activitySigRef, activityHoldUntilRef,
      activityClearTimerRef,
      nodeRadius: graphDrawRadius,
      nodeAtScreen,
      clearGraphHover,
      setHover,
      setActivity,
    };
    const draw = (now: number, activeItems: ReturnType<typeof activeRecords>) =>
      drawGraph(
        drawRefs,
        now,
        activeItems,
        getStore().settings.animations && !reducedMotionRef.current,
        getStore().activePath
      );
    let lastInputAt = performance.now();
    let lastStateAt = -Infinity;
    const frame = () => {
      const now = performance.now();
      const animationsOn = getStore().settings.animations && !reducedMotionRef.current;
      const livingOn = animationsOn && graphDisplayRef.current.living;
      const currentWindowPos = {
        x: window.screenX ?? 0,
        y: window.screenY ?? 0,
      };
      const prevWindowPos = lastWindowPosRef.current;
      if (prevWindowPos && livingOn) {
        kickGraph(
          currentWindowPos.x - prevWindowPos.x,
          currentWindowPos.y - prevWindowPos.y,
          1.15
        );
      }
      lastWindowPosRef.current = currentWindowPos;
      if (themeDirtyRef.current) {
        colorsRef.current = readGraphColors();
        themeDirtyRef.current = false;
        needsRedrawRef.current = true;
      }
      if (fitPendingRef.current && fitView()) {
        fitPendingRef.current = false;
        needsRedrawRef.current = true;
      }
      decayActivity(now);
      // Ease the highlight toward its target (1 while a node is hovered or
      // grabbed, 0 otherwise), 10% per frame as Obsidian fades.
      {
        const f = focusRef.current;
        const highlightId = dragRef.current.node?.id ?? hoverRef.current.id;
        if (highlightId) f.id = highlightId;
        const target = highlightId ? 1 : 0;
        const dk = target - f.k;
        if (Math.abs(dk) > 0.004) {
          f.k += dk * 0.1;
          needsRedrawRef.current = true;
        } else if (f.k !== target) {
          f.k = target;
          if (target === 0) f.id = null;
          needsRedrawRef.current = true;
        }
      }
      // Pan inertia: a released background drag coasts and decays 10% per frame.
      {
        const v = panVelocityRef.current;
        if (!dragRef.current.panning && (v.x !== 0 || v.y !== 0)) {
          const dt = Math.min(34, now - v.at);
          v.at = now;
          transformRef.current.x += v.x * dt;
          transformRef.current.y += v.y * dt;
          v.x *= 0.9;
          v.y *= 0.9;
          if (Math.abs(v.x) < 0.005 && Math.abs(v.y) < 0.005) v.x = v.y = 0;
          needsRedrawRef.current = true;
        }
      }
      const sim = simRef.current;
      const isNodeDragging = !!dragRef.current.node;
      if (replayCameraRef.current) {
        const t = transformRef.current;
        if (now - replayCameraAtRef.current >= 100) {
          replayCameraAtRef.current = now;
          const bounds = graphBounds(nodesRef.current);
          if (bounds.valid) {
            const { w, h } = sizeRef.current;
            // Only zoom out as the replay grows; keep the early nodes small.
            const k = Math.min(t.k, clampZoom(
              Math.min(w - 96, h - 96) / Math.max(1, bounds.radius * 2), window.devicePixelRatio || 1));
            replayFrameRef.current = { k, x: w / 2 - bounds.cx * k, y: h / 2 - bounds.cy * k };
          }
        }
        const target = replayFrameRef.current;
        if (target) {
          t.x += (target.x - t.x) * 0.12;
          t.y += (target.y - t.y) * 0.12;
          t.k += (target.k - t.k) * 0.12;
          targetKRef.current = t.k;
          needsRedrawRef.current = true;
        }
        if (!timelapseRef.current && sim && sim.alpha() <= GRAPH_SETTLED_ALPHA) replayCameraRef.current = false;
      }
      const isMovingNode = isNodeDragging && dragRef.current.moved;
      const activeItems = activeRecords(0.02);
      const zooming = isZooming(transformRef.current.k, targetKRef.current);
      const hot = sim ? sim.alpha() > GRAPH_SETTLED_ALPHA : false;
      const moving = isMovingNode || now < motionUntilRef.current || hot || zooming;
      const frameMs = ambientFrameMs(nodesRef.current.length, moving, activeItems.length > 0);
      const dueLivingFrame =
        livingOn &&
        nodesRef.current.length > 0 &&
        now - lastDrawAtRef.current >= frameMs;

      // Tick the sim if it still has energy or we're dragging a node. While
      // the worker owns physics, take its newest state instead.
      // A slow link draw (WebKit, heavy graphs) takes worker states less
      // often, so nodes and links stay together and frames keep their rate.
      const statePaced = now - lastStateAt < linkLayer.stateInterval(webkitCanvas);
      if (physicsRef.current.active && statePaced) {
        // Keep the newest state pending until the next allowed frame.
      } else if (physicsRef.current.active) {
        const applied = applyDragPhysics();
        if (applied) lastStateAt = now;
        if (applied) {
          needsRedrawRef.current = true;
          // The worker ran the same idle overlap cleanup; skip a main-thread pass.
          layoutSettledRef.current = applied === "settled";
          hitIndexRef.current = null;
        }
      } else if (sim && hot && !isNodeDragging && startSettlePhysics()) {
        // A heavy graph's settle now runs in the worker; its first state arrives next frame.
        needsRedrawRef.current = true;
        layoutSettledRef.current = false;
      } else if (sim && (hot || isMovingNode)) {
        // One tick per frame, as Obsidian's worker steps once per display frame.
        sim.tick();
        needsRedrawRef.current = true;
        // The sim moved layout x/y — re-arm the idle overlap resolver so it
        // re-settles and re-freezes at the new rest positions.
        layoutSettledRef.current = false;
      }
      if (zooming) needsRedrawRef.current = true;

      // Run the positional overlap resolver only at idle; forceCollide owns moving and dragged nodes.
      const settling = isNodeDragging || physicsRef.current.active || (sim ? sim.alpha() > GRAPH_OVERLAP_ALPHA : false);
      if (!settling && !layoutSettledRef.current && forceNodesRef.current.length > 0) {
        if (resolveOverlaps(forceNodesRef.current, graphNodeRadius, OVERLAP_GAP, 2)) {
          needsRedrawRef.current = true;
        } else {
          // Fully resolved and the sim isn't ticking (settling is false): layout
          // x/y are now frozen and overlap-free. Stop rebuilding the grid every
          // frame until the sim ticks again (which clears this flag).
          layoutSettledRef.current = true;
          hitIndexRef.current = null;
        }
      }

      if (forceNodesRef.current.length === 0) {
        layoutSettledRef.current = true;
        hitIndexRef.current = null;
      }
      if (nodesRef.current.length === 0) fitPendingRef.current = false;

      // If there are active (flickering) nodes, we must keep redrawing.
      if (activeItems.length > 0) needsRedrawRef.current = true;
      const shouldDraw =
        needsRedrawRef.current ||
        dueLivingFrame ||
        activeItems.length > 0;

      // Living motion is not a dirty-flag side effect. When it is on, the
      // canvas redraws at the living cadence even after d3 is fully settled.
      if (shouldDraw) {
        const drawStart = performance.now();
        draw(now, activeItems);
        const perf = dragPerfRef.current;
        if (perf && perf.draw.length < 4096) perf.draw.push(performance.now() - drawStart);
        lastDrawAtRef.current = now;
        needsRedrawRef.current = false;
      }

      // Hover detection and activity cards are lightweight and can run
      // every frame even when the graph is settled.
      if (shouldDraw || now - lastHoverAtRef.current >= 40) {
        lastHoverAtRef.current = now;
        updateGraphHover(cardRefs, now);
      }
      updateActivityCards(cardRefs, now, activeItems);
    };

    // One bad frame must never kill the graph. If `frame` threw and the rAF
    // chain stopped, the canvas would stay frozen on whatever the backing
    // store last held — after a resize realloc that is a never-painted
    // surface, which the compositor shows as stale striped garbage. Keep the
    // loop alive, log (throttled) for diagnosis, and force a clean redraw.
    let lastFrameErrorAt = 0;
    let hadFrameError = false;
    let alive = true;
    let running = false;
    const loop = () => {
      raf = 0;
      if (!alive || document.hidden || !canvasVisibleRef.current) return;
      running = true;
      const frameStart = performance.now();
      try {
        frame();
        const perf = dragPerfRef.current;
        if (perf && perf.work.length < 4096) {
          const end = performance.now();
          perf.intervals.push(frameStart - perf.last);
          perf.work.push(end - frameStart);
          perf.last = frameStart;
        }
        if (hadFrameError) {
          hadFrameError = false;
          setDrawingFailed(false);
        }
      } catch (e) {
        const now = performance.now();
        hadFrameError = true;
        setDrawingFailed(true);
        if (now - lastFrameErrorAt > 5000) {
          lastFrameErrorAt = now;
          console.error("[mesa] graph frame failed:", e);
        }
        needsRedrawRef.current = true;
      }
      running = false;
      const livingOn = getStore().settings.animations && !reducedMotionRef.current && graphDisplayRef.current.living;
      const zooming = isZooming(transformRef.current.k, targetKRef.current);
      const focusTarget = hoverRef.current.id || dragRef.current.node ? 1 : 0;
      const coasting = panVelocityRef.current.x !== 0 || panVelocityRef.current.y !== 0;
      const urgent = needsRedrawRef.current || coasting ||
        (simRef.current?.alpha() ?? 0) > GRAPH_SETTLED_ALPHA || zooming ||
        dragRef.current.node || dragRef.current.panning || activeRecords(0.02).length ||
        activityRef.current.some(item => item.visible) ||
        focusRef.current.k !== focusTarget || (hoverRef.current.preview && hoverRef.current.id && shownIdRef.current !== hoverRef.current.id) || !layoutSettledRef.current ||
        replayCameraRef.current || fitPendingRef.current || timelapseRef.current ||
        physicsRef.current.active;
      const quiet = !document.hasFocus() || performance.now() - lastInputAt >= 15_000;
      // The CSS backdrop pauses with the living frames (`.graph-wrap.quiet`).
      wrapRef.current?.classList.toggle("quiet", quiet);
      if ((livingOn && nodesRef.current.length > 0) || urgent) {
        if (urgent || !quiet) raf = requestAnimationFrame(loop);
      }
    };
    const resume = () => {
      if (alive && !running && !raf && !document.hidden && canvasVisibleRef.current) {
        needsRedrawRef.current = true;
        raf = requestAnimationFrame(loop);
      }
    };
    resumeRef.current = resume;
    const themeObserver = new MutationObserver(() => {
      themeDirtyRef.current = true;
      resume();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-mode"] });
    const stopActivity = onActivityChange(resume);
    const stopSettings = useAppStore.subscribe((state, previous) => {
      if (state.settings.animations !== previous.settings.animations || state.settings.graphLivingMotion !== previous.settings.graphLivingMotion || state.activePath !== previous.activePath) resume();
    });
    const stopMotion = onReducedMotionChange(reduce => {
      reducedMotionRef.current = reduce;
      needsRedrawRef.current = true;
      resume();
    });
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1];
      if (entry) canvasVisibleRef.current = entry.isIntersecting;
      resume();
    });
    if (wrapRef.current) observer?.observe(wrapRef.current);
    const input = () => { lastInputAt = performance.now(); resume(); };
    window.addEventListener("focus", input);
    window.addEventListener("pointermove", input, { passive: true });
    window.addEventListener("pointerdown", input, { passive: true });
    window.addEventListener("keydown", input);
    window.addEventListener("wheel", input, { passive: true });
    document.addEventListener("visibilitychange", resume);
    resume();
    return () => {
      alive = false;
      linkLayer.release();
      linkGl.release();
      resumeRef.current = () => {};
      themeObserver.disconnect();
      stopActivity(); stopSettings(); stopMotion(); observer?.disconnect();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", input);
      window.removeEventListener("pointermove", input);
      window.removeEventListener("pointerdown", input);
      window.removeEventListener("keydown", input);
      window.removeEventListener("wheel", input);
      cancelAnimationFrame(raf);
      // The card updater owns this timer; clear its latest value on unmount.
      const timer = cardRefs.activityClearTimerRef.current;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- The animation loop owns a single mount lifetime.
  }, []);

  return (
    <div
      className={
        "graph-wrap" +
        (animations && graphLivingMotion ? " living" : "")
      }
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
    >
      <canvas ref={glCanvasRef} className="graph-links-gl" aria-hidden="true" />
      <canvas ref={canvasRef} className="graph-canvas" />
      {canvasUnavailable && <div className="graph-index-status" role="status">Graph drawing is unavailable in this webview.</div>}
      {drawingFailed && <div className="graph-index-status" role="status">Graph drawing was interrupted. Resize the pane or reopen the graph to retry.</div>}
      {warmingCount > 0 && <div className="graph-index-status" role="status">{`Laying out ${warmingCount.toLocaleString()} nodes…`}</div>}
      {indexingTextFiles > 0 && <div className="graph-index-status" role="status">{awaitingNotes ? `Indexing ${indexingTextFiles} text files before the graph is drawn…` : `Indexing ${indexingTextFiles} text files; graph may grow.`}</div>}
      <GraphActivityCards hover={hover} activity={activity} />
      <div
        className="graph-controls"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerEnter={suppressGraphHover}
        onPointerMove={suppressGraphHover}
        onPointerLeave={releaseGraphHover}
      >
        <span className="graph-count">
          {shownCount} shown
        </span>
        <button
          className="seg-btn"
          onClick={() => {
            replayCameraRef.current = false;
            fitPendingRef.current = true;
            resumeRef.current();
          }}
          title="Fit the graph to the view"
        >
          Fit
        </button>
        <button
          className={"seg-btn" + (timelapseOn ? " on" : "")}
          onClick={() => {
            if (timelapseRef.current) {
              stopTimelapse();
              return;
            }
            const order = [...timelineNodesRef.current].sort((a, b) => {
              const timeDelta = timelineSortValue(a) - timelineSortValue(b);
              return timeDelta || a.id.localeCompare(b.id);
            });
            if (order.length === 0) return;
            timelineOrderRef.current = order;
            timelineNeighborsRef.current = buildNeighbors(timelineLinksRef.current);
            timelapseRef.current = true;
            timelineStartRef.current = performance.now();
            timelineDurationRef.current = clamp(
              3200 + order.length * 1.4,
              3200,
              8000
            );
            endDrag(false);
            clearGraphHover();
            replayFrameRef.current = null;
            replayCameraRef.current = true;
            startReplay(order);
            setTimelapseOn(true);
            motionUntilRef.current = performance.now() + 1800;
            needsRedrawRef.current = true;
            resumeRef.current();
          }}
          title={timelapseOn ? "Stop timelapse animation" : "Start timelapse animation"}
          aria-label={timelapseOn ? "Stop timelapse animation" : "Start timelapse animation"}
          aria-pressed={timelapseOn}
        >
          <TimelapseIcon />
        </button>
        <div
          className="graph-settings-wrap"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            className={
              "seg-btn graph-settings-btn" + (graphSettingsOpen ? " on" : "")
            }
            onClick={(e) => {
              e.stopPropagation();
              setGraphSettingsOpen((v) => !v);
            }}
            title="Graph settings"
            aria-label="Graph settings"
            aria-expanded={graphSettingsOpen}
          >
            <GearIcon />
          </button>
          {graphSettingsOpen && (
            <div
              className="graph-settings-pop"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="graph-settings-title">Graph settings</div>
              <GraphSettingSection title="Filters">
                <GraphSettingRow
                  label="Tags"
                  on={graphShowTags}
                  onChange={(v) => setSetting("graphShowTags", v)}
                />
                <GraphSettingRow
                  label="Attachments"
                  on={graphShowAttachments || graphShowAllFiles}
                  disabled={graphShowAllFiles}
                  onChange={(v) => setSetting("graphShowAttachments", v)}
                />
                <GraphSettingRow
                  label="Existing files only"
                  on={graphExistingFilesOnly}
                  onChange={(v) => setSetting("graphExistingFilesOnly", v)}
                />
                <GraphSettingRow
                  label="Orphans"
                  on={graphShowOrphans || graphShowAllFiles}
                  disabled={graphShowAllFiles}
                  onChange={(v) => setSetting("graphShowOrphans", v)}
                />
                <GraphSettingRow
                  label="All files"
                  on={graphShowAllFiles}
                  onChange={(v) => setSetting("graphShowAllFiles", v)}
                />
              </GraphSettingSection>
              <GraphSettingSection title="Display">
                <GraphSettingRow
                  label="Arrows"
                  on={graphArrows}
                  onChange={(v) => setSetting("graphArrows", v)}
                />
                <GraphRangeRow
                  label="Text fade threshold"
                  value={graphTextFade}
                  min={-3}
                  max={3}
                  step={0.1}
                  formatValue={(v) => v.toFixed(1)}
                  onChange={(v) => setSetting("graphTextFade", v)}
                />
                <GraphRangeRow
                  label="Node size"
                  value={graphNodeSize}
                  min={0.1}
                  max={5}
                  step={0.05}
                  formatValue={(v) => v.toFixed(2)}
                  onChange={(v) => setSetting("graphNodeSize", v)}
                />
                <GraphRangeRow
                  label="Link thickness"
                  value={graphLinkThickness}
                  min={0.1}
                  max={5}
                  step={0.05}
                  formatValue={(v) => v.toFixed(2)}
                  onChange={(v) => setSetting("graphLinkThickness", v)}
                />
                <GraphSettingRow
                  label="Living motion"
                  on={graphLivingMotion}
                  onChange={(v) => setSetting("graphLivingMotion", v)}
                />
              </GraphSettingSection>
              <GraphSettingSection title="Forces">
                <GraphRangeRow
                  label="Center force"
                  value={graphCenterForce}
                  min={0}
                  max={1}
                  step={0.01}
                  formatValue={(v) => v.toFixed(2)}
                  onChange={(v) => setSetting("graphCenterForce", v)}
                />
                <GraphRangeRow
                  label="Repel force"
                  value={graphRepelForce}
                  min={0}
                  max={20}
                  step={0.5}
                  formatValue={(v) => v.toFixed(1)}
                  onChange={(v) => setSetting("graphRepelForce", v)}
                />
                <GraphRangeRow
                  label="Link force"
                  value={graphLinkForce}
                  min={0}
                  max={1}
                  step={0.01}
                  formatValue={(v) => v.toFixed(2)}
                  onChange={(v) => setSetting("graphLinkForce", v)}
                />
                <GraphRangeRow
                  label="Link distance"
                  value={graphLinkDistance}
                  min={30}
                  max={500}
                  step={1}
                  onChange={(v) => setSetting("graphLinkDistance", v)}
                />
              </GraphSettingSection>
              <button
                type="button"
                className="graph-settings-reset"
                onClick={() => {
                  for (const key of GRAPH_DISPLAY_KEYS) setSetting(key, DEFAULT_SETTINGS[key]);
                }}
              >
                Restore display defaults
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="graph-hint">
        scroll to zoom · drag to pan · drag a node to move · hover to peek ·
        click to pop out · double-click to fit
      </div>
    </div>
  );
}
