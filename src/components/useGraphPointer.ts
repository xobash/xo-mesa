import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Simulation } from "d3-force";
import type { GraphNode, GraphLink } from "../types";
import { getStore } from "../store";
import { GRAPH_REHEAT_ALPHA, reheatGraphSimulation, type GraphPhysicsRequest } from "../lib/graphPhysics";
import { markMesaPerf } from "../lib/mesaPerf";
import { isSyntheticNode } from "./graphColors";
import type { Transform } from "./graphDraw";

export interface DragState {
  node: GraphNode | null;
  panning: boolean;
  lastX: number;
  lastY: number;
  moved: boolean;
  offsetX?: number;
  offsetY?: number;
  /** Time of the last pan move, for release inertia. */
  lastMoveAt?: number;
}

/** Bounded per-drag frame samples, summarized into one local `graph-drag` mark. */
export interface DragPerf {
  startedAt: number;
  last: number;
  intervals: number[];
  work: number[];
  draw: number[];
  physics: number;
}

/** A mutable holder; React refs satisfy it. */
interface Ref<T> {
  current: T;
}

export interface GraphPointerDeps {
  wrapRef: Ref<HTMLDivElement | null>;
  transformRef: Ref<Transform>;
  dragRef: Ref<DragState>;
  pointerRef: Ref<{ x: number; y: number; inside: boolean }>;
  simRef: Ref<Simulation<GraphNode, GraphLink> | null>;
  physicsRef: Ref<{ active: boolean; session: number; index: Map<GraphNode, number> }>;
  dragPerfRef: Ref<DragPerf | null>;
  needsRedrawRef: Ref<boolean>;
  motionUntilRef: Ref<number>;
  fastDrawUntilRef: Ref<number>;
  replayCameraRef: Ref<boolean>;
  fitPendingRef: Ref<boolean>;
  resumeRef: Ref<() => void>;
  forceNodesRef: Ref<GraphNode[]>;
  /** Pan inertia in CSS px per ms; the frame loop coasts and decays it. */
  panVelocityRef: Ref<{ x: number; y: number; at: number }>;
  nodeAtScreen: (sx: number, sy: number) => GraphNode | null;
  kickGraph: (dx: number, dy: number, strength?: number) => void;
  startDragPhysics: (node: GraphNode | null) => void;
  postPhysics: (message: GraphPhysicsRequest) => void;
}

/**
 * Canvas pointer handlers: node grab and drag, background pan, click to open,
 * and double-click to fit. `endDrag` also releases a grab before the graph
 * replaces its nodes.
 */
