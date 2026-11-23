const ACTIVE_FRAME_MS = 1000 / 60;
const IDLE_FRAME_MS = 1000 / 30;
// Graphs this large tick slower than a frame, so their drag physics runs in a
// worker and the canvas keeps drawing at display rate.
export const WORKER_DRAG_MIN_NODES = 500;
// Heavy graphs also settle (after open, data changes and retunes) in the
// physics worker: one main-thread tick costs ~100 ms at 10,000 nodes.
export const WORKER_SETTLE_MIN_NODES = 2000;
// The open warm-up of graphs this large runs in the worker, so the app never
// freezes while it lays out (Measured, 42 ticks in Node: 95 ms at 1,000 nodes
// and 8,885 links, 1.2 s at 10,302 nodes and 92,775 links). The pane paints
// the graph only once the warmed layout returns, so it still opens settled.
export const WORKER_WARM_MIN_NODES = 1000;
// Longest main-thread step of a heavy open (build, seeding, setup).
export const HEAVY_STEP_MS = 12;
// At most this many decoded node thumbnails stay cached.
export const THUMB_CACHE_MAX = 192;

export function ambientFrameMs(nodeCount: number, moving: boolean, active: boolean): number {
  if (moving || active) return ACTIVE_FRAME_MS;
  if (nodeCount > 4000) return 1000 / 20;
  return IDLE_FRAME_MS;
}
