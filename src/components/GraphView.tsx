import { useEffect, useRef, useState } from "react";
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
} from "d3-force";
import type { GraphNode, GraphLink } from "../types";
import { useAppStore, getStore } from "../store";
import { buildGraph, buildNeighbors } from "../lib/graph";
import {
  decayActivity,
  activeRecords,
  type ActivityOp,
} from "../lib/activity";
import { urlForPath } from "../lib/vault";
import { PreviewCard } from "./PreviewCard";

interface ActivityCard {
  id: string;
  op: ActivityOp;
  status?: string;
  detail?: string;
  added?: number;
  removed?: number;
  filesChanged?: number;
  seed?: string;
  visible: boolean;
  x: number;
  y: number;
}
const ACTIVITY_CAP = 4; // most cards shown at once, strongest first
const ACTIVITY_LINGER_MS = 1000;
const ACTIVITY_FADE_MS = 240;
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(v, hi));

const CARD_W = 360;
const CARD_H = 300;
const ACTIVE_FRAME_MS = 1000 / 60;
const IDLE_FRAME_MS = 1000 / 60;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
// How many of the highest-degree nodes always get a title label (the rest
// show only on hover/active). degreeSortedRef is pre-sorted by degree desc.
const LABEL_TOP_N = 10;
// World-space gap enforced by resolveOverlaps() every frame. Both forceCollide
// and the ambient breathing budget key off it: breathing amplitude is clamped
// below OVERLAP_GAP/2 so two nodes drifting toward each other can never
// visually cross, giving a hard no-overlap guarantee that coexists with living
// motion. Constant (not zoom-dependent) so layout is stable under zoom.
const OVERLAP_GAP = 8;

function ambientFrameMs(nodeCount: number, moving: boolean, active: boolean): number {
  if (moving || active) return ACTIVE_FRAME_MS;
  if (nodeCount > 4000) return 1000 / 20;
  if (nodeCount > 2600) return 1000 / 30;
  if (nodeCount > 1800) return 1000 / 36;
  if (nodeCount > 1200) return 1000 / 45;
  return IDLE_FRAME_MS;
}

function rectContains(
  r: { x: number; y: number; w: number; h: number },
  x: number,
  y: number
): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function rectLinePenalty(
  r: { x: number; y: number; w: number; h: number },
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const steps = 12;
  let hits = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (rectContains(r, ax + (bx - ax) * t, ay + (by - ay) * t)) hits++;
  }
  return hits;
}

function phaseFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 0xffffffff) * Math.PI * 2;
}

// Node size scales with the number of links (in + out), mirroring Obsidian:
// "the more nodes that reference it, the bigger it gets". sqrt keeps hubs
// prominent without exploding, and degree-0 notes stay small dots.
function nodeRadius(n: GraphNode, size = 1): number {
  return Math.min(24 * size, (2.4 + 1.75 * Math.sqrt(n.degree)) * size);
}

function graphLinkNodeId(node: string | GraphNode): string {
  return typeof node === "string" ? node : node.id;
}

function timelineSortValue(n: GraphNode): number {
  return Number.isFinite(n.timelineTime) ? n.timelineTime! : Number.POSITIVE_INFINITY;
}

/** Alpha-independent overlap resolver. d3's `forceCollide` only runs while the
 *  simulation is ticking (alpha > ~0.004); the moment the sim settles it stops,
 *  freezing whatever overlaps remain — which is why nodes still overlapped at
 *  idle. This directly separates any overlapping force nodes using a spatial
 *  hash grid (O(n) per pass) and is called every frame from the draw loop, so
 *  overlaps can never persist at rest. It is the hard guarantee that nodes
 *  never overlap. Fixed (dragged) nodes are not moved but still push others. */
export function resolveOverlaps(
  nodes: GraphNode[],
  radiusOf: (n: GraphNode) => number,
  gap: number,
  iterations: number
): boolean {
  let moved = false;
  // Respect the displayed size, including enlarged hubs.
  const maxRadius = nodes.reduce((max, n) => Math.max(max, radiusOf(n)), 0);
  const cell = 2 * maxRadius + 2 * gap + 4;
  for (let iter = 0; iter < iterations; iter++) {
    const grid = new Map<string, GraphNode[]>();
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      const k = Math.floor(n.x / cell) + "," + Math.floor(n.y / cell);
      const arr = grid.get(k);
      if (arr) arr.push(n);
      else grid.set(k, [n]);
    }
    for (const n of nodes) {
      if (n.x == null || n.y == null || n.fx != null) continue;
      const rn = radiusOf(n) + gap;
      const gx = Math.floor(n.x / cell);
      const gy = Math.floor(n.y / cell);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const arr = grid.get(gx + dx + "," + (gy + dy));
          if (!arr) continue;
          for (const m of arr) {
            if (m === n || m.x == null || m.y == null) continue;
            const min = rn + radiusOf(m) + gap;
            let ddx: number = n.x - m.x;
            let ddy: number = n.y - m.y;
            let d2: number = ddx * ddx + ddy * ddy;
            if (d2 >= min * min) continue;
            let d: number = Math.sqrt(d2);
            if (d < 1e-6) {
              const a = phaseFromId(n.id) + iter * 1.7;
              ddx = Math.cos(a);
              ddy = Math.sin(a);
              d = 1;
              d2 = 1;
            }
            const overlap = min - d;
            if (overlap < 0.01) continue; // skip sub-pixel jitter
            // Fixed nodes (m.fx != null) don't move, so n takes the full push.
            const nShare = m.fx != null ? 1 : 0.5;
            const ux: number = ddx / d;
            const uy: number = ddy / d;
            n.x = n.x + ux * overlap * nShare;
            n.y = n.y + uy * overlap * nShare;
            if (m.fx == null) {
              m.x = m.x - ux * overlap * (1 - nShare);
              m.y = m.y - uy * overlap * (1 - nShare);
            }
            moved = true;
          }
        }
      }
    }
  }
  return moved;
}

/** Tag and phantom nodes are synthetic — they have no backing file, so they
 *  can't be opened or previewed like a real note. */
function isSyntheticNode(n: GraphNode): boolean {
  return n.kind === "tag" || n.kind === "phantom";
}

/** Pick the fill colour for a graph node. */
function nodeFill(n: GraphNode, c: GraphColors): string {
  switch (n.kind) {
    case "note":
      return n.degree > 0 ? c.node : c.nodeIsolated;
    case "tag":
      return c.nodeTag;
    case "phantom":
      return c.nodePhantom;
    case "attachment":
      return c.nodeAttachment;
  }
}

interface GraphColors {
  node: string;
  nodeActive: string;
  nodeIsolated: string;
  link: string;
  linkActive: string;
  flickerRgb: string; // "r,g,b" so we can vary alpha for the glow
  bloomAlpha: number;
  label: string;
  labelHalo: string; // outline behind labels so they read over anything
  thumbBorder: string;
  nodeTag: string;
  nodePhantom: string;
  nodeAttachment: string;
}

function readGraphColors(): GraphColors {
  const cs = getComputedStyle(document.documentElement);
  const g = (name: string, fallback: string) => {
    const v = cs.getPropertyValue(name).trim();
    return v || fallback;
  };
  const n = (name: string, fallback: number) => {
    const value = Number.parseFloat(cs.getPropertyValue(name).trim());
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    node: g("--graph-node", "#7d8bb0"),
    nodeActive: g("--graph-node-active", "#58a6ff"),
    nodeIsolated: g("--graph-node-isolated", "#55607d"),
    link: g("--graph-link", "rgba(120,134,170,0.18)"),
    linkActive: g("--graph-link-active", "rgba(88,166,255,0.55)"),
    flickerRgb: g("--graph-flicker-rgb", "122,230,168"),
    bloomAlpha: n("--graph-bloom-alpha", 1),
    label: g("--graph-label", "rgba(220,228,245,0.92)"),
    labelHalo: g("--graph-label-halo", "rgba(0,0,0,0.55)"),
    thumbBorder: g("--graph-thumb-border", "rgba(203,230,255,0.5)"),
    nodeTag: g("--graph-node-tag", "#3fb6c9"),
    nodePhantom: g("--graph-node-phantom", "#4a4a55"),
    // Obsidian's attachment ring reads as a warm yellow-green dot field.
    nodeAttachment: g("--graph-node-attachment", "#c9c96a"),
  };
}

interface Transform {
  x: number;
  y: number;
  k: number;
}
interface DragState {
  node: GraphNode | null;
  panning: boolean;
  lastX: number;
  lastY: number;
  moved: boolean;
  offsetX?: number;
  offsetY?: number;
}

