/** Lightweight sync event and log contracts. Kept separate from the engine. */
export interface SyncLogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
}

export interface SyncProgress {
  phase: "manifest" | "scan" | "transfer" | "done";
  done: number;
  total: number;
  rel: string;
}

export const SYNC_LOG_EVENT = "sync://log";
export const SYNC_PROGRESS_EVENT = "sync://progress";
export const SYNC_LOG_LIMIT = 1000;

export function normalizeFingerprint(fp?: string | null): string {
  return (fp || "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}
export function formatFingerprint(fp?: string | null, bytes = 8): string {
  const pairs = normalizeFingerprint(fp).match(/.{2}/g);
  return pairs ? pairs.slice(0, bytes).join(":").toUpperCase() : "";
}

export function mergeSyncLog(
  current: SyncLogEntry[],
  incoming: SyncLogEntry | SyncLogEntry[],
  limit = SYNC_LOG_LIMIT,
): SyncLogEntry[] {
  const batch = Array.isArray(incoming) ? incoming : [incoming];
  if (batch.length === 0) return current;
  const merged = current.length === 0 ? batch.slice() : [...current, ...batch];
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}
