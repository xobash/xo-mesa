import type { GraphNode, GraphLink } from "../types";
import { getStore } from "../store";
import type { activeRecords, ActivityOp } from "../lib/activity";
import { clamp, rectContains, rectLinePenalty } from "./graphGeometry";
import { isSyntheticNode } from "./graphColors";
import type { Transform } from "./graphDraw";
import { PreviewCard } from "./PreviewCard";

export interface ActivityCard {
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
export interface GraphHoverCard {
  id: string;
  x: number;
  y: number;
}
const ACTIVITY_CAP = 4; // most cards shown at once, strongest first
const ACTIVITY_LINGER_MS = 1000;
const ACTIVITY_FADE_MS = 240;
const CARD_W = 360;
const CARD_H = 300;

/** A mutable holder; React refs satisfy it. */
interface Ref<T> {
  current: T;
}

/**
 * Graph state the hover and activity cards read or write. Built once per
 * animation-loop lifetime.
 */
export interface GraphCardRefs {
  transformRef: Ref<Transform>;
  sizeRef: Ref<{ w: number; h: number }>;
  adjacencyRef: Ref<Map<string, number[]>>;
  linksRef: Ref<GraphLink[]>;
  nodeByIdRef: Ref<Map<string, GraphNode>>;
  graphControlsHoverRef: Ref<boolean>;
  dragRef: Ref<{ node: GraphNode | null; panning: boolean }>;
  hoverRef: Ref<{ id: string | null; since: number }>;
  shownIdRef: Ref<string | null>;
  pointerRef: Ref<{ x: number; y: number; inside: boolean }>;
  activityRef: Ref<ActivityCard[]>;
  lastActAtRef: Ref<number>;
  activitySigRef: Ref<string>;
  activityHoldUntilRef: Ref<number>;
  activityClearTimerRef: Ref<ReturnType<typeof setTimeout> | null>;
  nodeRadius: (n: GraphNode) => number;
  nodeAtScreen: (sx: number, sy: number) => GraphNode | null;
  clearGraphHover: () => void;
  setHover: (hover: GraphHoverCard | null) => void;
  setActivity: (cards: ActivityCard[]) => void;
}

/** The delayed hover preview plus one live card per active node. */
export function GraphActivityCards({ hover, activity }: { hover: GraphHoverCard | null; activity: ActivityCard[] }) {
  return (
    <>
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
    </>
  );
}

/**
 * Card position near `preferred` that never covers `node` and avoids its
 * incident links and the already `placed` cards.
 */
export function placePreviewCard(
  refs: GraphCardRefs,
  node: GraphNode,
  placed: { x: number; y: number }[] = [],
  preferred?: { x: number; y: number }
): { x: number; y: number; corner: boolean } {
  const t = refs.transformRef.current;
  const { w, h } = refs.sizeRef.current;
  const sx = (node.x ?? 0) * t.k + t.x;
  const sy = (node.y ?? 0) * t.k + t.y;
  const r = refs.nodeRadius(node) * t.k + 20;
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
  const linkIndices = refs.adjacencyRef.current.get(node.id) ?? [];
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
      const l = refs.linksRef.current[li];
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
}

export function updateGraphHover(refs: GraphCardRefs, now: number): void {
  if (refs.graphControlsHoverRef.current) {
    refs.clearGraphHover();
    return;
  }
  const d = refs.dragRef.current;
  // While dragging a node or panning, never show a preview — and dismiss any
  // card that was already up before the drag began (5a).
  if (d.node || d.panning) {
    refs.hoverRef.current.id = null;
    if (refs.shownIdRef.current !== null) {
      refs.shownIdRef.current = null;
      refs.setHover(null);
    }
    return;
  }
  const p = refs.pointerRef.current;
  if (!p.inside) {
    refs.hoverRef.current.id = null;
    if (refs.shownIdRef.current !== null) {
      refs.shownIdRef.current = null;
      refs.setHover(null);
    }
    return;
  }
  const hit = refs.nodeAtScreen(p.x, p.y);
  // Tag/phantom nodes have no underlying file, so they get no preview card.
  const n = hit && !isSyntheticNode(hit) ? hit : null;
  const id = n?.id ?? null;
  const delay = getStore().settings.hoverDelayMs;
  if (id !== refs.hoverRef.current.id) {
    refs.hoverRef.current.id = id;
    refs.hoverRef.current.since = now;
    // Prewarm the preview content the moment a node is hovered, so the
    // card body is ready when the hover delay elapses (peek = capped read).
    if (id) void getStore().ensurePeek(id);
    if (id === null && refs.shownIdRef.current !== null) {
      refs.shownIdRef.current = null;
      refs.setHover(null);
    }
  } else if (
    id &&
    n &&
    now - refs.hoverRef.current.since >= delay &&
    refs.shownIdRef.current !== id
  ) {
    refs.shownIdRef.current = id;
    const place = placePreviewCard(refs, n, refs.activityRef.current, {
      x: p.x + 16,
      y: p.y + 16,
    });
    refs.setHover({ id, x: place.x, y: place.y });
  }
}

// Float a live preview card over every node with current activity (the file
// being read/edited/written/created), strongest first. Throttled, and only
// pushes to React state when something actually changed.
export function updateActivityCards(
  refs: GraphCardRefs,
  now: number,
  activeItems: ReturnType<typeof activeRecords>
): void {
  if (now - refs.lastActAtRef.current < 140) return;
  refs.lastActAtRef.current = now;
  const t = refs.transformRef.current;
  const { w, h } = refs.sizeRef.current;
  const byId = refs.nodeByIdRef.current;
  const hoveredId = refs.shownIdRef.current; // don't double-card the hovered node
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
    const place = placePreviewCard(refs, n, items, {
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
    refs.activityHoldUntilRef.current = now + ACTIVITY_LINGER_MS;
    if (refs.activityClearTimerRef.current) {
      clearTimeout(refs.activityClearTimerRef.current);
      refs.activityClearTimerRef.current = null;
    }
  }
  const nextItems =
    items.length > 0
      ? items
      : now < refs.activityHoldUntilRef.current
      ? refs.activityRef.current
      : refs.activityRef.current.length > 0
      ? refs.activityRef.current.map((item) => ({ ...item, visible: false }))
      : [];
  if (
    items.length === 0 &&
    refs.activityRef.current.length > 0 &&
    now >= refs.activityHoldUntilRef.current &&
    !refs.activityClearTimerRef.current
  ) {
    refs.activityClearTimerRef.current = setTimeout(() => {
      refs.activityClearTimerRef.current = null;
      refs.activityRef.current = [];
      refs.activitySigRef.current = "";
      refs.setActivity([]);
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
  if (sig !== refs.activitySigRef.current) {
    refs.activitySigRef.current = sig;
    refs.activityRef.current = nextItems;
    refs.setActivity(nextItems);
  }
}
