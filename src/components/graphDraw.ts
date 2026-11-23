import type { GraphNode, GraphLink } from "../types";
import type { activeRecords } from "../lib/activity";
import { clamp } from "../lib/clamp";
import { incidentLinkIndices, nodeDrawScale, phaseFromId } from "../lib/graphGeometry";
import { nodeFill, type GraphColors } from "./graphColors";
import { LINK_LAYER_MIN_LINKS, type LinkLayer } from "./graphLinkLayer";
import type { GlLinkRenderer } from "./graphLinkGl";
import { NodePositions, linkIndex } from "./graphLinkGeometry";

// World-space gap enforced by resolveOverlaps() at idle. The living-motion
// breathing budget keys off it: its amplitude is clamped below OVERLAP_GAP/2
// so two nodes drifting toward each other can never visually cross.
export const OVERLAP_GAP = 8;
// Thumbnails decode only for visible nodes at least this many screen px in
// radius; smaller ones draw as dots.
const THUMB_MIN_SCREEN_RADIUS = 4;
// Obsidian's zoom limits, in device px per world unit. Fit and wheel share them.
export const ZOOM_MIN_SCALE = 1 / 128;
export const ZOOM_MAX_SCALE = 8;
// Opacity of everything outside a highlighted node's neighbourhood.
const DIM_ALPHA = 0.2;
// Labels wrap at this world width and are drawn for at most this many nodes.
const LABEL_WRAP_WIDTH = 300;
const LABEL_MAX = 600;
const LABEL_FONT_PX = 16;
const LABEL_LINE_HEIGHT = 1.2;
const LABEL_FONT = `${LABEL_FONT_PX}px -apple-system, system-ui, sans-serif`;

/** Clamp a zoom level (CSS px per world unit) to the shared limits. */
export function clampZoom(k: number, dpr: number): number {
  return clamp(k, ZOOM_MIN_SCALE / dpr, ZOOM_MAX_SCALE / dpr);
}

/** True while the eased zoom is still more than 1% away from its target. */
export function isZooming(k: number, target: number): boolean {
  return (k > target ? k / target : target / k) - 1 >= 0.01;
}

/**
 * Label opacity for a zoom level: labels are fully visible at 1 device px per
 * world unit, gone at half that, and the text-fade setting shifts the range
 * by powers of two (Obsidian's rule).
 */
export function labelZoomAlpha(scale: number, textFade: number): number {
  return clamp(Math.log2(scale) + 1 - textFade, 0, 1);
}

/** A mutable holder; React refs satisfy it. */
interface Ref<T> {
  current: T;
}

export interface Transform {
  x: number;
  y: number;
  k: number;
}

export interface GraphBounds {
  cx: number;
  cy: number;
  radius: number;
  valid: boolean;
}

/** Flat link-endpoint buffers; each frame refills the first `links.length` entries. */
export interface GraphLinkEndpoints {
  sx: Float32Array; sy: Float32Array;
  tx: Float32Array; ty: Float32Array;
  sId: string[]; tId: string[];
}

export interface GraphDisplay {
  arrows: boolean;
  /** -3..3; higher values need more zoom before labels appear. */
  textFade: number;
  nodeSize: number;
  linkThickness: number;
  /** Opt-in ambient motion: drift, breathing, twinkle and bloom. */
  living: boolean;
}

/**
 * Everything one canvas frame reads or writes. Built once per animation-loop
 * lifetime so a frame allocates nothing extra to pass it.
 */
