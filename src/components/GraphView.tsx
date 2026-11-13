import { prefersReducedMotion, onReducedMotionChange } from "../lib/motion";
import { useEffect, useRef, useState } from "react";
import {
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type ForceCollide,
  type Simulation,
} from "d3-force";
import type { GraphNode, GraphLink } from "../types";
import { useAppStore, getStore } from "../store";
import { buildGraph, buildNeighbors } from "../lib/graph";
import {
  decayActivity,
  activeRecords,
  onActivityChange,
} from "../lib/activity";
import { urlForPath } from "../lib/vault";

import { GraphHitIndex, clamp, graphLinkNodeId, nearestNodeLinear, nodeRadius, phaseFromId, resolveOverlaps, timelineSortValue } from "../lib/graphGeometry";
import { readGraphColors, type GraphColors } from "./graphColors";
import { OVERLAP_GAP, drawGraph, type GraphBounds, type GraphDrawRefs, type GraphLinkEndpoints, type Transform } from "./graphDraw";
import { GraphActivityCards, updateActivityCards, updateGraphHover, type ActivityCard, type GraphCardRefs, type GraphHoverCard } from "./GraphActivityCards";
import { useGraphPointer, type DragPerf, type DragState } from "./useGraphPointer";
import { GearIcon, GraphRangeRow, GraphSettingRow, GraphSettingSection, TimelapseIcon } from "./GraphSettingsControls";
import { createGraphSimulation, graphPhysicsTransferables, graphSimulationTier, snapshotGraphPhysics, type GraphPhysicsRequest, type GraphPhysicsResponse } from "../lib/graphPhysics";
import { DOUBLE_TICK_BELOW, GOLDEN_ANGLE, THUMB_CACHE_MAX, WORKER_DRAG_MIN_NODES, WORKER_SETTLE_MIN_NODES, ambientFrameMs, dragVelocityCap } from "./graphViewTuning";