/** A gear glyph for the graph-settings button. */
function GearIcon() {
  return (
    <svg
      className="graph-gear-icon"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** Obsidian-style timelapse wand glyph. */
function TimelapseIcon() {
  return (
    <svg
      className="graph-timelapse-icon"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 19 9.8-9.8" />
      <path d="m7.2 16.8 2.2 2.2" />
      <path d="m14.8 4.2.5 1.8 1.8.5-1.8.5-.5 1.8-.5-1.8-1.8-.5 1.8-.5.5-1.8Z" />
      <path d="m19.1 11.2.3 1.2 1.2.3-1.2.3-.3 1.2-.3-1.2-1.2-.3 1.2-.3.3-1.2Z" />
    </svg>
  );
}

/** One labelled on/off row in the graph-settings popover. */
function GraphSettingRow({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="graph-set-row">
      <span className="graph-set-label">{label}</span>
      <button
        type="button"
        className={"toggle" + (on ? " on" : "")}
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

function GraphSettingSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="graph-settings-section">
      <div className="graph-settings-section-title">{title}</div>
      {children}
    </section>
  );
}

function GraphRangeRow({
  label,
  value,
  min,
  max,
  step,
  formatValue,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  formatValue?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="graph-range-row">
      <span className="graph-range-label">{label}</span>
      <output>{formatValue ? formatValue(value) : value}</output>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
       value={value}
       aria-label={label}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(clamp(next, min, max));
        }}
     />
    </label>
  );
}