export interface GraphDrawRefs {
  canvasRef: Ref<HTMLCanvasElement | null>;
  ctxRef: Ref<CanvasRenderingContext2D | null>;
  sizeRef: Ref<{ w: number; h: number }>;
  transformRef: Ref<Transform>;
  targetKRef: Ref<number>;
  /** Screen point the eased zoom holds still; null zooms about the view centre. */
  zoomAnchorRef: Ref<{ x: number; y: number } | null>;
  fastDrawUntilRef: Ref<number>;
  dragRef: Ref<{ node: GraphNode | null; panning: boolean }>;
  needsRedrawRef: Ref<boolean>;
  nodesRef: Ref<GraphNode[]>;
  forceNodesRef: Ref<GraphNode[]>;
  linksRef: Ref<GraphLink[]>;
  hoverRef: Ref<{ id: string | null }>;
  colorsRef: Ref<GraphColors>;
  graphDisplayRef: Ref<GraphDisplay>;
  focusRef: Ref<{ id: string | null; k: number }>;
  neighborsRef: Ref<Map<string, Set<string>>>;
  motionUntilRef: Ref<number>;
  linkEndpointsRef: Ref<GraphLinkEndpoints>;
  adjacencyRef: Ref<Map<string, number[]>>;
  nodeByIdRef: Ref<Map<string, GraphNode>>;
  /** Zoom-independent world radius (layout size). */
  nodeRadius: (n: GraphNode) => number;
  graphBounds: (nodes: GraphNode[]) => GraphBounds;
  getImage: (path: string, frame: number) => HTMLImageElement | null;
  /** Cached plain-link bitmap for heavy graphs; absent draws every link directly. */
  linkLayer?: LinkLayer;
  /** WebGL plain links for heavy graphs, behind the 2D canvas; the layer is the fallback. */
  linkGl?: GlLinkRenderer;
}


interface LabelLayout {
  title: string;
  limit: number;
  lines: string[];
}
/** Wrapped label lines per node; node objects are replaced on every rebuild. */
const labelCache = new WeakMap<GraphNode, LabelLayout>();
const LABEL_MAX_LINES = 4;

/** Greedy word wrap at `limit` px of the label font. `ctx.font` must be LABEL_FONT. */
function labelLines(ctx: CanvasRenderingContext2D, n: GraphNode, limit: number): string[] {
  const hit = labelCache.get(n);
  if (hit && hit.title === n.title && hit.limit === limit) return hit.lines;
  const lines: string[] = [];
  let line = "";
  for (const word of n.title.split(/\s+/)) {
    if (!word) continue;
    const next = line ? `${line} ${word}` : word;
    if (line && lines.length < LABEL_MAX_LINES - 1 && ctx.measureText(next).width > limit) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line || lines.length === 0) lines.push(line || n.title);
  labelCache.set(n, { title: n.title, limit, lines });
  return lines;
}

/** Node render positions copied once per frame for the link pass. */
const positions = new NodePositions();
/** Per-node flags of highlighted and active nodes, reused between frames. */
let specialNodes = new Uint8Array(0);

/** Nodes inside the viewport this frame, reused between frames. */
const visibleNodes: GraphNode[] = [];

/**
 * Write each node's render position and radius. Without living motion these
 * are the layout position and the zoom-scaled radius. Living motion adds
 * render-only offsets that never feed back into the simulation.
 */
function updateRenderState(
  refs: GraphDrawRefs,
  nodes: GraphNode[],
  lnow: number,
  drawScale: number,
  living: boolean,
  livingPx: number,
  pulseAmp: number
): void {
  const dragged = refs.dragRef.current.node;
  const halfWidth = Math.max(240, refs.sizeRef.current.w * 0.42);
  for (const n of nodes) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const r = refs.nodeRadius(n) * drawScale;
    // The grabbed node tracks the pointer 1:1, with no ambient offset.
    if (!living || n === dragged || !Number.isFinite(x) || !Number.isFinite(y)) {
      n.renderX = x;
      n.renderY = y;
      n.renderRadius = r;
      continue;
    }
    const phase = n.renderPhase ?? phaseFromId(n.id);
    n.renderPhase = phase;
    const kvx = (n.renderKickVx ?? 0) * 0.82;
    const kvy = (n.renderKickVy ?? 0) * 0.82;
    const kx = ((n.renderKickX ?? 0) + kvx) * 0.84;
    const ky = ((n.renderKickY ?? 0) + kvy) * 0.84;
    n.renderKickVx = Math.abs(kvx) < 0.01 ? 0 : kvx;
    n.renderKickVy = Math.abs(kvy) < 0.01 ? 0 : kvy;
    n.renderKickX = Math.abs(kx) < 0.01 ? 0 : kx;
    n.renderKickY = Math.abs(ky) < 0.01 ? 0 : ky;
    const a = lnow * 0.42 + phase;
    const b = lnow * 0.27 + phase * 1.37;
    // The world origin is the layout centre.
    const len = Math.hypot(x, y);
    const radial = Math.min(1.8, len / halfWidth);
    const breathe = Math.sin(lnow * 0.36 + phase * 0.18) * livingPx * 0.55 * radial;
    const invLen = 1 / Math.max(1, len);
    const mingle = Math.sin(lnow * 0.21 + phase * 0.51) * livingPx * 0.28;
    n.renderX = x + (Math.sin(a) + Math.sin(b) * 0.35) * livingPx * 1.35 + mingle * 0.5 + x * invLen * breathe + kx;
    n.renderY = y + (Math.cos(a * 0.82) + Math.sin(b * 0.7) * 0.32) * livingPx * 1.35 + mingle * -0.28 + y * invLen * breathe + ky;
    // Radius pulse (period ~3.5 s). Non-positional, so it cannot cause overlap.
    n.renderRadius = r * (1 + Math.sin(lnow * 1.8 + phase) * pulseAmp);
  }
}

