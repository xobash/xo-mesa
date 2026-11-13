const ACTIVE_FRAME_MS = 1000 / 60;
const IDLE_FRAME_MS = 1000 / 30;
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
// Graphs this large tick slower than a frame, so their drag physics runs in a
// worker and the canvas keeps drawing at display rate.
export const WORKER_DRAG_MIN_NODES = 500;
// Settling after release runs two ticks per frame below this node count.
export const DOUBLE_TICK_BELOW = 650;
// Heavy graphs also settle (after open, data changes and retunes) in the
// physics worker: one main-thread tick costs ~100 ms at 10,000 nodes.
export const WORKER_SETTLE_MIN_NODES = 2000;
// At most this many decoded node thumbnails stay cached.
export const THUMB_CACHE_MAX = 192;

/** Uniform neighbour velocity cap during a drag — no hub boost. */
export function dragVelocityCap(nodeCount: number): number {
  return nodeCount > 700 ? 4 : nodeCount > 350 ? 5 : 6;
}

export function ambientFrameMs(nodeCount: number, moving: boolean, active: boolean): number {
  if (moving || active) return ACTIVE_FRAME_MS;
  if (nodeCount > 4000) return 1000 / 20;
  return IDLE_FRAME_MS;
}
