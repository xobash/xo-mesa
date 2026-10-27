import type { SyncReport } from "./sync";

export const AUTO_SYNC_BUSY_RETRY_MS = 30_000;
export const AUTO_SYNC_MAX_BACKOFF_MS = 30 * 60_000;
const AUTO_SYNC_FAILURE_BACKOFF_MULTIPLIER = 3;
/** setTimeout stores delays as int32; a larger delay fires immediately. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const MAX_AUTO_SYNC_MINUTES = Math.floor(MAX_TIMER_DELAY_MS / 60_000);

/** Off for invalid values; finite whole minutes up to the timer limit otherwise. */
export function normalizeAutoSyncMinutes(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return 0;
  return Math.min(MAX_AUTO_SYNC_MINUTES, Math.floor(value));
}

export function autoSyncBaseDelayMs(minutes: number): number {
  return Math.max(1, normalizeAutoSyncMinutes(minutes)) * 60_000;
}

function hasIncompleteSyncReport(report: SyncReport | null): boolean {
  if (!report) return false;
  return report.cancelled || report.failed.length > 0;
}

export function nextAutoSyncDelayMs(
  baseDelayMs: number,
  report: SyncReport | null,
  syncBusy: boolean
): number {
  const safeBaseDelayMs = Number.isNaN(baseDelayMs)
    ? MAX_TIMER_DELAY_MS
    : Math.min(MAX_TIMER_DELAY_MS, Math.max(1, baseDelayMs));
  if (syncBusy) return Math.min(AUTO_SYNC_BUSY_RETRY_MS, safeBaseDelayMs);
  if (!hasIncompleteSyncReport(report)) return safeBaseDelayMs;
  return Math.min(
    safeBaseDelayMs * AUTO_SYNC_FAILURE_BACKOFF_MULTIPLIER,
    AUTO_SYNC_MAX_BACKOFF_MS
  );
}