/**
 * Draw one graph frame: links, arrows, nodes and labels, viewport-culled, in
 * Obsidian's default style. Never ticks or reheats the simulation; it only
 * eases the wheel zoom and sets `needsRedrawRef` while zooming.
 */
export function drawGraph(
  refs: GraphDrawRefs,
  now: number,
  activeItems: ReturnType<typeof activeRecords>,
  animationsOn: boolean,
  active: string | null
): void {
  const canvas = refs.canvasRef.current;
  const ctx = refs.ctxRef.current;
  if (!canvas || !ctx) return;
  const { w, h } = refs.sizeRef.current;
  const t = refs.transformRef.current;
  const dpr = window.devicePixelRatio || 1;
  const lnow = now / 1000;
  const display = refs.graphDisplayRef.current;
  const living = animationsOn && display.living;
  const zooming = isZooming(t.k, refs.targetKRef.current);
  const fastDraw =
    now < refs.fastDrawUntilRef.current ||
    refs.dragRef.current.panning ||
    !!refs.dragRef.current.node ||
    zooming;

  // Ease the zoom 15% of the way to its target each frame, holding the anchor still.
  if (zooming) {
    const anchor = refs.zoomAnchorRef.current;
    const cx = anchor ? anchor.x : w / 2;
    const cy = anchor ? anchor.y : h / 2;
    const k2 = t.k + (refs.targetKRef.current - t.k) * 0.15;
    t.x = cx - (cx - t.x) * (k2 / t.k);
    t.y = cy - (cy - t.y) * (k2 / t.k);
    t.k = k2;
    refs.needsRedrawRef.current = true;
  }

  // Obsidian measures zoom in device px per world unit.
  const scale = t.k * dpr;
  const drawScale = nodeDrawScale(t.k, dpr);
  const devicePx = 1 / scale; // one device pixel, in world units

  const nodes = refs.nodesRef.current;
  const links = refs.linksRef.current;
  const c = refs.colorsRef.current;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = nodes.length > 1500 ? "low" : nodes.length > 700 ? "medium" : "high";
  ctx.translate(t.x, t.y);
  ctx.scale(t.k, t.k);
  if (living && nodes.length > 0) {
    // Sparse, slow orbital drift. World-space so it scales with zoom.
    const driftPhase = lnow * 0.15;
    ctx.translate(
      (Math.sin(driftPhase) * 0.8) / Math.max(0.7, t.k),
      (Math.cos(driftPhase * 0.87) * 0.55) / Math.max(0.7, t.k)
    );
  }

  // ---- Highlight: the grabbed node, else the hovered node -----------------
  // Its neighbourhood stays at full strength and everything else fades to
  // DIM_ALPHA; the transition is eased in the frame loop (focusRef.k).
  const dragId = refs.dragRef.current.node?.id ?? null;
  const focus = refs.focusRef.current;
  const focusK = focus.k;
  const focusId = dragId ?? (focusK > 0.004 ? focus.id : null);
  const focusSet = focusId ? refs.neighborsRef.current.get(focusId) : undefined;
  const dimK = focusId ? 1 - (1 - DIM_ALPHA) * focusK : 1;

  // ---- Living motion amplitudes (zero unless the user opted in) -----------
  const tail = clamp((refs.motionUntilRef.current - now) / 4600, 0, 1);
  const lifeBoost = 1 + tail * tail * (3 - 2 * tail) * 0.3;
  const livingScale = living ? (nodes.length > 1200 ? 1.2 : 1.7) : 0;
  // Screen-space breathing amplitude, clamped so two adjacent nodes breathing
  // toward each other can never touch.
  const livingPx = clamp(livingScale * lifeBoost, 0, (OVERLAP_GAP * t.k) / 2 - 0.5) / Math.max(0.2, t.k);
  const pulseAmp = living ? (nodes.length > 1200 ? 0.2 : nodes.length > 700 ? 0.26 : 0.32) : 0;
  const twinkleAmp = living ? (nodes.length > 1200 ? 0.26 : nodes.length > 700 ? 0.34 : 0.4) : 0;

  // Active node ids, collected once per frame for O(1) lookup in the hot loops.
  const actMap = new Map<string, { intensity: number; rate: number }>();
  for (const { id, rec } of activeItems) actMap.set(id, { intensity: rec.intensity, rate: rec.rate });

  updateRenderState(refs, nodes, lnow, drawScale, living, livingPx, pulseAmp);

  // ---- Viewport culling bounds (world space) ------------------------------
  const margin = 60 / t.k;
  const vx0 = -t.x / t.k - margin;
  const vy0 = -t.y / t.k - margin;
  const vx1 = (w - t.x) / t.k + margin;
  const vy1 = (h - t.y) / t.k + margin;

  if (living) {
    // A dark, soft bloom behind the graph. Part of living motion only.
    const bounds = refs.graphBounds(refs.forceNodesRef.current);
    if (bounds.valid) {
      const bloomPulse = 0.7 + 0.22 * Math.sin(lnow * 0.26 + bounds.radius * 0.01);
      const bloomRadius = bounds.radius + (Math.min(w, h) * 0.2 + Math.sin(lnow * 0.18) * 14) / t.k;
      const bloom = ctx.createRadialGradient(bounds.cx, bounds.cy, Math.max(24, bounds.radius * 0.12), bounds.cx, bounds.cy, bloomRadius);
      bloom.addColorStop(0, `rgba(${c.flickerRgb},${(0.045 * c.bloomAlpha * bloomPulse).toFixed(3)})`);
      bloom.addColorStop(0.45, `rgba(${c.flickerRgb},${(0.018 * c.bloomAlpha * bloomPulse).toFixed(3)})`);
      bloom.addColorStop(1, `rgba(${c.flickerRgb},0)`);
      ctx.globalAlpha = 1;
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(bounds.cx, bounds.cy, bloomRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- LINKS --------------------------------------------------------------
  // Each line runs between the two circle edges, one device pixel wide at
  // thickness 1. Endpoints are NaN for a link too short to show.
  ctx.lineCap = "butt";
  const le = refs.linkEndpointsRef.current;
  const lc = links.length;
  // Heavy graphs draw plain links with WebGL, or else through a cached 2D
  // layer; links of the highlighted or active nodes draw on top in 2D.
  const heavy = lc >= LINK_LAYER_MIN_LINKS && !living;
  const gl = heavy && display.linkThickness === 1 && refs.linkGl?.ready() ? refs.linkGl : null;
  const layer = !gl && heavy && refs.linkLayer ? refs.linkLayer : null;
  if (refs.linkLayer) refs.linkLayer.active = layer !== null;
  const index = linkIndex(links, nodes);
  le.sId = index.sId;
  le.tId = index.tId;
  // A grabbed or hovered node's own links are drawn in 2D, so it alone moving changes nothing below.
  const linksMoved = positions.load(nodes, focusId, refs.nodeRadius);
  const geometryChanged = (layer ? layer.linksChanged(links) : false) || linksMoved || (!layer && !gl);
  const px = positions.x, py = positions.y, pr = positions.r;
  const endpoint = (i: number): void => {
    const si = index.s[i], ti = index.t[i];
    let sx: number, sy: number, tx: number, ty: number, rs: number, rt: number;
    if (si >= 0 && ti >= 0) {
      sx = px[si]; sy = py[si]; tx = px[ti]; ty = py[ti]; rs = pr[si]; rt = pr[ti];
    } else {
      // An endpoint outside `nodes` (never during normal drawing): read the objects.
      const s = links[i].source as GraphNode, tg = links[i].target as GraphNode;
      sx = s.renderX ?? s.x ?? 0; sy = s.renderY ?? s.y ?? 0; tx = tg.renderX ?? tg.x ?? 0; ty = tg.renderY ?? tg.y ?? 0;
      rs = s.renderRadius ?? 0; rt = tg.renderRadius ?? 0;
    }
    const dx = tx - sx;
    const dy = ty - sy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > rs + rt)) {
      le.sx[i] = NaN;
      return;
    }
    le.sx[i] = sx + (dx / len) * rs;
    le.sy[i] = sy + (dy / len) * rs;
    le.tx[i] = tx - (dx / len) * rt;
    le.ty[i] = ty - (dy / len) * rt;
  };
  const partial = gl !== null && !display.arrows;
  if (partial) {
    // The GPU trims plain links itself; only highlighted and active links draw in 2D.
    const adjacency = refs.adjacencyRef.current;
    if (focusId != null) for (const i of adjacency.get(focusId) ?? []) endpoint(i);
    if (actMap.size) for (const i of incidentLinkIndices(adjacency, actMap.keys())) endpoint(i);
  } else {
    for (let i = 0; i < lc; i++) endpoint(i);
  }
  const lineWidth = display.linkThickness * devicePx;

  // Batch 1: every link without activity or highlight, in one stroke. Under a
  // highlight this whole batch is outside the neighbourhood, so it dims at once.
  // Returns whether any link was culled outside the view.
  const strokePlainLinks = (target: CanvasRenderingContext2D, alpha: number): boolean => {
    let culled = false;
    target.beginPath();
    target.strokeStyle = c.link;
    target.lineWidth = lineWidth;
    target.globalAlpha = alpha;
    for (let i = 0; i < lc; i++) {
      const sx = le.sx[i], sy = le.sy[i], tx = le.tx[i], ty = le.ty[i];
      if (!isFinite(sx) || !isFinite(sy) || !isFinite(tx) || !isFinite(ty)) continue;
      if ((sx < vx0 && tx < vx0) || (sx > vx1 && tx > vx1) || (sy < vy0 && ty < vy0) || (sy > vy1 && ty > vy1)) {
        culled = true;
        continue;
      }
      const sId = le.sId[i], tId = le.tId[i];
      if (actMap.size && (actMap.has(sId) || actMap.has(tId))) continue; // batch 3
      if (focusId != null && (sId === focusId || tId === focusId)) continue; // batch 2
      target.moveTo(sx, sy);
      target.lineTo(tx, ty);
    }
    target.stroke();
    target.globalAlpha = 1;
    return culled;
  };
  let layered = false;
  if (gl) {
    // Links of the highlighted and active nodes draw in 2D: mark those nodes.
    const someSpecial = focusId != null || actMap.size > 0;
    let skipNodes: Uint8Array | null = null;
    if (someSpecial) {
      skipNodes = specialNodes.length >= nodes.length ? specialNodes.fill(0, 0, nodes.length) : (specialNodes = new Uint8Array(nodes.length));
      for (const id of [focusId, ...actMap.keys()]) {
        const node = id == null ? undefined : refs.nodeByIdRef.current.get(id);
        const at = node ? index.nodeAt(node) : -1;
        if (at >= 0) skipNodes[at] = 1;
      }
    }
    layered = gl.draw(canvas, {
      s: index.s, t: index.t, count: lc, x: positions.x, y: positions.y, base: positions.base, nodeCount: nodes.length, drawScale,
      skipNodes,
      skipKey: `${focusId ?? ""}|${actMap.size ? [...actMap.keys()].sort().join("\u0000") : ""}`,
      moved: positions.placesChanged,
      linksChanged: gl.linksChanged(links),
      k: t.k, panX: t.x, panY: t.y, dpr, color: c.link, alpha: dimK,
    });
  } else {
    refs.linkGl?.clear();
  }
  if (layer) {
    const activeKey = actMap.size ? [...actMap.keys()].sort().join("\u0000") : "";
    // Line width scales with zoom, so the style key leaves it out; zoom is checked apart.
    const frame = { key: [dpr, w, h, display.linkThickness, c.link, focusId ?? "", activeKey].join("|"), k: t.k, tx: t.x, ty: t.y, dpr, alpha: dimK };
    // A zoom ease shows the newest layer scaled for up to 50 ms between sharp draws.
    layered = zooming && layer.drawScaled(ctx, frame, now, 50);
    if (!layered && geometryChanged) layer.invalidate();
    layered = layered || layer.draw(ctx, frame, (target) => {
      target.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);
      target.lineCap = "butt";
      return strokePlainLinks(target, 1);
    }, now);
  }
  if (!layered) {
    layer?.invalidate();
    // WebGL failed after a partial endpoint pass: compute every link now.
    if (partial) for (let i = 0; i < lc; i++) endpoint(i);
    strokePlainLinks(ctx, dimK);
  }

  // Batch 2: links of the highlighted node, cross-faded to the accent colour.
  const adjacency = refs.adjacencyRef.current;
  if (focusId != null) {
    const strokeIncident = (style: string, alpha: number) => {
      if (alpha <= 0.004) return;
      ctx.beginPath();
      ctx.strokeStyle = style;
      ctx.globalAlpha = alpha;
      for (const i of adjacency.get(focusId) ?? []) {
        if (actMap.size && (actMap.has(le.sId[i]) || actMap.has(le.tId[i]))) continue;
        const sx = le.sx[i], sy = le.sy[i], tx = le.tx[i], ty = le.ty[i];
        if (!isFinite(sx) || !isFinite(sy) || !isFinite(tx) || !isFinite(ty)) continue;
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
      }
      ctx.stroke();
    };
    const accent = dragId ? 1 : focusK;
    strokeIncident(c.link, 1 - accent);
    strokeIncident(c.linkActive, accent);
    ctx.globalAlpha = 1;
  }

  // Batch 3: links of files with live activity flicker, each with its own style.
  for (const i of actMap.size ? incidentLinkIndices(adjacency, actMap.keys()) : []) {
    const sa = actMap.get(le.sId[i]);
    const ta = actMap.get(le.tId[i]);
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
    ctx.strokeStyle = `rgba(${c.flickerRgb},${(0.12 + 0.36 * amp * flick).toFixed(3)})`;
    ctx.lineWidth = lineWidth * (1 + amp);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
  }

  // Arrows fade in between 0.3 and 0.8 device px per world unit.
  const arrowAlpha = display.arrows ? 0.5 * clamp(2 * (scale - 0.3), 0, 1) : 0;
  if (arrowAlpha > 0.001) {
    const size = 2 * Math.sqrt(display.linkThickness) * devicePx;
    ctx.fillStyle = c.label;
    for (let i = 0; i < lc; i++) {
      const sx = le.sx[i], sy = le.sy[i], tx = le.tx[i], ty = le.ty[i];
      if (!isFinite(sx) || !isFinite(sy) || !isFinite(tx) || !isFinite(ty)) continue;
      if ((sx < vx0 && tx < vx0) || (sx > vx1 && tx > vx1)) continue;
      if ((sy < vy0 && ty < vy0) || (sy > vy1 && ty > vy1)) continue;
      const dx = tx - sx;
      const dy = ty - sy;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (!(len > lineWidth)) continue;
      const ux = dx / len;
      const uy = dy / len;
      const incident = focusId != null && (le.sId[i] === focusId || le.tId[i] === focusId);
      ctx.globalAlpha = arrowAlpha * (incident ? 1 : dimK);
      // Tip one device pixel short of the target circle; barbs 4 long, 2 wide, notched at 3.
      const ex = tx - ux * devicePx;
      const ey = ty - uy * devicePx;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - ux * 4 * size + uy * 2 * size, ey - uy * 4 * size - ux * 2 * size);
      ctx.lineTo(ex - ux * 3 * size, ey - uy * 3 * size);
      ctx.lineTo(ex - ux * 4 * size - uy * 2 * size, ey - uy * 4 * size + ux * 2 * size);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---- NODES --------------------------------------------------------------
  visibleNodes.length = 0;
  const glowPx = 1 / t.k; // one CSS pixel, in world units
  for (const n of nodes) {
    if (n.x == null || n.y == null) continue;
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    const r = n.renderRadius ?? refs.nodeRadius(n) * drawScale;
    const rx = n.renderX ?? n.x;
    const ry = n.renderY ?? n.y;
    if (rx < vx0 - r || rx > vx1 + r || ry < vy0 - r || ry > vy1 + r) continue;
    visibleNodes.push(n);

    const act = actMap.get(n.id);
    const isActive = n.id === active;
    const isFocus = n.id === focusId;

    // Activity flicker: a soft blip per edit that fades with the activity
    // decay (sum of sines, no random shimmer). Constant size on screen.
    if (act && act.intensity > 0.01) {
      const amp = Math.min(1, act.intensity);
      const ws = lnow * (3 + act.rate * 1.4);
      const flick = 0.55 + 0.3 * Math.sin(ws) + 0.12 * Math.sin(ws * 1.7);
      const glowR = r + (4 + amp * 10) * flick * glowPx;
      const g = ctx.createRadialGradient(rx, ry, r * 0.4, rx, ry, glowR);
      g.addColorStop(0, `rgba(${c.flickerRgb},${(0.3 * amp * flick).toFixed(3)})`);
      g.addColorStop(1, `rgba(${c.flickerRgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(rx, ry, glowR, 0, Math.PI * 2);
      ctx.fill();
    }

    const twinkle =
      twinkleAmp > 0 && !act && !isActive && !isFocus
        ? clamp(1 + Math.sin(lnow * 2.4 + (n.renderPhase ?? 0) * 2.7) * twinkleAmp, 0.52, 1)
        : 1;
    // Unresolved links draw at half strength; nodes outside a highlighted
    // neighbourhood recede.
    let nodeAlpha = twinkle * (n.kind === "phantom" ? 0.5 : 1);
    if (focusId && !isFocus && !focusSet?.has(n.id) && !act) nodeAlpha *= dimK;
    ctx.globalAlpha = nodeAlpha;
    const img = !fastDraw && n.thumbPath && r * t.k >= THUMB_MIN_SCREEN_RADIUS ? refs.getImage(n.thumbPath, now) : null;
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
      // The highlighted node and the open file take the accent fill.
      ctx.fillStyle = isFocus || isActive ? c.nodeActive : nodeFill(n, c);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (isFocus) {
      // Accent ring, at least one device pixel wide.
      const ringWidth = Math.max(drawScale, devicePx);
      ctx.globalAlpha = dragId ? 1 : focusK;
      ctx.beginPath();
      ctx.arc(rx, ry, r + ringWidth / 2, 0, Math.PI * 2);
      ctx.strokeStyle = c.nodeActive;
      ctx.lineWidth = ringWidth;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // ---- LABELS -------------------------------------------------------------
  // Every visible node has a label below it. Opacity follows the zoom level;
  // the highlighted node's label is always shown, at a constant size when
  // zoomed out, and shifted down 15 device pixels.
  const textAlpha = labelZoomAlpha(scale, display.textFade);
  const focusNode = focusId ? refs.nodeByIdRef.current.get(focusId) : undefined;
  if (textAlpha > 0.001 || focusNode) {
    ctx.font = LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = c.label;
    const drawLabel = (n: GraphNode, alpha: number, highlighted: boolean): void => {
      const size = refs.nodeRadius(n);
      const fontWorld = 14 + size / 4;
      const fontPx = highlighted && scale < 1 ? fontWorld / dpr : fontWorld * drawScale * t.k;
      if (fontPx < 2 && !highlighted) return;
      const sx = (n.renderX ?? n.x ?? 0) * t.k + t.x;
      const sy = ((n.renderY ?? n.y ?? 0) + (size + 5) * drawScale) * t.k + t.y + (highlighted ? (15 * focusK) / dpr : 0);
      const f = fontPx / LABEL_FONT_PX;
      const lines = labelLines(ctx, n, (LABEL_WRAP_WIDTH / fontWorld) * LABEL_FONT_PX);
      ctx.globalAlpha = alpha;
      ctx.setTransform(dpr * f, 0, 0, dpr * f, sx * dpr, sy * dpr);
      for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], 0, i * LABEL_FONT_PX * LABEL_LINE_HEIGHT);
    };
    if (textAlpha > 0.001) {
      const count = Math.min(visibleNodes.length, LABEL_MAX);
      for (let i = 0; i < count; i++) {
        const n = visibleNodes[i];
        if (n === focusNode) continue;
        const near = !focusId || focusSet?.has(n.id);
        drawLabel(n, textAlpha * (near ? 1 : dimK), false);
      }
    }
    if (focusNode && Number.isFinite(focusNode.x) && Number.isFinite(focusNode.y)) {
      drawLabel(focusNode, dragId ? 1 : Math.max(textAlpha, focusK), true);
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  visibleNodes.length = 0;
}