export function GraphView() {
  const notes = useAppStore((s) => s.notes);
  const indexingTextFiles = useAppStore((s) => s.indexingTextFiles);
  const files = useAppStore((s) => s.files);
  const theme = useAppStore((s) => s.theme);
  const hardwareAccel = useAppStore((s) => s.settings.hardwareAccel);
  const animations = useAppStore((s) => s.settings.animations);
  const graphShowTags = useAppStore((s) => s.settings.graphShowTags);
  const graphExistingFilesOnly = useAppStore((s) => s.settings.graphExistingFilesOnly);
  const graphShowOrphans = useAppStore((s) => s.settings.graphShowOrphans);
  const graphShowAttachments = useAppStore((s) => s.settings.graphShowAttachments);
  const graphArrows = useAppStore((s) => s.settings.graphArrows ?? false);
  const graphTextFadeThreshold = useAppStore(
    (s) => s.settings.graphTextFadeThreshold ?? 0.42
  );
  const graphNodeSize = useAppStore((s) => s.settings.graphNodeSize ?? 1);
  const graphLinkThickness = useAppStore(
    (s) => s.settings.graphLinkThickness ?? 1
  );
  const graphCenterForce = useAppStore((s) => s.settings.graphCenterForce ?? 0.5);
  const graphRepelForce = useAppStore((s) => s.settings.graphRepelForce ?? 10);
  const graphLinkForce = useAppStore((s) => s.settings.graphLinkForce ?? 1);
  const graphLinkDistance = useAppStore(
    (s) => s.settings.graphLinkDistance ?? 250
  );
  const setSetting = useAppStore((s) => s.setSetting);
  const [shownCount, setShownCount] = useState(0);
  const [canvasUnavailable, setCanvasUnavailable] = useState(false);
  const [drawingFailed, setDrawingFailed] = useState(false);
  // Graph-specific settings popover (gear button in the toolbar).
  const [graphSettingsOpen, setGraphSettingsOpen] = useState(false);
  const [timelapseOn, setTimelapseOn] = useState(false);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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
  }>({ worker: null, failed: false, active: false, session: 0, nodes: [], index: new Map(), pending: null });
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
  const replayOriginRef = useRef({ x: 0, y: 0 });
  const replayCameraAtRef = useRef(0);
  const replayFrameRef = useRef<Transform | null>(null);
  const graphSigRef = useRef("");
  // Cached once per notes-change so the per-frame label pass never re-sorts.
  const degreeSortedRef = useRef<GraphNode[]>([]);
  const nodeByIdRef = useRef<Map<string, GraphNode>>(new Map());
  // Pre-computed adjacency: for each node id, the indices of links that touch
  // it.  Used by placePreviewCard so it doesn't scan all links.
  const adjacencyRef = useRef<Map<string, number[]>>(new Map());
  // Undirected neighbor sets for the Obsidian-style hover focus.
  const neighborsRef = useRef<Map<string, Set<string>>>(new Map());
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
  const hoverRef = useRef<{ id: string | null; since: number }>({
    id: null,
    since: 0,
  });
  const shownIdRef = useRef<string | null>(null);
  // Toolbar controls sit above the canvas. While the pointer is over them,
  // their interaction must take priority over the canvas node hit-test below.
  const graphControlsHoverRef = useRef(false);
  const colorsRef = useRef<GraphColors>(readGraphColors());
  const themeDirtyRef = useRef(true);
  const graphDisplayRef = useRef({
    arrows: false,
    textFadeThreshold: 0.42,
    nodeSize: 1,
    linkThickness: 1,
  });
  const timelapseRef = useRef(false);
  graphDisplayRef.current = {
    arrows: graphArrows,
    textFadeThreshold: graphTextFadeThreshold,
    nodeSize: graphNodeSize,
    linkThickness: graphLinkThickness,
  };
  timelapseRef.current = timelapseOn;

  const graphNodeRadius = (n: GraphNode) =>
    nodeRadius(n, graphDisplayRef.current.nodeSize);

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
  // Last timestamp each node had live activity. Used to fade the steady
  // "open file" highlight back in smoothly after a typing burst ends, instead
  // of snapping it on the moment flicker decays below threshold.
  const recentActivityRef = useRef<Map<string, number>>(new Map());
  const lastRectRef = useRef<DOMRectReadOnly | null>(null);
  const lastWindowPosRef = useRef<{ x: number; y: number } | null>(null);
  const { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave, endDrag } = useGraphPointer({
    wrapRef, transformRef, dragRef, pointerRef, simRef, physicsRef, dragPerfRef,
    needsRedrawRef, motionUntilRef, fastDrawUntilRef, replayCameraRef,
    fitPendingRef, resumeRef, forceNodesRef,
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
    degreeSortedRef.current = [...visibleNodes].sort((a, b) => b.degree - a.degree);
    nodeByIdRef.current = new Map(visibleNodes.map((n) => [n.id, n]));

    const adjacency = new Map<string, number[]>();
    for (let i = 0; i < visibleLinks.length; i++) {
      const l = visibleLinks[i];
      const source = graphLinkNodeId(l.source);
      const target = graphLinkNodeId(l.target);
      const sourceLinks = adjacency.get(source) ?? [];
      sourceLinks.push(i);
      adjacency.set(source, sourceLinks);
      const targetLinks = adjacency.get(target) ?? [];
      targetLinks.push(i);
      adjacency.set(target, targetLinks);
    }
    adjacencyRef.current = adjacency;
    neighborsRef.current = buildNeighbors(visibleLinks);

    reserveLinkEndpoints(visibleLinks.length);

    const sim = simRef.current;
    if (sim) {
      const linkForce = sim.force("link") as ReturnType<
        typeof forceLink<GraphNode, GraphLink>
      > | null;
      // d3 reinitializes every force in nodes(). Remove old links first:
      // their indices belong to the previous node array.
      linkForce?.links([]);
      sim.nodes(visibleNodes);
      linkForce?.links(visibleLinks);
      if (reheat) sim.alpha(Math.max(sim.alpha(), 0.2)).stop();
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
    // Every node is interactive, including the orphan halo. Hit targets use
    // layout x/y and keep at least ~9 screen px at any zoom.
    const nodes = nodesRef.current;
    const frozen = layoutSettledRef.current && !physicsRef.current.active && !dragRef.current.node;
    if (!frozen) return nearestNodeLinear(nodes, gx, gy, t.k, graphNodeRadius);
    let index = hitIndexRef.current;
    if (!index || index.nodes !== nodes || hitIndexSizeRef.current !== graphDisplayRef.current.nodeSize) {
      index = new GraphHitIndex(nodes, graphNodeRadius);
      hitIndexRef.current = index;
      hitIndexSizeRef.current = graphDisplayRef.current.nodeSize;
    }
    return index.nearest(gx, gy, t.k);
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
    if (!valid) {
      return {
        cx: sizeRef.current.w / 2,
        cy: sizeRef.current.h / 2,
        radius: 0,
        valid: false,
      };
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return {
      cx,
      cy,
      radius: Math.max(maxX - cx, cx - minX, maxY - cy, cy - minY),
      valid: true,
    };
  }

  function seedForceNodes(nodes: GraphNode[]): void {
    if (nodes.length === 0) return;
    const { w, h } = sizeRef.current;
    const cx = w / 2;
    const cy = h / 2;
    // Seed compactly near the center; the force sim (charge + links + collide)
    // then relaxes into Obsidian-like clusters. A compact seed lets the sim
    // settle fast without biasing toward any rigid ring structure.
    // Degree-0 nodes start in a loose outer band and then follow the same
    // repulsion, centering, collision, and drag rules as linked nodes.
    const base = 40 + Math.sqrt(nodes.length) * 8;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const angle = phaseFromId(n.id) + i * GOLDEN_ANGLE;
      const radius =
        n.degree === 0
          ? base * 2 + Math.random() * base
          : base + Math.random() * 60;
      n.x = cx + Math.cos(angle) * radius;
      n.y = cy + Math.sin(angle) * radius;
      n.vx = 0;
      n.vy = 0;
      n.fx = null;
      n.fy = null;
    }
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

  function kickGraph(dx: number, dy: number, strength = 1): void {
    if (!getStore().settings.animations) return;
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
    const cx = sizeRef.current.w / 2;
    const cy = sizeRef.current.h / 2;
    const stride = nodes.length > 1800 ? 4 : nodes.length > 1000 ? 2 : 1;
    for (let i = 0; i < nodes.length; i += stride) {
      const n = nodes[i];
      if (n.x == null || n.y == null) continue;
      const phase = n.renderPhase ?? phaseFromId(n.id);
      n.renderPhase = phase;
      const dxn = n.x - cx;
      const dyn = n.y - cy;
      const radial = 1 / Math.max(140, Math.hypot(dxn, dyn));
      const jitter = 0.58 + 0.32 * Math.sin(phase);
      n.renderKickVx = (n.renderKickVx ?? 0) + vx * jitter - dy * radial * 1.1 * strength;
      n.renderKickVy = (n.renderKickVy ?? 0) + vy * jitter + dx * radial * 1.1 * strength;
    }

    motionUntilRef.current = now + 1200;
    needsRedrawRef.current = true;
    resumeRef.current();
  }

  function clampNodeVelocities(dragging: GraphNode | null): void {
    const nodes = forceNodesRef.current;
    if (!nodes.length) return;
    // During drag, a hub's neighbors follow the link force with a modest
    // velocity cap; overlap resolution stays suspended until drag ends.
    const baseCap = dragVelocityCap(nodes.length);
    for (const n of nodes) {
      if (n === dragging) continue;
      // Same cap for every node — no hub boost. Calm, uniform follow.
      if (n.vx != null) n.vx = clamp(n.vx, -baseCap, baseCap);
      if (n.vy != null) n.vy = clamp(n.vy, -baseCap, baseCap);
    }
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
    for (let i = 0; i < nodes.length; i++) {
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
    p.worker?.postMessage({ type: "stop", session: p.session } satisfies GraphPhysicsRequest);
  }

  function postPhysics(message: GraphPhysicsRequest): void {
    physicsRef.current.worker?.postMessage(message);
  }

  /**
   * Move a large graph's drag physics, or a heavy graph's settle (`node`
   * null), off the UI thread; a grab re-uses a running session.
   */
  function startDragPhysics(node: GraphNode | null, collideIterations: number | undefined): void {
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
    const collide = sim.force("collide") as ForceCollide<GraphNode> | null | undefined;
    const init = snapshotGraphPhysics(sim, {
      collideIterations: collideIterations ?? collide?.iterations() ?? 1,
      velocityCap: dragVelocityCap(forceNodesRef.current.length),
      doubleTickBelow: DOUBLE_TICK_BELOW,
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
    startDragPhysics(null, undefined);
    return physicsRef.current.active;
  }

  useEffect(() => () => {
    physicsRef.current.worker?.terminate();
    physicsRef.current.worker = null;
    physicsRef.current.active = false;
  }, []);

  // Center + scale so the whole graph fits the viewport.
  function fitView(): boolean {
    // Frame the whole graph — connected cluster plus the orphan halo.
    const nodes = nodesRef.current;
    const { w, h } = sizeRef.current;
    if (nodes.length === 0 || w < 10) return false;
    const bounds = graphBounds(nodes);
    if (!bounds.valid) return false;
    const gw = Math.max(1, bounds.radius * 2);
    const gh = Math.max(1, bounds.radius * 2);
    const pad = 48;
    const k = Math.min(1.8, Math.max(0.03, Math.min((w - pad) / gw, (h - pad) / gh)));
    const t = transformRef.current;
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

  // ---- build / update the graph when notes change ------------------------
  useEffect(() => {
    // A filter or metadata refresh replaces node objects. Release any grab
    // before replacing them so it cannot pin a stale node or keep alpha hot.
    if (dragRef.current.node || dragRef.current.panning) endDrag(false);
    stopDragPhysics();
    if (awaitingNotes) {
      // Drop any previous vault's graph and simulation so the first build of
      // this vault takes the fresh-simulation path and paints settled. Clear
      // every derived lookup too, so no previous label or hover can paint.
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
      degreeSortedRef.current = [];
      nodeByIdRef.current = new Map();
      adjacencyRef.current = new Map();
      neighborsRef.current = new Map();
      linkEndpointsRef.current = { sx: new Float32Array(0), sy: new Float32Array(0), tx: new Float32Array(0), ty: new Float32Array(0), sId: [], tId: [] };
      focusRef.current = { id: null, k: 0 };
      hitIndexRef.current = null;
      graphSigRef.current = "";
      clearGraphHover();
      setShownCount(0);
      needsRedrawRef.current = true;
      resumeRef.current();
      return;
    }
    const { nodes, links } = buildGraph(notes, files, {
      showTags: graphShowTags,
      existingOnly: graphExistingFilesOnly,
      showOrphans: graphShowOrphans,
      showAttachments: graphShowAttachments,
    });
    // A filter or vault change starts a fresh replay timeline. The complete
    // graph remains the source of truth; the timelapse only changes which
    // already-built nodes are admitted to the live force simulation.
    timelapseRef.current = false;
    replayCameraRef.current = false;
    timelineVisibleCountRef.current = nodes.length;
    timelineNodesRef.current = nodes;
    timelineLinksRef.current = links;
    timelineNeighborsRef.current = buildNeighbors(links);
    timelineOrderRef.current = [...nodes].sort((a, b) => {
      const timeDelta = timelineSortValue(a) - timelineSortValue(b);
      return timeDelta || a.id.localeCompare(b.id);
    });
    setTimelapseOn(false);
    const graphSig = [
      nodes.map((n) => n.id).sort().join("\u001f"),
      links
        .map((l) => {
          const s = typeof l.source === "string" ? l.source : l.source.id;
          const t = typeof l.target === "string" ? l.target : l.target.id;
          return `${s}->${t}`;
        })
        .sort()
        .join("\u001f"),
    ].join("\u001e");
    const topologyChanged = graphSig !== graphSigRef.current;
    graphSigRef.current = graphSig;
    setShownCount(nodes.length);
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const { w, h } = sizeRef.current;
    for (const n of nodes) {
      const p = prev.get(n.id);
      if (p) {
        n.x = p.x;
        n.y = p.y;
        n.vx = topologyChanged ? p.vx ?? 0 : 0;
        n.vy = topologyChanged ? p.vy ?? 0 : 0;
        n.renderPhase = p.renderPhase ?? phaseFromId(n.id);
      } else {
        const a = Math.random() * Math.PI * 2;
        const r = 80 + Math.sqrt(nodes.length) * 14 + Math.random() * 90;
        n.x = w / 2 + Math.cos(a) * r;
        n.y = h / 2 + Math.sin(a) * r;
        n.renderPhase = phaseFromId(n.id);
      }
    }
    nodesRef.current = nodes;
    // Every node (notes, tags, phantoms and attachments) joins one force
    // simulation, so all of them can be dragged. Barnes-Hut charge and
    // settling to rest keep multi-thousand-node vaults responsive.
    const forceNodes = nodes;
    forceNodesRef.current = forceNodes;

    const newForceNodes = forceNodes.filter((n) => !prev.has(n.id));
    if (newForceNodes.length > 0) seedForceNodes(newForceNodes);
    linksRef.current = links;
    degreeSortedRef.current = [...nodes].sort((a, b) => b.degree - a.degree);
    nodeByIdRef.current = new Map(nodes.map((n) => [n.id, n]));

    // Pre-compute adjacency list for placePreviewCard (avoids O(m) scan per card).
    const adj = new Map<string, number[]>();
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      const sId = typeof l.source === "string" ? l.source : l.source.id;
      const tId = typeof l.target === "string" ? l.target : l.target.id;
      let a1 = adj.get(sId);
      if (!a1) { a1 = []; adj.set(sId, a1); }
      a1.push(i);
      let a2 = adj.get(tId);
      if (!a2) { a2 = []; adj.set(tId, a2); }
      a2.push(i);
    }
    adjacencyRef.current = adj;
    // Same links, never mutated: share the timeline map instead of rebuilding it.
    neighborsRef.current = timelineNeighborsRef.current;

    reserveLinkEndpoints(links.length);

    needsRedrawRef.current = true;
    resumeRef.current();

    let sim = simRef.current;
    if (!sim) {
      // Size tiers weaken charge, widen its range and decay faster for large
      // graphs so they settle sooner (see graphSimulationTier).
      const tier = graphSimulationTier(forceNodes.length);
      sim = createGraphSimulation<GraphNode, GraphLink>(forceNodes, links, {
        w,
        h,
        radius: (node: unknown) => graphNodeRadius(node as GraphNode),
        repel: graphRepelForce,
        center: graphCenterForce,
        linkForce: graphLinkForce,
        linkDistance: graphLinkDistance,
      });
      // Tiny prewarm only: enough to avoid an initial singular pile-up without
      // blocking first paint for seconds on larger vaults.
      for (let i = 0; i < tier.warmTicks; i++) sim.tick();
      // Safety: if the force layout ever produced a non-finite position, reset
      // it so the node still renders (otherwise it would silently vanish).
      for (const n of nodes) {
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
          const a = Math.random() * Math.PI * 2;
          n.x = w / 2 + Math.cos(a) * 120;
          n.y = h / 2 + Math.sin(a) * 120;
          n.vx = 0;
          n.vy = 0;
        }
      }
      sim.alpha(tier.openAlpha);
      motionUntilRef.current = performance.now() + 2400;
      simRef.current = sim;
      fitPendingRef.current = true;
      resumeRef.current();
    } else {
      const lf = sim.force("link") as ReturnType<
        typeof forceLink<GraphNode, GraphLink>
      >;
      lf.links([]);
      sim.nodes(forceNodes);
      lf.links(links);
      sim.alpha(topologyChanged ? 0.22 : 0).stop();
      needsRedrawRef.current = true;
      resumeRef.current();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the next effect retunes force settings without rebuilding nodes
  }, [
    notes,
    files,
    awaitingNotes,
    graphShowTags,
    graphExistingFilesOnly,
    graphShowOrphans,
    graphShowAttachments,
  ]);

  // Retune the current force graph in place when a graph setting changes.
  // Rebuilding and synchronously warming a large vault for every range-input
  // event can starve the native webview while the user drags a slider. Keeping
  // the existing simulation preserves positions and makes the controls safe
  // to scrub continuously.
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    stopDragPhysics();
    const count = timelineNodesRef.current.length;
    const big = count > 300;
    const huge = count > 800;
    const chargeStrength = (huge ? -12 : big ? -18 : -24) * graphRepelForce;
    const chargeDistMax = huge ? 1400 : big ? 1100 : 900;
    const centerStrength = clamp(graphCenterForce, 0, 1) * 0.1;
    const pullStrength = centerStrength * 0.4;
    const charge = sim.force("charge") as ReturnType<
      typeof forceManyBody<GraphNode>
    > | null;
    charge?.strength(chargeStrength).distanceMax(chargeDistMax);
    const link = sim.force("link") as ReturnType<
      typeof forceLink<GraphNode, GraphLink>
    > | null;
    link
      ?.distance((l) => {
        const source = l.source as GraphNode | string;
        const target = l.target as GraphNode | string;
        const sourceRadius = typeof source === "object" ? graphNodeRadius(source) : 6;
        const targetRadius = typeof target === "object" ? graphNodeRadius(target) : 6;
        return sourceRadius + targetRadius + graphLinkDistance / 10;
      })
      .strength((l) => {
        const source = l.source as GraphNode | string;
        const target = l.target as GraphNode | string;
        const sourceDegree = typeof source === "object" ? source.degree ?? 1 : 1;
        const targetDegree = typeof target === "object" ? target.degree ?? 1 : 1;
        return clamp(
          (1 / Math.max(1, Math.min(sourceDegree, targetDegree))) * graphLinkForce,
          0,
          2
        );
      });
    const center = sim.force("center") as ReturnType<
      typeof forceCenter
    > | null;
    center?.strength(centerStrength);
    const xForce = sim.force("x") as ReturnType<typeof forceX<GraphNode>> | null;
    const yForce = sim.force("y") as ReturnType<typeof forceY<GraphNode>> | null;
    xForce?.strength(pullStrength);
    yForce?.strength(pullStrength);
    const collide = sim.force("collide") as ReturnType<
      typeof forceCollide<GraphNode>
    > | null;
    collide?.radius((node) => graphNodeRadius(node) + 6);
    sim.alpha(Math.max(sim.alpha(), count > 0 ? 0.12 : 0)).alphaTarget(0).stop();
    layoutSettledRef.current = false;
    needsRedrawRef.current = true;
    resumeRef.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stopDragPhysics only reads refs; graph settings drive this effect
  }, [
    graphNodeSize,
    graphCenterForce,
    graphRepelForce,
    graphLinkForce,
    graphLinkDistance,
  ]);

  useEffect(() => {
    needsRedrawRef.current = true;
    resumeRef.current();
  }, [graphArrows, graphTextFadeThreshold, graphLinkThickness]);

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
      const t = transformRef.current;
      const factor = Math.exp(-e.deltaY * 0.0012);
      targetKRef.current = Math.min(4, Math.max(0.03, targetKRef.current * factor));
      // anchor the zoom on the cursor immediately for responsiveness
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const k2 = t.k + (targetKRef.current - t.k) * 0.35;
      t.x = x - (x - t.x) * (k2 / t.k);
      t.y = y - (y - t.y) * (k2 / t.k);
      t.k = k2;
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
    timelineVisibleCountRef.current = timelineNodesRef.current.length;
    publishVisibleGraph(timelineNodesRef.current, timelineLinksRef.current);
    setTimelapseOn(false);
    motionUntilRef.current = performance.now() + 1800;
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
      const admitted = new Map(nodesRef.current.map((node) => [node.id, node]));
      const neighbors = timelineNeighborsRef.current;
      for (const node of order.slice(timelineVisibleCountRef.current, targetCount)) {
        const linked = [...(neighbors.get(node.id) ?? [])]
          .map((id) => admitted.get(id)).filter((n): n is GraphNode => !!n);
        const cx = linked.length ? linked.reduce((sum, n) => sum + n.x!, 0) / linked.length : replayOriginRef.current.x;
        const cy = linked.length ? linked.reduce((sum, n) => sum + n.y!, 0) / linked.length : replayOriginRef.current.y;
        const angle = phaseFromId(node.id);
        const radius = linked.length ? graphNodeRadius(node) + 16 : 12 * Math.sqrt(admitted.size + 1);
        node.x = cx + Math.cos(angle) * radius;
        node.y = cy + Math.sin(angle) * radius;
        node.vx = node.vy = 0;
        node.fx = node.fy = null;
        admitted.set(node.id, node);
      }
      timelineVisibleCountRef.current = targetCount;
      publishVisibleGraph(
        order.slice(0, targetCount),
        timelineLinksRef.current,
        true
      );
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
    const drawRefs: GraphDrawRefs = {
      canvasRef, ctxRef, sizeRef, transformRef, targetKRef, fastDrawUntilRef,
      dragRef, pointerRef, needsRedrawRef, nodesRef, forceNodesRef, linksRef,
      hoverRef, colorsRef, graphDisplayRef, focusRef, neighborsRef,
      motionUntilRef, recentActivityRef, linkEndpointsRef, adjacencyRef,
      nodeByIdRef, degreeSortedRef,
      nodeRadius: graphNodeRadius,
      graphBounds,
      getImage,
    };
    const cardRefs: GraphCardRefs = {
      transformRef, sizeRef, adjacencyRef, linksRef, nodeByIdRef,
      graphControlsHoverRef, dragRef, hoverRef, shownIdRef, pointerRef,
      activityRef, lastActAtRef, activitySigRef, activityHoldUntilRef,
      activityClearTimerRef,
      nodeRadius: graphNodeRadius,
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
    const frame = () => {
      const now = performance.now();
      const animationsOn = getStore().settings.animations && !reducedMotionRef.current;
      const currentWindowPos = {
        x: window.screenX ?? 0,
        y: window.screenY ?? 0,
      };
      const prevWindowPos = lastWindowPosRef.current;
      if (prevWindowPos && animationsOn) {
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
      // Ease the hover-focus dim toward its target (1 while a node is
      // hovered, 0 otherwise). ~0.16/frame ≈ a 150ms glide at 60fps.
      {
        const f = focusRef.current;
        if (hoverRef.current.id) f.id = hoverRef.current.id;
        const target = hoverRef.current.id ? 1 : 0;
        const dk = target - f.k;
        if (Math.abs(dk) > 0.004) {
          f.k += dk * 0.16;
          needsRedrawRef.current = true;
        } else if (f.k !== target) {
          f.k = target;
          if (target === 0) f.id = null;
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
            const k = Math.min(t.k, Math.max(0.03,
              Math.min(w - 96, h - 96) / Math.max(1, bounds.radius * 2)));
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
        if (!timelapseRef.current && sim && sim.alpha() <= 0.004) replayCameraRef.current = false;
      }
      const isMovingNode = isNodeDragging && dragRef.current.moved;
      const activeItems = activeRecords(0.02);
      const zooming = Math.abs(targetKRef.current - transformRef.current.k) > 0.0005;
      const moving =
        isMovingNode ||
        now < motionUntilRef.current ||
        (sim ? sim.alpha() > 0.004 : false) ||
        zooming;
      const frameMs = ambientFrameMs(nodesRef.current.length, moving, activeItems.length > 0);
      const dueLivingFrame =
        animationsOn &&
        nodesRef.current.length > 0 &&
        now - lastDrawAtRef.current >= frameMs;

      // Tick the sim if it still has energy or we're dragging a node. While
      // the worker owns physics, take its newest state instead.
      if (physicsRef.current.active) {
        const applied = applyDragPhysics();
        if (applied) {
          needsRedrawRef.current = true;
          // The worker ran the same idle overlap cleanup; skip a main-thread pass.
          layoutSettledRef.current = applied === "settled";
          hitIndexRef.current = null;
        }
      } else if (sim && sim.alpha() > 0.004 && !isNodeDragging && startSettlePhysics()) {
        // A heavy graph's settle now runs in the worker; its first state arrives next frame.
        needsRedrawRef.current = true;
        layoutSettledRef.current = false;
      } else if (sim && (sim.alpha() > 0.004 || isMovingNode)) {
        const ticks =
          nodesRef.current.length < DOUBLE_TICK_BELOW && sim.alpha() > 0.06 && !isNodeDragging ? 2 : 1;
        for (let i = 0; i < ticks; i++) {
          sim.tick();
          if (isMovingNode) clampNodeVelocities(dragRef.current.node);
        }
        needsRedrawRef.current = true;
        // The sim moved layout x/y — re-arm the idle overlap resolver so it
        // re-settles and re-freezes at the new rest positions.
        layoutSettledRef.current = false;
      }
      if (zooming) needsRedrawRef.current = true;

      // Run the positional overlap resolver only at idle; forceCollide owns moving and dragged nodes.
      const settling = isNodeDragging || physicsRef.current.active || (sim ? sim.alpha() > 0.02 : false);
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

      // Ambient motion is not a dirty-flag side effect. When animations are on,
      // the canvas redraws at the living cadence even after d3 is fully settled.
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
      const animationsOn = getStore().settings.animations && !reducedMotionRef.current;
      const zooming = Math.abs(targetKRef.current - transformRef.current.k) > 0.0005;
      const focusTarget = hoverRef.current.id ? 1 : 0;
      const urgent = needsRedrawRef.current ||
        (simRef.current?.alpha() ?? 0) > 0.004 || zooming ||
        dragRef.current.node || dragRef.current.panning || activeRecords(0.02).length ||
        activityRef.current.some(item => item.visible) ||
        focusRef.current.k !== focusTarget || (hoverRef.current.id && shownIdRef.current !== hoverRef.current.id) || !layoutSettledRef.current ||
        replayCameraRef.current || fitPendingRef.current || timelapseRef.current ||
        physicsRef.current.active;
      if ((animationsOn && nodesRef.current.length > 0) || urgent) {
        const quiet = !document.hasFocus() || performance.now() - lastInputAt >= 15_000;
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
      if (state.settings.animations !== previous.settings.animations || state.activePath !== previous.activePath) resume();
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
        (hardwareAccel ? " accel" : "") +
        (animations ? " live" : "")
      }
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
    >
      <canvas ref={canvasRef} className="graph-canvas" />
      {canvasUnavailable && <div className="graph-index-status" role="status">Graph drawing is unavailable in this webview.</div>}
      {drawingFailed && <div className="graph-index-status" role="status">Graph drawing was interrupted. Resize the pane or reopen the graph to retry.</div>}
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
            const order = timelineOrderRef.current;
            if (order.length === 0) return;
            timelapseRef.current = true;
            timelineVisibleCountRef.current = 0;
            timelineStartRef.current = performance.now();
            timelineDurationRef.current = clamp(
              3200 + order.length * 1.4,
              3200,
              8000
            );
            endDrag(false);
            clearGraphHover();
            const bounds = graphBounds(timelineNodesRef.current);
            replayOriginRef.current = { x: bounds.cx, y: bounds.cy };
            replayFrameRef.current = null;
            replayCameraRef.current = true;
            publishVisibleGraph([], timelineLinksRef.current, false);
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
                  on={graphShowAttachments}
                  onChange={(v) => setSetting("graphShowAttachments", v)}
                />
                <GraphSettingRow
                  label="Existing files only"
                  on={graphExistingFilesOnly}
                  onChange={(v) => setSetting("graphExistingFilesOnly", v)}
                />
                <GraphSettingRow
                  label="Orphans"
                  on={graphShowOrphans}
                  onChange={(v) => setSetting("graphShowOrphans", v)}
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
                  value={graphTextFadeThreshold}
                  min={0}
                  max={0.9}
                  step={0.01}
                  formatValue={(v) => v.toFixed(2)}
                  onChange={(v) => setSetting("graphTextFadeThreshold", v)}
                />
                <GraphRangeRow
                  label="Node size"
                  value={graphNodeSize}
                  min={0.6}
                  max={2}
                  step={0.05}
                  formatValue={(v) => v.toFixed(2)}
                  onChange={(v) => setSetting("graphNodeSize", v)}
                />
                <GraphRangeRow
                  label="Link thickness"
                  value={graphLinkThickness}
                  min={0.5}
                  max={2.5}
                  step={0.05}
                  formatValue={(v) => v.toFixed(2)}
                  onChange={(v) => setSetting("graphLinkThickness", v)}
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
                  min={0.1}
                  max={2}
                  step={0.05}
                  formatValue={(v) => v.toFixed(2)}
                  onChange={(v) => setSetting("graphLinkForce", v)}
                />
                <GraphRangeRow
                  label="Link distance"
                  value={graphLinkDistance}
                  min={50}
                  max={500}
                  step={10}
                  onChange={(v) => setSetting("graphLinkDistance", v)}
                />
              </GraphSettingSection>
              <button
                type="button"
                className="graph-settings-reset"
                onClick={() => {
                  setSetting("graphArrows", false);
                  setSetting("graphTextFadeThreshold", 0.42);
                  setSetting("graphNodeSize", 1);
                  setSetting("graphLinkThickness", 1);
                  setSetting("graphCenterForce", 0.5);
                  setSetting("graphRepelForce", 10);
                  setSetting("graphLinkForce", 1);
                  setSetting("graphLinkDistance", 250);
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