export function GraphView() {
  const notes = useAppStore((s) => s.notes);
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
  // Graph-specific settings popover (gear button in the toolbar).
  const [graphSettingsOpen, setGraphSettingsOpen] = useState(false);
  const [timelapseOn, setTimelapseOn] = useState(false);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
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
  // Double-click (background) → fit view.
  const lastBgClickRef = useRef(0);
  // Pre-computed flat arrays of link endpoints for fast iteration.
  const linkEndpointsRef = useRef<{
    sx: Float32Array; sy: Float32Array;
    tx: Float32Array; ty: Float32Array;
    sId: string[]; tId: string[];
  }>({ sx: new Float32Array(0), sy: new Float32Array(0), tx: new Float32Array(0), ty: new Float32Array(0), sId: [], tId: [] });
  // Dirty flag: when false and sim is settled, we skip the expensive redraw.
  const needsRedrawRef = useRef(true);
  // Dirty flag for the idle no-overlap resolver. resolveOverlaps() reads/writes
  // only LAYOUT x/y; ambient living motion writes renderX/renderY and never
  // touches x/y, so once the resolver reports moved=false and the sim has
  // stopped ticking, re-running it every idle frame is a provable no-op (it just
  // rebuilds a hash-grid Map to confirm nothing moved — ~1ms @650n / ~4ms
  // @2000n wasted per frame). We freeze here and skip the resolver until layout
  // x/y can change again. The ONLY force-node x/y writers are sim.tick() (gated
  // on alpha>0.004) and resolveOverlaps itself; the tick block below clears this
  // flag whenever the sim ticks, so any real movement re-arms the resolver.
  const layoutSettledRef = useRef(false);
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 });
  const targetKRef = useRef(1); // for smooth wheel zoom
  const sizeRef = useRef({ w: 800, h: 600 });
  const fitPendingRef = useRef(true);
  const imgCache = useRef<Map<string, HTMLImageElement>>(new Map());
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

  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(
    null
  );
  const clearGraphHover = () => {
    hoverRef.current.id = null;
    hoverRef.current.since = 0;
    shownIdRef.current = null;
    setHover(null);
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

  function publishVisibleGraph(
    visibleNodes: GraphNode[],
    allLinks: GraphLink[],
    reheat = true
  ): void {
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

    const endpointCache = linkEndpointsRef.current;
    endpointCache.sx = new Float32Array(visibleLinks.length);
    endpointCache.sy = new Float32Array(visibleLinks.length);
    endpointCache.tx = new Float32Array(visibleLinks.length);
    endpointCache.ty = new Float32Array(visibleLinks.length);
    endpointCache.sId = visibleLinks.map((l) => graphLinkNodeId(l.source));
    endpointCache.tId = visibleLinks.map((l) => graphLinkNodeId(l.target));

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
  }

  useEffect(() => {
    themeDirtyRef.current = true;
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
  function nodeAtScreen(sx: number, sy: number): GraphNode | null {
    const t = transformRef.current;
    const gx = (sx - t.x) / t.k;
    const gy = (sy - t.y) / t.k;
    const hit = (nodes: GraphNode[]): GraphNode | null => {
      let nearest: GraphNode | null = null;
      let nearestDistance = Infinity;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.x == null || n.y == null) continue;
        // Minimum SCREEN-space hit radius (like Obsidian): a degree-0 dot is
        // ~2.4 world units, which at fit zoom is a ~1px target — effectively
        // ungrabbable. Guarantee ~9px of screen no matter the zoom.
        const r = Math.max(graphNodeRadius(n) + 6, 9 / t.k);
        const dx = gx - n.x;
        const dy = gy - n.y;
        const distance = dx * dx + dy * dy;
        if (distance <= r * r && distance < nearestDistance) {
          nearest = n;
          nearestDistance = distance;
        }
      }
      return nearest;
    };
    // Hit-test every node — the force cluster and the orphan halo are both
    // interactive (hover preview, click to open, drag to move).
    return hit(nodesRef.current);
  }

  function graphBounds(nodes: GraphNode[]): {
    cx: number;
    cy: number;
    radius: number;
    valid: boolean;
  } {
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
    // settle fast without biasing toward any rigid ring structure. Degree-0
    // nodes (orphan notes + unlinked attachments) seed in a loose outer band:
    // repulsion would push them there anyway, so starting them outside the
    // cluster settles the Obsidian-style halo quickly instead of forcing
    // hundreds of dots to shove their way out through the linked core.
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

  function getImage(path: string): HTMLImageElement {
    const cache = imgCache.current;
    let img = cache.get(path);
    if (!img) {
      img = new Image();
      img.src = urlForPath(path);
      cache.set(path, img);
    }
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
  }

  function clampNodeVelocities(dragging: GraphNode | null): void {
    const nodes = forceNodesRef.current;
    if (!nodes.length) return;
    // Gentle velocity bounding during drag. The goal is the opposite of what
    // the old code did: a hub's neighbors should follow *calmly*, not get a
    // *higher* cap that lets them fling (the prior `hubCap = baseCap + 6`
    // amplified hub-drag jitter — INDEX's 227 neighbors would leap every frame).
    // d3/Obsidian/Logseq all let the link force pull neighbors in gently with
    // modest per-tick velocity; a high cap + the hard resolveOverlaps snap
    // (now gated off during drag) is what produced the "going haywire" feel.
    const baseCap = nodes.length > 700 ? 4 : nodes.length > 350 ? 5 : 6;
    for (const n of nodes) {
      if (n === dragging) continue;
      // Same cap for every node — no hub boost. Calm, uniform follow.
      if (n.vx != null) n.vx = clamp(n.vx, -baseCap, baseCap);
      if (n.vy != null) n.vy = clamp(n.vy, -baseCap, baseCap);
    }
  }

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

  // ---- build / update the graph when notes change ------------------------
  useEffect(() => {
    // A filter or metadata refresh replaces node objects. Release any grab
    // before replacing them so it cannot pin a stale node or keep alpha hot.
    if (dragRef.current.node || dragRef.current.panning) endDrag(false);
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
    // EVERY node — notes, tags, phantoms, and all attachments — joins the one
    // force simulation, exactly like Obsidian. (Unlinked attachments used to
    // be static "field" ring nodes for performance, but that made them
    // undraggable and visually rigid; Barnes-Hut charge + the sim settling to
    // rest keeps even multi-thousand-node vaults responsive.)
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
    neighborsRef.current = buildNeighbors(links);

    // Pre-compute flat typed arrays for the link-drawing hot loop.
    const le = linkEndpointsRef.current;
    const lc = links.length;
    le.sx = new Float32Array(lc);
    le.sy = new Float32Array(lc);
    le.tx = new Float32Array(lc);
    le.ty = new Float32Array(lc);
    le.sId = new Array(lc);
    le.tId = new Array(lc);

    needsRedrawRef.current = true;

    let sim = simRef.current;
    if (!sim) {
      // For large graphs, weaken charge and increase distanceMax so the O(n²)
      // force computation spreads out faster, and raise alphaDecay so it settles
      // sooner rather than simmering for hundreds of extra ticks.
      const simCount = forceNodes.length;
      const big = simCount > 300;
      const huge = simCount > 800;
      const chargeStrength = (huge ? -12 : big ? -18 : -24) * graphRepelForce;
      const chargeDistMax = huge ? 1400 : big ? 1100 : 900;
      const warmTicks = huge ? 42 : big ? 56 : 78;
      // Obsidian runs EVERY node through one force simulation with the same
      // repulsion and the same gentle centering — there is no special "orphan
      // packing". Orphan notes (degree 0) simply have no links, so the shared
      // repel force pushes them
      // outward and the centering rings them loosely around the connected core:
      // a sparse halo, not the dense packed donut a weak-orphan-charge produces.
      // Match Obsidian by giving orphans the same charge + pull as linked nodes;
      // their links (absent) are the only thing that differs.
      const chargeFor = (_n: GraphNode) => chargeStrength;
      const centerStrength = clamp(graphCenterForce, 0, 1) * 0.1;
      const pullFor = (_n: GraphNode) => centerStrength * 0.4;

      sim = forceSimulation<GraphNode, GraphLink>(forceNodes)
        .force(
          "charge",
          forceManyBody<GraphNode>()
            .strength(chargeFor)
            .distanceMax(chargeDistMax)
            .theta(huge ? 0.95 : 0.9)
        )
        .force(
          "link",
          forceLink<GraphNode, GraphLink>(links)
            .id((d) => d.id)
            // Link distance respects both endpoint radii so the link force can
            // never pull two connected nodes closer than their circles + a gap.
            // (Hubs have radius up to 24; a flat 48px distance let two hubs be
            // pulled into overlap because their collision radii sum to >48.)
            .distance((l) => {
              const s = l.source as GraphNode | string;
              const t = l.target as GraphNode | string;
              const rs = typeof s === "object" ? graphNodeRadius(s) : 6;
              const rt = typeof t === "object" ? graphNodeRadius(t) : 6;
              return rs + rt + graphLinkDistance / 10;
            })
            // Degree-scaled link strength — d3's DEFAULT behavior, which
            // Obsidian/Logseq/Athens/Foam all inherit unchanged. Strength per
            // link = 1 / min(deg(source), deg(target)), clamped, so a link
            // between two hubs (e.g. INDEX deg 227 ↔ Privacy deg 65) is weak
            // (~0.015) and doesn't violently yank them together, while a leaf
            // link stays strong and snugs up to its hub. The prior flat 0.55
            // gave INDEX's 227 links full aggregate strength → flinging/jitter
            // on hub drag. This is the single biggest hub-jitter fix.
            .strength((l) => {
              const s = l.source as GraphNode | string;
              const t = l.target as GraphNode | string;
              const ds = typeof s === "object" ? s.degree ?? 1 : 1;
              const dt = typeof t === "object" ? t.degree ?? 1 : 1;
              return clamp(
                (1 / Math.max(1, Math.min(ds, dt))) * graphLinkForce,
                0,
                2
              );
            })
        )
        .force("center", forceCenter(w / 2, h / 2).strength(centerStrength))
        .force(
          "collide",
          forceCollide<GraphNode>()
            // Smooth iterative collision WHILE THE SIM HAS ENERGY (incl. drag
            // + settle). This is what Obsidian/Logseq/Athens use — they have
            // no hard alpha-independent resolver fighting the sim during drag.
            // resolveOverlaps() (below) is gated off during drag/settle and
            // only takes over at idle as the no-overlap backstop. Both key off
            // OVERLAP_GAP so ambient breathing can't cross it.
            .radius((n) => graphNodeRadius(n) + 6)
            .strength(1)
            .iterations(big ? 3 : 4)
        )
        .force("x", forceX<GraphNode>(w / 2).strength(pullFor))
        .force("y", forceY<GraphNode>(h / 2).strength(pullFor));
      // Lower friction than d3's 0.4 default would be too loose at scale, but
      // the prior 0.44–0.52 was *above* default — i.e. stickier than Obsidian,
      // which killed the springy release exhale. Match Obsidian/d3's feel: ~0.38
      // (slightly looser than default for a touch of follow-through), huge
      // graphs a hair tighter so a big cluster can't swing wild.
      sim.velocityDecay(huge ? 0.42 : big ? 0.4 : 0.38).alphaDecay(huge ? 0.06 : big ? 0.04 : 0.028).alpha(0.85).stop();
      // Tiny prewarm only: enough to avoid an initial singular pile-up without
      // blocking first paint for seconds on larger vaults.
      for (let i = 0; i < warmTicks; i++) sim.tick();
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
      sim.alpha(huge ? 0.12 : big ? 0.16 : 0.2);
      motionUntilRef.current = performance.now() + 2400;
      simRef.current = sim;
      fitPendingRef.current = true;
    } else {
      const lf = sim.force("link") as ReturnType<
        typeof forceLink<GraphNode, GraphLink>
      >;
      lf.links([]);
      sim.nodes(forceNodes);
      lf.links(links);
      sim.alpha(topologyChanged ? 0.22 : 0).stop();
      needsRedrawRef.current = true;
    }
  }, [
    notes,
    files,
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
  }, [
    graphNodeSize,
    graphCenterForce,
    graphRepelForce,
    graphLinkForce,
    graphLinkDistance,
  ]);

  useEffect(() => {
    needsRedrawRef.current = true;
  }, [graphArrows, graphTextFadeThreshold, graphLinkThickness]);

  // ---- size the canvas to its container ----------------------------------
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    ctxRef.current = canvas.getContext("2d", {
      desynchronized: getStore().settings.hardwareAccel,
      alpha: true,
    });
    // Reallocating the canvas backing store and re-fitting the force layout is
    // expensive. The sidebar open/close animation changes this pane's width
    // every frame for ~0.22s, so doing that work per-frame caused visible lag.
    // Instead: cheaply stretch the existing bitmap via CSS on every tick, and
    // debounce the heavy realloc + re-fit to the trailing edge so it runs once
    // the resize settles.
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
    };
    const ro = new ResizeObserver(() => {
      // Cheap per-tick: let the current bitmap scale to the new box so the
      // graph keeps filling the pane during the animation.
      const rect = wrap.getBoundingClientRect();
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
      if (resizeTimer != null) clearTimeout(resizeTimer);
      // The CSS stretch is only visually safe for SMALL deltas (its purpose:
      // the sidebar open/close animation nudging the pane width per frame).
      // A large growth jump — this pane just opened into the stack and went
      // from its tiny first-layout box to full size, or a torn-off window got
      // resized — would smear the old few-pixel bitmap into full-width bands
      // for the whole debounce window (the "striped graph on open" bug, every
      // theme's bloom colors). Realloc + redraw immediately for big jumps; a
      // handful of reallocs during a 0.2s open is nowhere near the per-frame
      // realloc cost the debounce exists to avoid.
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
    applyResize(); // size correctly on mount without waiting for the debounce
    ro.observe(wrap);
    return () => {
      ro.disconnect();
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

  // Keep timelapse playback on its own short-lived timer. The graph loop
  // intentionally throttles settled large graphs to their ambient cadence;
  // using that loop for playback could leave a replay visually stuck when the
  // canvas was otherwise idle. A dedicated playback clock makes the time-based
  // reveal deterministic without changing the graph's normal render cadence.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelapseOn]);

  // ---- animation loop ----------------------------------------------------
  useEffect(() => {
    let raf = 0;

    const draw = (now: number, activeItems: ReturnType<typeof activeRecords>) => {
      const canvas = canvasRef.current;
      const ctx = ctxRef.current;
      if (!canvas || !ctx) return;
      const { w, h } = sizeRef.current;
      const t = transformRef.current;
      const dpr = window.devicePixelRatio || 1;
      const lnow = now / 1000;
      const animationsOn = getStore().settings.animations;
      const fastDraw =
        now < fastDrawUntilRef.current ||
        dragRef.current.panning ||
        !!dragRef.current.node ||
        Math.abs(targetKRef.current - t.k) > 0.0005;

      // ease zoom toward its target for buttery wheel response
      if (Math.abs(targetKRef.current - t.k) > 0.0005) {
        const cx = pointerRef.current.x || w / 2;
        const cy = pointerRef.current.y || h / 2;
        const k2 = t.k + (targetKRef.current - t.k) * 0.2;
        t.x = cx - (cx - t.x) * (k2 / t.k);
        t.y = cy - (cy - t.y) * (k2 / t.k);
        t.k = k2;
        needsRedrawRef.current = true;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality =
        nodesRef.current.length > 1500
          ? "low"
          : nodesRef.current.length > 700
          ? "medium"
          : "high";
      ctx.translate(t.x, t.y);
      ctx.scale(t.k, t.k);
      if (animationsOn && nodesRef.current.length > 0) {
        // Sparse, slow orbital drift — closer to Obsidian's near-still graph
        // than a visibly swimming graph. World-space so it scales with zoom.
        const driftPhase = lnow * 0.15;
        ctx.translate(
          Math.sin(driftPhase) * 0.8 / Math.max(0.7, t.k),
          Math.cos(driftPhase * 0.87) * 0.55 / Math.max(0.7, t.k)
        );
      }

      const nodes = nodesRef.current;
      const forceNodes = forceNodesRef.current;
      const links = linksRef.current;
      const active = getStore().activePath;
      const hoverId = hoverRef.current.id;
      // The node currently being dragged (if any). Its incident links are
      // highlighted in Batch 2 so the dragged cluster's edges read clearly
      // while dragging — same idea as hover/active, but a brighter, steadier
      // style so it stays legible against the moving cluster.
      const dragNode = dragRef.current.node;
      const dragId = dragNode?.id ?? null;
      const c = colorsRef.current;
      const display = graphDisplayRef.current;
      // ---- Obsidian-style hover focus -----------------------------------
      // While a node is hovered, its neighborhood stays at full strength and
      // everything else dims; the transition is eased in the loop (focusRef.k)
      // so it fades in/out instead of flashing. During drag the whole graph is
      // in motion, so focus is released to keep the picture calm.
      const focus = focusRef.current;
      const focusK = focus.k * focus.k * (3 - 2 * focus.k); // smoothstep
      const focusId = focusK > 0.02 && !dragId ? focus.id : null;
      const focusSet = focusId ? neighborsRef.current.get(focusId) : undefined;
      // Obsidian keeps the rest of the graph readable while a hovered
      // neighborhood is emphasized. Do not fade the surrounding topology so
      // deeply that the fitted graph becomes hard to inspect or drag.
      const dimK = 1 - 0.38 * focusK;
      const tail = clamp((motionUntilRef.current - now) / 4600, 0, 1);
      const tailEase = tail * tail * (3 - 2 * tail);
      const lifeBoost = 1 + tailEase * 0.3;
      // Ambient motion must be *perceptible*, not sub-pixel. The no-overlap
      // guarantee lives on LAYOUT positions (resolveOverlaps corrects n.x/n.y);
      // the breathing here is a render-only offset the resolver never sees, so
      // it can be visible without breaking layout no-overlap. The only
      // constraint is two *rendered* adjacent nodes not touching — bounded by
      // per-node offset <= (OVERLAP_GAP * t.k)/2 screen-px. So positional
      // breathing is screen-constant (visible at any zoom) and capped there.
      // The primary visible living signal is RADIUS twinkle (below) — a radius
      // change can never cause positional overlap.
      const livingScale = animationsOn
        ? nodes.length > 1200
          ? 1.2
          : 1.7
        : 0;
      // Screen-space breathing amplitude, clamped so two adjacent nodes (layout
      // gap = OVERLAP_GAP world) breathing toward each other can never touch.
      const livingScreenPx = Math.min(
        livingScale * lifeBoost,
        (OVERLAP_GAP * t.k) / 2 - 0.5
      );
      const livingPx = livingScreenPx / Math.max(0.2, t.k);
      // Radius twinkle/pulse is the primary visible living signal — large enough
      // to read as the node gently growing/shrinking, but never so large it
      // makes small nodes vanish. Non-positional, so it cannot cause overlap.
      const pulseAmp = animationsOn
        ? nodes.length > 1200
          ? 0.2
          : nodes.length > 700
          ? 0.26
          : 0.32
        : 0;
      const twinkleAmp = animationsOn
        ? nodes.length > 1200
          ? 0.26
          : nodes.length > 700
          ? 0.34
          : 0.40
        : 0;

      // ---- Build activity cache once per frame (not per-node/per-link) ----
      // Collect active node ids into a Map for O(1) lookup in the hot loops.
      const actMap = new Map<string, { intensity: number; rate: number }>();
      for (const { id, rec } of activeItems) {
        actMap.set(id, { intensity: rec.intensity, rate: rec.rate });
      }

      // Track when each node last had live activity, so the steady "open file"
      // highlight can fade back in smoothly after a typing burst instead of
      // snapping on the moment flicker decays below threshold. Prune stale
      // entries so the map can't grow unbounded over a long session.
      const recentAct = recentActivityRef.current;
      for (const { id, rec } of activeItems) {
        if (rec.intensity > 0.001) recentAct.set(id, now);
      }
      if (recentAct.size > 64) {
        for (const [id, t] of recentAct) {
          if (now - t > 2000) recentAct.delete(id);
        }
      }
      // Smooth fade-in of the active-file highlight after activity ends.
      // While the file is being edited this is ~0 (and Batch 2 skips active
      // links anyway because the node is in actMap); once flicker decays the
      // steady highlight ramps 0->1 over ACTIVE_FADE_MS so it eases back in.
      const ACTIVE_FADE_MS = 600;
      let activeFade = 1;
      if (active) {
        const last = recentAct.get(active) ?? 0;
        const since = now - last;
        const f = since >= ACTIVE_FADE_MS ? 1 : since / ACTIVE_FADE_MS;
        activeFade = f * f * (3 - 2 * f); // smoothstep
      }

      // ---- Render-layer liveness ----------------------------------------
      // Covers cluster + halo: every node gets the same gentle render-only
      // breathing/twinkle. The offsets below are render-only and never feed
      // back into the simulation.
      const dragged = dragRef.current.node;
      for (const n of nodes) {
        const x = n.x ?? 0;
        const y = n.y ?? 0;
        const phase = n.renderPhase ?? phaseFromId(n.id);
        n.renderPhase = phase;
        const r = graphNodeRadius(n);
        const kvx = (n.renderKickVx ?? 0) * 0.82;
        const kvy = (n.renderKickVy ?? 0) * 0.82;
        const kx = ((n.renderKickX ?? 0) + kvx) * 0.84;
        const ky = ((n.renderKickY ?? 0) + kvy) * 0.84;
        n.renderKickVx = Math.abs(kvx) < 0.01 ? 0 : kvx;
        n.renderKickVy = Math.abs(kvy) < 0.01 ? 0 : kvy;
        n.renderKickX = Math.abs(kx) < 0.01 ? 0 : kx;
        n.renderKickY = Math.abs(ky) < 0.01 ? 0 : ky;
        // The dragged node is pinned to the cursor via fx/fy. Render it exactly
        // at its layout position with no ambient wobble or radius pulse, so it
        // tracks the pointer 1:1 instead of squirming under it — Obsidian pins
        // the grabbed node. Ambient motion stays on every other node.
        if (
          n === dragged ||
          !animationsOn ||
          !Number.isFinite(x) ||
          !Number.isFinite(y)
        ) {
          n.renderX = x;
          n.renderY = y;
          n.renderRadius = r;
          continue;
        }
        const a = lnow * 0.42 + phase;
        const b = lnow * 0.27 + phase * 1.37;
        const cx = x - sizeRef.current.w / 2;
        const cy = y - sizeRef.current.h / 2;
        // Distance from viewport center, reused for both the radial breathe
        // scale and the inward-unit-vector — one hypot per node per frame, not
        // two (identical value; ~20% off this loop's cost at stress scale).
        const len = Math.hypot(cx, cy);
        const radial = Math.min(
          1.8,
          len / Math.max(240, sizeRef.current.w * 0.42)
        );
        const breathe =
          Math.sin(lnow * 0.36 + phase * 0.18) * livingPx * 0.55 * radial;
        const invLen = 1 / Math.max(1, len);
        const mingle = Math.sin(lnow * 0.21 + phase * 0.51) * livingPx * 0.28;
        n.renderX =
          x +
          (Math.sin(a) + Math.sin(b) * 0.35) * livingPx * 1.35 +
          mingle * 0.5 +
          cx * invLen * breathe +
          kx;
        n.renderY =
          y +
          (Math.cos(a * 0.82) + Math.sin(b * 0.7) * 0.32) * livingPx * 1.35 +
          mingle * -0.28 +
          cy * invLen * breathe +
          ky;
        // Radius pulse: slow enough to read as a gentle swell, fast enough to
        // actually see (period ~3.5s). Non-positional so it can't cause overlap.
        n.renderRadius = r * (1 + Math.sin(lnow * 1.8 + phase) * pulseAmp);
      }

      // ---- Viewport culling bounds (in graph/world space) ----------------
      const margin = 60 / t.k;
      const vx0 = -t.x / t.k - margin;
      const vy0 = -t.y / t.k - margin;
      const vx1 = (w - t.x) / t.k + margin;
      const vy1 = (h - t.y) / t.k + margin;

      // A soft breathing bloom behind the main cluster so the graph reads as
      // a living field even when the force sim has settled. Stronger than before
      // so it is actually visible, but kept soft (low alpha) and slow so it
      // never reads as a busy glow. Pulses on a long breath + a slow radius
      // swell so the halo itself feels alive.
      const forceBounds = graphBounds(forceNodes);
      if (animationsOn && forceBounds.valid) {
        // Darker, softer, slower halo — a quiet bloom instead of cluster glow.
        const bloomPulse = 0.7 + 0.22 * Math.sin(lnow * 0.26 + forceBounds.radius * 0.01);
        const bloomRadius =
          forceBounds.radius + Math.min(w, h) * 0.2 + Math.sin(lnow * 0.18) * 14;
        const bloom = ctx.createRadialGradient(
          forceBounds.cx,
          forceBounds.cy,
          Math.max(24, forceBounds.radius * 0.12),
          forceBounds.cx,
          forceBounds.cy,
          bloomRadius
        );
        bloom.addColorStop(
          0,
          `rgba(${c.flickerRgb},${(0.045 * c.bloomAlpha * bloomPulse).toFixed(3)})`
        );
        bloom.addColorStop(
          0.45,
          `rgba(${c.flickerRgb},${(0.018 * c.bloomAlpha * bloomPulse).toFixed(3)})`
        );
        bloom.addColorStop(1, `rgba(${c.flickerRgb},0)`);
        ctx.globalAlpha = 1;
        ctx.fillStyle = bloom;
        ctx.beginPath();
        ctx.arc(forceBounds.cx, forceBounds.cy, bloomRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      // ---- LINKS: batched by style to minimise canvas state changes ------
      // Collect into three batches: active-flicker, hot (hover/active), normal.
      ctx.lineCap = "round";
      const le = linkEndpointsRef.current;
      const lc = links.length;

      // Update the flat endpoint arrays from the current node positions.
      for (let i = 0; i < lc; i++) {
        const l = links[i];
        const s = l.source as GraphNode;
        const tg = l.target as GraphNode;
        le.sx[i] = s.renderX ?? s.x ?? 0;
        le.sy[i] = s.renderY ?? s.y ?? 0;
        le.tx[i] = tg.renderX ?? tg.x ?? 0;
        le.ty[i] = tg.renderY ?? tg.y ?? 0;
        le.sId[i] = s.id;
        le.tId[i] = tg.id;
      }

      // Batch 1: normal links (no activity, not hot) — single stroke style.
      // Under hover focus every link in this batch is by definition outside
      // the hovered neighborhood (incident links are "hot" → batch 2), so the
      // whole batch dims with one globalAlpha — zero extra per-link cost.
      ctx.beginPath();
      ctx.strokeStyle = c.link;
      ctx.lineWidth = (0.7 * display.linkThickness) / t.k;
      ctx.globalAlpha = focusId ? dimK : 1;
      for (let i = 0; i < lc; i++) {
        const sx = le.sx[i], sy = le.sy[i], tx = le.tx[i], ty = le.ty[i];
        if (!isFinite(sx) || !isFinite(sy) || !isFinite(tx) || !isFinite(ty)) continue;
        // Viewport cull: skip links entirely outside the visible bounds.
        if ((sx < vx0 && tx < vx0) || (sx > vx1 && tx > vx1)) continue;
        if ((sy < vy0 && ty < vy0) || (sy > vy1 && ty > vy1)) continue;
        const sId = le.sId[i], tId = le.tId[i];
        const sa = actMap.get(sId);
        const ta = actMap.get(tId);
        if (sa || ta) continue; // active links drawn in batch 3
        const hot =
          (active != null && (sId === active || tId === active)) ||
          (hoverId != null && (sId === hoverId || tId === hoverId)) ||
          (dragId != null && (sId === dragId || tId === dragId));
        if (hot) continue; // hot links drawn in batch 2
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Batch 2: hot links (touching hovered, active, or dragged node).
      // Very subtle — only just above the base links. Hover is a faint tint;
      // the open/active file's links get a touch more so the current document
      // stays findable without glaring. The active highlight fades back in via
      // `activeFade` after a typing burst so it never snaps on. Dragged-node
      // links get the brightest, steadiest treatment so the moving cluster's
      // edges stay legible against the motion. Agent activity flicker
      // (Batch 3) is the loud path and is untouched here.
      // Hover links brighten with the focus ease so the hovered neighborhood
      // pops exactly as the rest of the graph recedes (Obsidian's highlight).
      const hotColor = `rgba(${c.flickerRgb},${(0.14 + 0.3 * focusK).toFixed(3)})`;
      const activeColor = `rgba(${c.flickerRgb},${(0.22 * activeFade).toFixed(3)})`;
      const dragColor = `rgba(${c.flickerRgb},0.22)`;
      for (let i = 0; i < lc; i++) {
        const sId = le.sId[i], tId = le.tId[i];
        if (actMap.has(sId) || actMap.has(tId)) continue;
        const touchActive =
          active != null && (sId === active || tId === active);
        const touchHover =
          hoverId != null && (sId === hoverId || tId === hoverId);
        const touchDrag =
          dragId != null && (sId === dragId || tId === dragId);
        if (!touchActive && !touchHover && !touchDrag) continue;
        const sx = le.sx[i], sy = le.sy[i], tx = le.tx[i], ty = le.ty[i];
        if (!isFinite(sx) || !isFinite(sy) || !isFinite(tx) || !isFinite(ty)) continue;
        ctx.beginPath();
        // Drag takes precedence (brightest), then active, then hover.
        ctx.strokeStyle = touchDrag
          ? dragColor
          : touchActive
          ? activeColor
          : hotColor;
        ctx.lineWidth =
          ((touchDrag ? 1.05 : touchActive ? 1 : 0.9 + 0.4 * focusK) *
            display.linkThickness) /
          t.k;
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }

      // Batch 3: active (flickering) links — each needs its own style so
      // can't be fully batched, but we skip viewport-culled ones.
      for (let i = 0; i < lc; i++) {
        const sId = le.sId[i], tId = le.tId[i];
        const sa = actMap.get(sId);
        const ta = actMap.get(tId);
        if (!sa && !ta) continue;
        const sx = le.sx[i], sy = le.sy[i], tx = le.tx[i], ty = le.ty[i];
        if (!isFinite(sx) || !isFinite(sy) || !isFinite(tx) || !isFinite(ty)) continue;
        if ((sx < vx0 && tx < vx0) || (sx > vx1 && tx > vx1)) continue;
        if ((sy < vy0 && ty < vy0) || (sy > vy1 && ty > vy1)) continue;
        const linkAct = Math.max(sa?.intensity ?? 0, ta?.intensity ?? 0);
        if (linkAct <= 0.02) continue;
        const amp = Math.min(1, linkAct);
        const rate = Math.max(sa?.rate ?? 0, ta?.rate ?? 0);
        const flick = 0.55 + 0.45 * Math.sin(lnow * (3 + rate * 1.4));
        ctx.strokeStyle = `rgba(${c.flickerRgb},${(0.06 + 0.18 * amp * flick).toFixed(3)})`;
        ctx.lineWidth = ((0.6 + 0.6 * amp) * display.linkThickness) / t.k;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }

      // Obsidian keeps direction hidden at fit zoom and reveals small arrows
      // only when the user zooms into the graph.
      if (display.arrows && t.k > 1.05) {
        ctx.fillStyle = c.link;
        ctx.globalAlpha = focusId ? dimK : 1;
        for (let i = 0; i < lc; i++) {
          const sx = le.sx[i], sy = le.sy[i], tx = le.tx[i], ty = le.ty[i];
          const dx = tx - sx;
          const dy = ty - sy;
          const len = Math.hypot(dx, dy);
          if (!Number.isFinite(len) || len < 1) continue;
          if ((sx < vx0 && tx < vx0) || (sx > vx1 && tx > vx1)) continue;
          if ((sy < vy0 && ty < vy0) || (sy > vy1 && ty > vy1)) continue;
          const targetNode = nodeByIdRef.current.get(le.tId[i]);
          const targetRadius = targetNode ? graphNodeRadius(targetNode) : 6;
          const ex = tx - (dx / len) * (targetRadius + 2);
          const ey = ty - (dy / len) * (targetRadius + 2);
          const size = 4.5 / t.k;
          const ux = dx / len;
          const uy = dy / len;
          const px = -uy;
          const py = ux;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(
            ex - ux * size + px * size * 0.62,
            ey - uy * size + py * size * 0.62
          );
          ctx.lineTo(
            ex - ux * size - px * size * 0.62,
            ey - uy * size - py * size * 0.62
          );
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // ---- NODES: viewport-culled, no per-node save/restore for non-image ----
      // All nodes draw the same way — the connected cluster and the orphan halo.
      for (const n of nodes) {
        if (n.x == null || n.y == null) continue;
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
        // Viewport cull: skip nodes entirely outside the visible bounds.
        const r = n.renderRadius ?? graphNodeRadius(n);
        const rx = n.renderX ?? n.x;
        const ry = n.renderY ?? n.y;
        if (rx == null || ry == null) continue;
        if (rx < vx0 - r || rx > vx1 + r || ry < vy0 - r || ry > vy1 + r) continue;

        const act = actMap.get(n.id);
        const isActive = n.id === active;
        const isHover = n.id === hoverId;

        // smooth keystroke flicker (sum of sines, no random shimmer).
        // Subtle by design: a soft blip per edit that fades with the activity
        // decay. Kept clearly above the hover/ambient tint so agent telemetry
        // is still the most visible thing on the graph, but not glaring.
        if (act && act.intensity > 0.01) {
          const amp = Math.min(1, act.intensity);
          const ws = (now / 1000) * (3 + act.rate * 1.4);
          const flick = 0.55 + 0.3 * Math.sin(ws) + 0.12 * Math.sin(ws * 1.7);
          const glowR = r + (3 + amp * 6) * flick;
          const alpha = 0.1 * amp * flick;
          const g = ctx.createRadialGradient(rx, ry, r * 0.4, rx, ry, glowR);
          g.addColorStop(0, `rgba(${c.flickerRgb},${alpha.toFixed(3)})`);
          g.addColorStop(1, `rgba(${c.flickerRgb},0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(rx, ry, glowR, 0, Math.PI * 2);
          ctx.fill();
        }

        // steady soft halo on the active node. Fades in with `activeFade`
        // after a typing burst so it never snaps back on.
        if (isActive && activeFade > 0.01) {
          const halo = ctx.createRadialGradient(rx, ry, r, rx, ry, r + 11);
          halo.addColorStop(0, `rgba(${c.flickerRgb},${(0.14 * activeFade).toFixed(3)})`);
          halo.addColorStop(1, `rgba(${c.flickerRgb},0)`);
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(rx, ry, r + 14, 0, Math.PI * 2);
          ctx.fill();
        }

        const img = !fastDraw && n.thumbPath ? getImage(n.thumbPath) : null;
        // Image-thumbnail nodes get a circular clip + image fill.
        // All other nodes get their distinct shape — no save/restore needed.
        // Opacity twinkle: the primary zoom-independent visible life signal
        // (positional/radius motion is sub-pixel on small notes at fit-zoom).
        // Period ~2.6s; the grabbed node is held steady (no dimming while
        // pinned to the cursor), like Obsidian. The amplitude is wide and the
        // floor deep so the luminance swing reads as a clear shimmer against
        // every theme's graph canvas, not a subtle drift.
        const twinkle =
          animationsOn && !act && !isActive && n !== dragRef.current.node
            ? 1 + Math.sin(lnow * 2.4 + (n.renderPhase ?? 0) * 2.7) * twinkleAmp
            : 1;

        // Hover focus: nodes outside the hovered neighborhood recede.
        let nodeAlpha = Math.max(0.52, Math.min(1, twinkle));
        if (focusId && n.id !== focusId && !focusSet?.has(n.id) && !act && !isActive) {
          nodeAlpha *= dimK;
        }
        ctx.globalAlpha = nodeAlpha;
        if (img && img.complete && img.naturalWidth > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(rx, ry, r, 0, Math.PI * 2);
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(img, rx - r, ry - r, r * 2, r * 2);
          ctx.restore();
          ctx.beginPath();
          ctx.arc(rx, ry, r, 0, Math.PI * 2);
          ctx.lineWidth = (isActive ? 2.5 : 1.2) / t.k;
          ctx.strokeStyle = isActive ? c.nodeActive : c.thumbBorder;
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(rx, ry, r, 0, Math.PI * 2);
          ctx.closePath();
          ctx.fillStyle = isActive ? c.nodeActive : nodeFill(n, c);
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        if (isHover) {
          ctx.beginPath();
          ctx.arc(rx, ry, r + 3, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${c.flickerRgb},0.35)`;
          ctx.lineWidth = 1.2 / t.k;
          ctx.stroke();
        }
      }

      // --- labels: screen-space pass, Obsidian-style "text fade" ------------
      // Text smoothly fades out as you zoom out — past LABEL_FADE_LO the graph
      // shows only nodes, no text. Zoom in and labels fade in, de-overlapped so
      // they never pile into a glob. Hovered/active notes are always labelled.
      const LABEL_FADE_LO = clamp(display.textFadeThreshold, 0, 0.9);
      const LABEL_FADE_HI = Math.min(0.98, LABEL_FADE_LO + 0.4);
      const zoomAlpha = Math.max(
        0,
        Math.min(1, (t.k - LABEL_FADE_LO) / (LABEL_FADE_HI - LABEL_FADE_LO))
      );
      const anyForced = hoverId != null || active != null;
      if (!fastDraw && (zoomAlpha > 0.02 || anyForced || focusK > 0.05)) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // identity → constant-size text
        ctx.font = "12px -apple-system, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineJoin = "round"; // round halo so text never gets spiky
        ctx.miterLimit = 2;
        const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
        const done = new Set<string>();
        let drawn = 0;

        const place = (n: GraphNode, forced: boolean, alphaIn?: number): void => {
          if (drawn >= 120 || done.has(n.id)) return;
          if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return;
          const alpha = alphaIn ?? (forced ? 1 : zoomAlpha);
          if (alpha < 0.03) return;
          const sx = (n.renderX ?? n.x!) * t.k + t.x;
          const sy = (n.renderY ?? n.y!) * t.k + t.y;
          if (sx < -60 || sy < -20 || sx > w + 60 || sy > h + 20) return;
          const sr = (n.renderRadius ?? graphNodeRadius(n)) * t.k;
          const tw = ctx.measureText(n.title).width;
          const lx = sx;
          const ly = sy + sr + 9;
          const box = {
            x0: lx - tw / 2 - 3,
            y0: ly - 8,
            x1: lx + tw / 2 + 3,
            y1: ly + 8,
          };
          if (!forced) {
            for (const o of taken) {
              if (
                box.x0 < o.x1 &&
                box.x1 > o.x0 &&
                box.y0 < o.y1 &&
                box.y1 > o.y0
              )
                return;
            }
          }
          taken.push(box);
          done.add(n.id);
          ctx.globalAlpha = alpha;
          ctx.lineWidth = 3;
          ctx.strokeStyle = c.labelHalo;
          ctx.strokeText(n.title, lx, ly);
          ctx.fillStyle = forced ? c.nodeActive : c.label;
          ctx.fillText(n.title, lx, ly);
          drawn++;
        };

        // hovered + active are always labelled, then the top-N highest-degree
        // nodes (from the cached degree-desc order — no per-frame sort).
        const byId = nodeByIdRef.current;
        if (hoverId) {
          const n = byId.get(hoverId);
          if (n) place(n, true);
        }
        if (active && active !== hoverId) {
          const n = byId.get(active);
          if (n) place(n, true);
        }
        // Hover focus: the hovered node's neighbors get labels that fade in
        // with the focus ease (Obsidian labels the highlighted neighborhood).
        // Overlap-avoided (not forced) so a hub hover can't pile text.
        if (focusId && focusSet) {
          let labelled = 0;
          for (const nid of focusSet) {
            if (labelled >= 24 || drawn >= 120) break;
            const nb = byId.get(nid);
            if (!nb) continue;
            place(nb, false, Math.max(zoomAlpha, focusK));
            labelled++;
          }
        }
        const topN = Math.min(LABEL_TOP_N, degreeSortedRef.current.length);
        for (let i = 0; i < topN; i++) {
          if (drawn >= 120) break;
          const n = degreeSortedRef.current[i];
          // Non-neighbor top-N labels recede along with their nodes.
          const dimmed =
            focusId && n.id !== focusId && !focusSet?.has(n.id);
          place(n, false, dimmed ? zoomAlpha * dimK : undefined);
        }
        ctx.globalAlpha = 1;
      }
    };

    const placePreviewCard = (
      node: GraphNode,
      placed: { x: number; y: number }[] = [],
      preferred?: { x: number; y: number }
    ) => {
      const t = transformRef.current;
      const { w, h } = sizeRef.current;
      const sx = (node.x ?? 0) * t.k + t.x;
      const sy = (node.y ?? 0) * t.k + t.y;
      const r = graphNodeRadius(node) * t.k + 20;
      const pref = preferred ?? { x: sx, y: sy };
      const candidates = [
        { x: pref.x + 18, y: pref.y + 18, corner: false },
        { x: pref.x - CARD_W - 18, y: pref.y + 18, corner: false },
        { x: pref.x + 18, y: pref.y - CARD_H - 18, corner: false },
        { x: pref.x - CARD_W - 18, y: pref.y - CARD_H - 18, corner: false },
        { x: sx + r, y: sy - CARD_H / 2, corner: false },
        { x: sx - r - CARD_W, y: sy - CARD_H / 2, corner: false },
        { x: sx - CARD_W / 2, y: sy + r, corner: false },
        { x: sx - CARD_W / 2, y: sy - r - CARD_H, corner: false },
        { x: sx + r * 0.8, y: sy + r * 0.8, corner: false },
        { x: sx - CARD_W - r * 0.8, y: sy + r * 0.8, corner: false },
        { x: sx + r * 0.8, y: sy - CARD_H - r * 0.8, corner: false },
        { x: sx - CARD_W - r * 0.8, y: sy - CARD_H - r * 0.8, corner: false },
        { x: 10, y: 10, corner: true },
        { x: w - CARD_W - 10, y: 10, corner: true },
        { x: 10, y: h - CARD_H - 10, corner: true },
        { x: w - CARD_W - 10, y: h - CARD_H - 10, corner: true },
      ].map((p) => ({
        x: clamp(p.x, 8, Math.max(8, w - CARD_W - 8)),
        y: clamp(p.y, 8, Math.max(8, h - CARD_H - 8)),
        corner: p.corner,
      }));

      let best = candidates[0];
      let bestScore = Infinity;
      // Use precomputed adjacency — only scan links touching this node, not all.
      const linkIndices = adjacencyRef.current.get(node.id) ?? [];
      for (const p of candidates) {
        const rect = { x: p.x, y: p.y, w: CARD_W, h: CARD_H };
        // The card must never cover the node it describes, and should avoid
        // its incident links — the flickering node + links are the point.
        // Covering the node is a hard reject; link hits are penalized heavily
        // so a corner (link-free) beats a near position that crosses links.
        let score = rectContains(rect, sx, sy)
          ? Infinity
          : p.corner
          ? 36_000
          : 0;
        for (const li of linkIndices) {
          const l = linksRef.current[li];
          if (!l) continue;
          const s = l.source as GraphNode;
          const tg = l.target as GraphNode;
          if (s.x == null || s.y == null || tg.x == null || tg.y == null) continue;
          score += rectLinePenalty(
            rect,
            s.x * t.k + t.x,
            s.y * t.k + t.y,
            tg.x * t.k + t.x,
            tg.y * t.k + t.y
          ) * 8000;
        }
        for (const other of placed) {
          const overlap =
            rect.x < other.x + CARD_W &&
            rect.x + CARD_W > other.x &&
            rect.y < other.y + CARD_H &&
            rect.y + CARD_H > other.y;
          if (overlap) score += 25_000;
        }
        const cx = p.x + CARD_W / 2;
        const cy = p.y + CARD_H / 2;
        const pdx = cx - pref.x;
        const pdy = cy - pref.y;
        const ndx = cx - sx;
        const ndy = cy - sy;
        score += Math.sqrt(pdx * pdx + pdy * pdy) * 0.55;
        score += Math.sqrt(ndx * ndx + ndy * ndy) * 0.08;
        if (score < bestScore) {
          bestScore = score;
          best = p;
        }
      }
      return best;
    };

    const updateHover = (now: number) => {
      if (graphControlsHoverRef.current) {
        clearGraphHover();
        return;
      }
      const d = dragRef.current;
      // While dragging a node or panning, never show a preview — and dismiss any
      // card that was already up before the drag began (5a).
      if (d.node || d.panning) {
        hoverRef.current.id = null;
        if (shownIdRef.current !== null) {
          shownIdRef.current = null;
          setHover(null);
        }
        return;
      }
      const p = pointerRef.current;
      if (!p.inside) {
        hoverRef.current.id = null;
        if (shownIdRef.current !== null) {
          shownIdRef.current = null;
          setHover(null);
        }
        return;
      }
      const hit = nodeAtScreen(p.x, p.y);
      // Tag/phantom nodes have no underlying file, so they get no preview card.
      const n = hit && !isSyntheticNode(hit) ? hit : null;
      const id = n?.id ?? null;
      const delay = getStore().settings.hoverDelayMs;
      if (id !== hoverRef.current.id) {
        hoverRef.current.id = id;
        hoverRef.current.since = now;
        // Prewarm the preview content the moment a node is hovered, so the
        // card body is ready when the hover delay elapses (peek = capped read).
        if (id) void getStore().ensurePeek(id);
        if (id === null && shownIdRef.current !== null) {
          shownIdRef.current = null;
          setHover(null);
        }
      } else if (
        id &&
        n &&
        now - hoverRef.current.since >= delay &&
        shownIdRef.current !== id
      ) {
        shownIdRef.current = id;
        const place = placePreviewCard(n, activityRef.current, {
          x: p.x + 16,
          y: p.y + 16,
        });
        setHover({ id, x: place.x, y: place.y });
      }
    };

    // Float a live preview card over every node with current activity (the file
    // being read/edited/written/created), strongest first. Throttled, and only
    // pushes to React state when something actually changed.
    const updateActivityCards = (
      now: number,
      activeItems: ReturnType<typeof activeRecords>
    ) => {
      if (now - lastActAtRef.current < 140) return;
      lastActAtRef.current = now;
      const t = transformRef.current;
      const { w, h } = sizeRef.current;
      const byId = nodeByIdRef.current;
      const hoveredId = shownIdRef.current; // don't double-card the hovered node
      const items: ActivityCard[] = [];
      for (const { id, rec } of activeItems.slice(0, ACTIVITY_CAP)) {
        if (id === hoveredId) continue;
        const n = byId.get(id);
        if (!n || n.x == null || n.y == null) continue;
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
        const sx = n.x * t.k + t.x;
        const sy = n.y * t.k + t.y;
        if (sx < -CARD_W || sy < -CARD_H || sx > w + CARD_W || sy > h + CARD_H)
          continue;
        const place = placePreviewCard(n, items, {
          x: sx + 22,
          y: sy + 22,
        });
        items.push({
          id,
          op: rec.op,
          status: rec.status,
          detail: rec.detail,
          added: rec.added ?? 0,
          removed: rec.removed ?? 0,
          filesChanged: Math.max(1, activeItems.length),
          seed: `${id}:${rec.op}:${Math.floor(rec.last / 2500)}`,
          visible: true,
          x: place.x,
          y: place.y,
        });
      }
      if (items.length > 0) {
        activityHoldUntilRef.current = now + ACTIVITY_LINGER_MS;
        if (activityClearTimerRef.current) {
          clearTimeout(activityClearTimerRef.current);
          activityClearTimerRef.current = null;
        }
      }
      const nextItems =
        items.length > 0
          ? items
          : now < activityHoldUntilRef.current
          ? activityRef.current
          : activityRef.current.length > 0
          ? activityRef.current.map((item) => ({ ...item, visible: false }))
          : [];
      if (
        items.length === 0 &&
        activityRef.current.length > 0 &&
        now >= activityHoldUntilRef.current &&
        !activityClearTimerRef.current
      ) {
        activityClearTimerRef.current = setTimeout(() => {
          activityClearTimerRef.current = null;
          activityRef.current = [];
          activitySigRef.current = "";
          setActivity([]);
        }, ACTIVITY_FADE_MS);
      }
      const sig = nextItems
        .map(
          (i) =>
            `${i.id}:${i.op}:${Math.round(i.x / 16)}:${Math.round(i.y / 16)}:${
              i.added ?? 0
            }:${i.removed ?? 0}:${i.filesChanged ?? 1}:${i.seed ?? ""}:${(
              i.detail ?? ""
            ).slice(0, 24)}:${i.visible ? 1 : 0}`
        )
        .join("|");
      if (sig !== activitySigRef.current) {
        activitySigRef.current = sig;
        activityRef.current = nextItems;
        setActivity(nextItems);
      }
    };

    const frame = () => {
      const now = performance.now();
      const animationsOn = getStore().settings.animations;
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

      // Tick the sim if it still has energy or we're dragging a node.
      if (sim && (sim.alpha() > 0.004 || isMovingNode)) {
        const ticks =
          nodesRef.current.length < 650 && sim.alpha() > 0.06 && !isNodeDragging ? 2 : 1;
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

      // Hard no-overlap guarantee — but ONLY at idle. d3's forceCollide (which
      // is velocity-aware and iterative, not a hard per-frame positional snap)
      // handles collisions while the sim has energy/during drag. The resolver is
      // a hard snap that shoves overlapping nodes apart by the full overlap each
      // frame; if it runs *during* a hub drag it fights the link force
      // (links pull INDEX's 227 neighbors in → resolver snaps them out → links
      // pull them in again → jitter/haywire). So: skip the resolver while a
      // node is being dragged or the sim is still settling; let forceCollide do
      // its smooth iterative job, then the resolver takes over alone at idle
      // (its original purpose, section EE) to guarantee no overlap at rest.
      // Obsidian/Logseq/Athens have no such hard resolver at all during motion.
      const settling = isNodeDragging || (sim ? sim.alpha() > 0.02 : false);
      if (!settling && !layoutSettledRef.current && forceNodesRef.current.length > 0) {
        if (resolveOverlaps(forceNodesRef.current, graphNodeRadius, OVERLAP_GAP, 2)) {
          needsRedrawRef.current = true;
        } else {
          // Fully resolved and the sim isn't ticking (settling is false): layout
          // x/y are now frozen and overlap-free. Stop rebuilding the grid every
          // frame until the sim ticks again (which clears this flag).
          layoutSettledRef.current = true;
        }
      }

      // If there are active (flickering) nodes, we must keep redrawing.
      if (activeItems.length > 0) needsRedrawRef.current = true;
      const shouldDraw =
        needsRedrawRef.current ||
        dueLivingFrame ||
        activeItems.length > 0;

      // Ambient motion is not a dirty-flag side effect. When animations are on,
      // the canvas redraws at the living cadence even after d3 is fully settled.
      if (shouldDraw) {
        draw(now, activeItems);
        lastDrawAtRef.current = now;
        needsRedrawRef.current = false;
      }

      // Hover detection and activity cards are lightweight and can run
      // every frame even when the graph is settled.
      if (now - lastHoverAtRef.current >= 40) {
        lastHoverAtRef.current = now;
        updateHover(now);
      }
      updateActivityCards(now, activeItems);
    };

    // One bad frame must never kill the graph. If `frame` threw and the rAF
    // chain stopped, the canvas would stay frozen on whatever the backing
    // store last held — after a resize realloc that is a never-painted
    // surface, which the compositor shows as stale striped garbage. Keep the
    // loop alive, log (throttled) for diagnosis, and force a clean redraw.
    let lastFrameErrorAt = 0;
    const loop = () => {
      try {
        frame();
      } catch (e) {
        const now = performance.now();
        if (now - lastFrameErrorAt > 5000) {
          lastFrameErrorAt = now;
          console.error("[mesa] graph frame failed:", e);
        }
        needsRedrawRef.current = true;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      if (activityClearTimerRef.current) clearTimeout(activityClearTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- pointer interactions ----------------------------------------------
  function localPoint(clientX: number, clientY: number) {
    const rect = wrapRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || dragRef.current.node || dragRef.current.panning) return;
    replayCameraRef.current = false;
    const { x, y } = localPoint(e.clientX, e.clientY);
    const n = nodeAtScreen(x, y);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture is best-effort across webviews */
    }
    e.preventDefault();
    if (n) {
      fastDrawUntilRef.current = performance.now() + 500;
      const t = transformRef.current;
      const gx = (x - t.x) / t.k;
      const gy = (y - t.y) / t.k;
      n.fx = n.x;
      n.fy = n.y;
      dragRef.current = { node: n, panning: false, lastX: x, lastY: y, moved: false,
        offsetX: n.x! - gx, offsetY: n.y! - gy };
    } else {
      fastDrawUntilRef.current = performance.now() + 500;
      dragRef.current = { node: null, panning: true, lastX: x, lastY: y, moved: false };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const { x, y } = localPoint(e.clientX, e.clientY);
    pointerRef.current = { x, y, inside: true };
    const d = dragRef.current;
    if (d.node) {
      const t = transformRef.current;
      const gx = (x - t.x) / t.k;
      const gy = (y - t.y) / t.k;
      d.node.fx = gx + (d.offsetX ?? 0);
      d.node.fy = gy + (d.offsetY ?? 0);
      if (Math.abs(x - d.lastX) + Math.abs(y - d.lastY) > 3) {
        const firstMove = !d.moved;
        d.moved = true;
        if (firstMove) {
          const sim = simRef.current;
          // Reheat so the dragged node's cluster follows the pointer in real
          // time (Obsidian-like springy drag). d3's standard drag alphaTarget
          // is 0.3 and Obsidian uses ~0.3; the prior 0.16–0.22 was below that,
          // so the link/charge forces were under-driven and the cluster lagged
          // behind the cursor (anemic follow). Pin alpha to 0.3 for the whole
          // drag so neighbours track the pointer; hubs grab a touch hotter
          // since their cluster has more mass to resettle.
          // Use one calm drag target for every node. Degree-based boosts make
          // hubs yank their whole neighbourhood and feel jittery.
          const target = 0.3;
          sim?.alpha(Math.max(sim.alpha(), target));
          sim?.alphaTarget(target);
        }
        motionUntilRef.current = performance.now() + 2400;
        fastDrawUntilRef.current = performance.now() + 260;
      }
      needsRedrawRef.current = true;
    } else if (d.panning) {
      const t = transformRef.current;
      const dx = x - d.lastX;
      const dy = y - d.lastY;
      t.x += dx;
      t.y += dy;
      d.lastX = x;
      d.lastY = y;
      d.moved = true;
      kickGraph(dx, dy, 0.65);
      motionUntilRef.current = performance.now() + 2400;
      fastDrawUntilRef.current = performance.now() + 260;
      needsRedrawRef.current = true;
    }
  }

  function endDrag(click: boolean) {
    const d = dragRef.current;
    if (d.node) {
      // a click (no drag) pops the note out into its own window. Tag/phantom
      // nodes have no file to open, so a click on them just releases the drag.
      if (click && !d.moved && !isSyntheticNode(d.node))
        void getStore().openDocWindow(d.node.id);
      d.node.fx = null;
      d.node.fy = null;
      const sim = simRef.current;
      if (sim) {
        // Let existing energy decay; releasing a hub must not add a kick.
        sim.alphaTarget(0);
      }
      // Longer, eased motion tail so the post-drag settle reads as living
      // motion, not a hard stop. The draw loop scales ambient amplitude with
      // this tail (lifeBoost), so the graph visibly breathes out.
      motionUntilRef.current = performance.now() + 4600;
      fastDrawUntilRef.current = performance.now() + 220;
      needsRedrawRef.current = true;
    } else if (click && !d.moved && d.panning) {
      // Double-click on empty canvas → re-fit the whole graph (Obsidian-style
      // quick reset after wandering off while panning/zooming).
      const now = performance.now();
      if (now - lastBgClickRef.current < 350) {
        lastBgClickRef.current = 0;
        fitPendingRef.current = true;
        motionUntilRef.current = now + 1200;
        fastDrawUntilRef.current = now + 300;
        needsRedrawRef.current = true;
      } else {
        lastBgClickRef.current = now;
      }
    }
    dragRef.current = { node: null, panning: false, lastX: 0, lastY: 0, moved: false };
  }

  function onPointerUp(e: React.PointerEvent) {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    endDrag(true);
  }
  function onPointerCancel(e: React.PointerEvent) {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    pointerRef.current = { ...pointerRef.current, inside: false };
    endDrag(false);
  }
  function onPointerLeave() {
    pointerRef.current = { ...pointerRef.current, inside: false };
    // Pointer capture keeps a drag alive while the cursor crosses the canvas
    // edge. Do not turn that normal path into an accidental cancellation.
    if (dragRef.current.node || dragRef.current.panning) return;
    endDrag(false);
  }

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
      {hover && (
        <PreviewCard target={{ kind: "note", id: hover.id }} x={hover.x} y={hover.y} />
      )}
      {activity.map((a) => (
        <PreviewCard
          key={"act-" + a.id}
          target={{ kind: "note", id: a.id }}
          x={a.x}
          y={a.y}
          visible={a.visible}
          status={{
            op: a.op,
            label: a.status,
            detail: a.detail,
            added: a.added,
            removed: a.removed,
            filesChanged: a.filesChanged,
            seed: a.seed,
          }}
        />
      ))}
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
