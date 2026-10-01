import { describe, expect, it } from "vitest";
import {
  AUTO_SYNC_BUSY_RETRY_MS,
  AUTO_SYNC_MAX_BACKOFF_MS,
  nextAutoSyncDelayMs,
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
