import { describe, expect, it } from "vitest";
import {
  AUTO_SYNC_BUSY_RETRY_MS,
  AUTO_SYNC_MAX_BACKOFF_MS,
  MAX_AUTO_SYNC_MINUTES,
  MAX_TIMER_DELAY_MS,
  autoSyncBaseDelayMs,
  nextAutoSyncDelayMs,
  normalizeAutoSyncMinutes,
} from "./syncAutoSchedule";
import type { SyncReport } from "./sync";

function report(overrides: Partial<SyncReport> = {}): SyncReport {
  return {
    fingerprint: "fp",
    pulled: 0,
    pushed: 0,
    conflicts: 0,
    upToDate: 0,
    failed: [],
    bytesPulled: 0,
    bytesPushed: 0,
    totalLocal: 0,
    totalRemote: 0,
    durationMs: 0,
    cancelled: false,
    ...overrides,
  };
}

describe("nextAutoSyncDelayMs", () => {
  it("keeps the configured cadence after a complete run", () => {
    expect(nextAutoSyncDelayMs(60_000, report(), false)).toBe(60_000);
  });

  it("backs off after cancelled or partially failed syncs", () => {
    expect(nextAutoSyncDelayMs(60_000, report({ cancelled: true }), false)).toBe(
      180_000
    );
    expect(
      nextAutoSyncDelayMs(
        60_000,
        report({ failed: [{ rel: "Note.md", op: "pull", error: "locked" }] }),
        false
      )
    ).toBe(180_000);
  });

  it("caps failure backoff and retries busy stores quickly", () => {
    expect(
      nextAutoSyncDelayMs(
        20 * 60_000,
        report({ failed: [{ rel: "Note.md", op: "push", error: "offline" }] }),
        false
      )
    ).toBe(AUTO_SYNC_MAX_BACKOFF_MS);
    expect(nextAutoSyncDelayMs(60_000, report(), true)).toBe(
      AUTO_SYNC_BUSY_RETRY_MS
    );
    expect(nextAutoSyncDelayMs(10_000, report(), true)).toBe(10_000);
  });
});

describe("auto-sync timer limit", () => {
  it("never schedules a delay that setTimeout would overflow to an immediate fire", () => {
    const monthly = autoSyncBaseDelayMs(43_200);
    expect(monthly).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
    expect(autoSyncBaseDelayMs(Infinity)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
    expect(nextAutoSyncDelayMs(43_200 * 60_000, null, false)).toBe(MAX_TIMER_DELAY_MS);
    expect(nextAutoSyncDelayMs(Infinity, null, false)).toBe(MAX_TIMER_DELAY_MS);
    expect(nextAutoSyncDelayMs(NaN, null, false)).toBe(MAX_TIMER_DELAY_MS);
  });

  it("clamps the saved interval to finite whole minutes", () => {
    expect(normalizeAutoSyncMinutes(1e309)).toBe(MAX_AUTO_SYNC_MINUTES);
    expect(normalizeAutoSyncMinutes(43_200)).toBe(MAX_AUTO_SYNC_MINUTES);
    expect(normalizeAutoSyncMinutes(15.7)).toBe(15);
    expect(normalizeAutoSyncMinutes(-3)).toBe(0);
    expect(normalizeAutoSyncMinutes(NaN)).toBe(0);
    expect(normalizeAutoSyncMinutes("15")).toBe(0);
  });
});
