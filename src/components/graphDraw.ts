import type { GraphNode, GraphLink } from "../types";
import type { activeRecords } from "../lib/activity";
import { clamp, incidentLinkIndices, phaseFromId } from "../lib/graphGeometry";
import { nodeFill, type GraphColors } from "./graphColors";

// How many of the highest-degree nodes always get a title label (the rest
// show only on hover/active). degreeSortedRef is pre-sorted by degree desc.
const LABEL_TOP_N = 10;
// World-space gap enforced by resolveOverlaps() every frame. Both forceCollide
// and the ambient breathing budget key off it: breathing amplitude is clamped
// below OVERLAP_GAP/2 so two nodes drifting toward each other can never
// visually cross, giving a hard no-overlap guarantee that coexists with living
// motion. Constant (not zoom-dependent) so layout is stable under zoom.
export const OVERLAP_GAP = 8;
// Thumbnails decode only for visible nodes at least this many screen px in
// radius; smaller ones draw as dots.
const THUMB_MIN_SCREEN_RADIUS = 4;

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
  textFadeThreshold: number;
  nodeSize: number;
  linkThickness: number;
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
  fastDrawUntilRef: Ref<number>;
  dragRef: Ref<{ node: GraphNode | null; panning: boolean }>;
  pointerRef: Ref<{ x: number; y: number }>;
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
  recentActivityRef: Ref<Map<string, number>>;
  linkEndpointsRef: Ref<GraphLinkEndpoints>;
  adjacencyRef: Ref<Map<string, number[]>>;
  nodeByIdRef: Ref<Map<string, GraphNode>>;
  degreeSortedRef: Ref<GraphNode[]>;
  nodeRadius: (n: GraphNode) => number;
  graphBounds: (nodes: GraphNode[]) => GraphBounds;
  getImage: (path: string, frame: number) => HTMLImageElement | null;
}