export function useGraphPointer(deps: GraphPointerDeps) {
  // Double-click (background) → fit view.
  const lastBgClickRef = useRef(0);

  function localPoint(clientX: number, clientY: number) {
    const rect = deps.wrapRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function onPointerDown(e: ReactPointerEvent) {
    deps.resumeRef.current();
    if (e.button !== 0 || deps.dragRef.current.node || deps.dragRef.current.panning) return;
    deps.replayCameraRef.current = false;
    deps.panVelocityRef.current = { x: 0, y: 0, at: 0 };
    const { x, y } = localPoint(e.clientX, e.clientY);
    const n = deps.nodeAtScreen(x, y);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture is best-effort across webviews */
    }
    e.preventDefault();
    if (n) {
      deps.fastDrawUntilRef.current = performance.now() + 500;
      const t = deps.transformRef.current;
      const gx = (x - t.x) / t.k;
      const gy = (y - t.y) / t.k;
      n.fx = n.x;
      n.fy = n.y;
      deps.dragRef.current = { node: n, panning: false, lastX: x, lastY: y, moved: false,
        offsetX: n.x! - gx, offsetY: n.y! - gy };
    } else {
      deps.fastDrawUntilRef.current = performance.now() + 500;
      deps.dragRef.current = { node: null, panning: true, lastX: x, lastY: y, moved: false, lastMoveAt: performance.now() };
    }
  }

  function onPointerMove(e: ReactPointerEvent) {
    deps.resumeRef.current();
    const { x, y } = localPoint(e.clientX, e.clientY);
    deps.pointerRef.current = { x, y, inside: true };
    const d = deps.dragRef.current;
    if (d.node) {
      const t = deps.transformRef.current;
      const gx = (x - t.x) / t.k;
      const gy = (y - t.y) / t.k;
      d.node.fx = gx + (d.offsetX ?? 0);
      d.node.fy = gy + (d.offsetY ?? 0);
      if (Math.abs(x - d.lastX) + Math.abs(y - d.lastY) > 3) {
        const firstMove = !d.moved;
        d.moved = true;
        if (firstMove) {
          const sim = deps.simRef.current;
          // Reheat to a steady drag target so the neighbourhood follows the
          // pointer, as Obsidian does: no velocity cap, no hub boost.
          if (sim) reheatGraphSimulation(sim).alphaTarget(GRAPH_REHEAT_ALPHA);
          deps.startDragPhysics(d.node);
          const startedAt = performance.now();
          deps.dragPerfRef.current = { startedAt, last: startedAt, intervals: [], work: [], draw: [], physics: 0 };
        }
        deps.motionUntilRef.current = performance.now() + 2400;
        deps.fastDrawUntilRef.current = performance.now() + 260;
      }
      const physics = deps.physicsRef.current;
      const physicsIndex = d.moved && physics.active ? physics.index.get(d.node) : undefined;
      if (physicsIndex != null) {
        // The worker trails the pointer by a step; draw the grabbed node at the pointer now.
        d.node.x = d.node.fx;
        d.node.y = d.node.fy;
        deps.postPhysics({ type: "move", session: physics.session, index: physicsIndex, fx: d.node.fx, fy: d.node.fy });
      }
      deps.needsRedrawRef.current = true;
      deps.resumeRef.current();
    } else if (d.panning) {
      const t = deps.transformRef.current;
      const dx = x - d.lastX;
      const dy = y - d.lastY;
      t.x += dx;
      t.y += dy;
      d.lastX = x;
      d.lastY = y;
      d.moved = true;
      // Smoothed pointer velocity, for the coast after release.
      const now = performance.now();
      const dt = Math.max(1, now - (d.lastMoveAt ?? now));
      d.lastMoveAt = now;
      const v = deps.panVelocityRef.current;
      v.x = v.x * 0.8 + (dx / dt) * 0.2;
      v.y = v.y * 0.8 + (dy / dt) * 0.2;
      deps.kickGraph(dx, dy, 0.65);
      deps.motionUntilRef.current = performance.now() + 2400;
      deps.fastDrawUntilRef.current = performance.now() + 260;
      deps.needsRedrawRef.current = true;
      deps.resumeRef.current();
    }
  }

  function endDrag(click: boolean) {
    const d = deps.dragRef.current;
    if (d.node) {
      // a click (no drag) pops the note out into its own window. Tag/phantom
      // nodes have no file to open, so a click on them just releases the drag.
      if (click && !d.moved && !isSyntheticNode(d.node))
        void getStore().openDocWindow(d.node.id);
      d.node.fx = null;
      d.node.fy = null;
      const physics = deps.physicsRef.current;
      const physicsIndex = physics.active ? physics.index.get(d.node) : undefined;
      if (physicsIndex != null) deps.postPhysics({ type: "release", session: physics.session, index: physicsIndex });
      // Let existing energy decay; releasing a hub must not add a kick.
      deps.simRef.current?.alphaTarget(0);
      // Longer, eased motion tail so the post-drag settle reads as living
      // motion, not a hard stop. The draw loop scales ambient amplitude with
      // this tail (lifeBoost), so the graph visibly breathes out.
      deps.motionUntilRef.current = performance.now() + 4600;
      deps.fastDrawUntilRef.current = performance.now() + 220;
      deps.needsRedrawRef.current = true;
      deps.resumeRef.current();
    } else if (d.panning && d.moved) {
      // Coast only when the pointer was still moving at release.
      const now = performance.now();
      const v = deps.panVelocityRef.current;
      if (!click || now - (d.lastMoveAt ?? 0) > 100) v.x = v.y = 0;
      v.at = now;
      deps.needsRedrawRef.current = true;
      deps.resumeRef.current();
    } else if (click && !d.moved && d.panning) {
      // Double-click on empty canvas → re-fit the whole graph (Obsidian-style
      // quick reset after wandering off while panning/zooming).
      const now = performance.now();
      if (now - lastBgClickRef.current < 350) {
        lastBgClickRef.current = 0;
        deps.fitPendingRef.current = true;
        deps.resumeRef.current();
        deps.motionUntilRef.current = now + 1200;
        deps.fastDrawUntilRef.current = now + 300;
        deps.needsRedrawRef.current = true;
        deps.resumeRef.current();
      } else {
        lastBgClickRef.current = now;
      }
    }
    const perf = deps.dragPerfRef.current;
    deps.dragPerfRef.current = null;
    if (perf && perf.work.length > 1) {
      const quantile = (values: number[], q: number) =>
        Math.round([...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)] * 10) / 10;
      const seconds = (performance.now() - perf.startedAt) / 1000;
      markMesaPerf("graph-drag", {
        nodes: deps.forceNodesRef.current.length,
        worker: deps.physicsRef.current.active,
        fps: Math.round((perf.work.length / seconds) * 10) / 10,
        frameGapP90Ms: quantile(perf.intervals.slice(1), 0.9),
        frameWorkP50Ms: quantile(perf.work, 0.5),
        frameWorkP90Ms: quantile(perf.work, 0.9),
        drawP50Ms: perf.draw.length ? quantile(perf.draw, 0.5) : 0,
        physicsPerSec: Math.round((deps.physicsRef.current.active ? perf.physics : perf.work.length) / seconds),
      });
    }
    deps.dragRef.current = { node: null, panning: false, lastX: 0, lastY: 0, moved: false };
  }

  function onPointerUp(e: ReactPointerEvent) {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    endDrag(true);
  }
  function onPointerCancel(e: ReactPointerEvent) {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    deps.pointerRef.current = { ...deps.pointerRef.current, inside: false };
    endDrag(false);
  }
  function onPointerLeave() {
    deps.resumeRef.current();
    deps.pointerRef.current = { ...deps.pointerRef.current, inside: false };
    // Pointer capture keeps a drag alive while the cursor crosses the canvas
    // edge. Do not turn that normal path into an accidental cancellation.
    if (deps.dragRef.current.node || deps.dragRef.current.panning) return;
    endDrag(false);
  }

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave, endDrag };
}
