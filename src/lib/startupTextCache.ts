/** In-flight per-file reads on the per-file path. Large enough to keep local
 * storage busy, small enough to bound decoded response buffers and IPC
 * bookkeeping during vault open. */
export const STARTUP_TEXT_READ_CONCURRENCY = 16;