/**
 * Draw one graph frame: render-only ambient offsets, bloom, links, arrows,
 * nodes and labels, viewport-culled. Never ticks or reheats the simulation;
 * it only eases the wheel zoom and sets `needsRedrawRef` while zooming.
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
  const fastDraw =
    now < refs.fastDrawUntilRef.current ||
    refs.dragRef.current.panning ||
    !!refs.dragRef.current.node ||
    Math.abs(refs.targetKRef.current - t.k) > 0.0005;

  // ease zoom toward its target for buttery wheel response
  if (Math.abs(refs.targetKRef.current - t.k) > 0.0005) {
    const cx = refs.pointerRef.current.x || w / 2;
    const cy = refs.pointerRef.current.y || h / 2;
    const k2 = t.k + (refs.targetKRef.current - t.k) * 0.2;
    t.x = cx - (cx - t.x) * (k2 / t.k);
    t.y = cy - (cy - t.y) * (k2 / t.k);
    t.k = k2;
    refs.needsRedrawRef.current = true;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality =
    refs.nodesRef.current.length > 1500
      ? "low"
      : refs.nodesRef.current.length > 700
      ? "medium"
      : "high";
  ctx.translate(t.x, t.y);
  ctx.scale(t.k, t.k);
  if (animationsOn && refs.nodesRef.current.length > 0) {
    // Sparse, slow orbital drift — closer to Obsidian's near-still graph
    // than a visibly swimming graph. World-space so it scales with zoom.
    const driftPhase = lnow * 0.15;
    ctx.translate(
      Math.sin(driftPhase) * 0.8 / Math.max(0.7, t.k),
      Math.cos(driftPhase * 0.87) * 0.55 / Math.max(0.7, t.k)
    );
  }

  const nodes = refs.nodesRef.current;
  const forceNodes = refs.forceNodesRef.current;
  const links = refs.linksRef.current;
  const hoverId = refs.hoverRef.current.id;
  // The node currently being dragged (if any). Its incident links are
  // highlighted in Batch 2 so the dragged cluster's edges read clearly
  // while dragging — same idea as hover/active, but a brighter, steadier
  // style so it stays legible against the moving cluster.
  const dragNode = refs.dragRef.current.node;
  const dragId = dragNode?.id ?? null;
  const c = refs.colorsRef.current;
  const display = refs.graphDisplayRef.current;
  // ---- Obsidian-style hover focus -----------------------------------
  // While a node is hovered, its neighborhood stays at full strength and
  // everything else dims; the transition is eased in the loop (refs.focusRef.k)
  // so it fades in/out instead of flashing. During drag the whole graph is
  // in motion, so focus is released to keep the picture calm.
  const focus = refs.focusRef.current;
  const focusK = focus.k * focus.k * (3 - 2 * focus.k); // smoothstep
  const focusId = focusK > 0.02 && !dragId ? focus.id : null;
  const focusSet = focusId ? refs.neighborsRef.current.get(focusId) : undefined;
  // Obsidian keeps the rest of the graph readable while a hovered
  // neighborhood is emphasized. Do not fade the surrounding topology so
  // deeply that the fitted graph becomes hard to inspect or drag.
  const dimK = 1 - 0.38 * focusK;
  const tail = clamp((refs.motionUntilRef.current - now) / 4600, 0, 1);
  const tailEase = tail * tail * (3 - 2 * tail);
  const lifeBoost = 1 + tailEase * 0.3;
  // Ambient motion changes render coordinates only. Cap offsets at half the scaled overlap gap.
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
  const recentAct = refs.recentActivityRef.current;
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
  const dragged = refs.dragRef.current.node;
  for (const n of nodes) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const phase = n.renderPhase ?? phaseFromId(n.id);
    n.renderPhase = phase;
    const r = refs.nodeRadius(n);
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
    const cx = x - refs.sizeRef.current.w / 2;
    const cy = y - refs.sizeRef.current.h / 2;
    // Distance from viewport center, reused for both the radial breathe
    // scale and the inward-unit-vector — one hypot per node per frame, not
    // two (identical value; ~20% off this loop's cost at stress scale).
    const len = Math.hypot(cx, cy);
    const radial = Math.min(
      1.8,
      len / Math.max(240, refs.sizeRef.current.w * 0.42)
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
  const forceBounds = refs.graphBounds(forceNodes);
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
  const le = refs.linkEndpointsRef.current;
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

  // Highlight hovered, active, and dragged links separately from activity flicker; ease hover and active fades.
  const hotColor = `rgba(${c.flickerRgb},${(0.14 + 0.3 * focusK).toFixed(3)})`;
  const activeColor = `rgba(${c.flickerRgb},${(0.22 * activeFade).toFixed(3)})`;
  const dragColor = `rgba(${c.flickerRgb},0.22)`;
  // Batches 2 and 3 visit only links incident to their nodes, in link order.
  const adjacency = refs.adjacencyRef.current;
  for (const i of incidentLinkIndices(adjacency, [active, hoverId, dragId])) {
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
  for (const i of actMap.size ? incidentLinkIndices(adjacency, actMap.keys()) : []) {
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
      const targetNode = refs.nodeByIdRef.current.get(le.tId[i]);
      const targetRadius = targetNode ? refs.nodeRadius(targetNode) : 6;
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
    const r = n.renderRadius ?? refs.nodeRadius(n);
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

    const img = !fastDraw && n.thumbPath && r * t.k >= THUMB_MIN_SCREEN_RADIUS ? refs.getImage(n.thumbPath, now) : null;
    // Clip image thumbnails to circles. Keep grabbed nodes steady while other nodes twinkle.
    const twinkle =
      animationsOn && !act && !isActive && n !== refs.dragRef.current.node
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
      const sr = (n.renderRadius ?? refs.nodeRadius(n)) * t.k;
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
    const byId = refs.nodeByIdRef.current;
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
    const topN = Math.min(LABEL_TOP_N, refs.degreeSortedRef.current.length);
    for (let i = 0; i < topN; i++) {
      if (drawn >= 120) break;
      const n = refs.degreeSortedRef.current[i];
      // Non-neighbor top-N labels recede along with their nodes.
      const dimmed =
        focusId && n.id !== focusId && !focusSet?.has(n.id);
      place(n, false, dimmed ? zoomAlpha * dimK : undefined);
    }
    ctx.globalAlpha = 1;
  }
}
