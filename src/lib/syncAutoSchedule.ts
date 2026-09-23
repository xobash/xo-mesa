import type { SyncReport } from "./sync";

export const AUTO_SYNC_BUSY_RETRY_MS = 30_000;
export const AUTO_SYNC_MAX_BACKOFF_MS = 30 * 60_000;
export const AUTO_SYNC_FAILURE_BACKOFF_MULTIPLIER = 3;

export function hasIncompleteSyncReport(report: SyncReport | null): boolean {
  if (!report) return false;
  return report.cancelled || report.failed.length > 0;
}

export function nextAutoSyncDelayMs(
  baseDelayMs: number,
  report: SyncReport | null,
  syncBusy: boolean
): number {
  const safeBaseDelayMs = Math.max(1, baseDelayMs);
  if (syncBusy) return Math.min(AUTO_SYNC_BUSY_RETRY_MS, safeBaseDelayMs);
  if (!hasIncompleteSyncReport(report)) return safeBaseDelayMs;
  return Math.min(
    safeBaseDelayMs * AUTO_SYNC_FAILURE_BACKOFF_MULTIPLIER,
    AUTO_SYNC_MAX_BACKOFF_MS
  );
}
