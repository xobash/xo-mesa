import { expect, it } from "vitest";
import { formatFingerprint, mergeSyncLog, normalizeFingerprint, SYNC_LOG_LIMIT, type SyncLogEntry } from "./syncProtocol";

const entry = (n: number): SyncLogEntry => ({ ts: n, level: "info", msg: `m${n}` });

it("normalizes and formats certificate fingerprints", () => {
  expect(normalizeFingerprint("AB:cd:0F-zz")).toBe("abcd0f");
  expect(normalizeFingerprint(null)).toBe("");
  expect(formatFingerprint("abcdef0123456789aabb")).toBe("AB:CD:EF:01:23:45:67:89");
  expect(formatFingerprint("ab:cd:ef", 2)).toBe("AB:CD");
  expect(formatFingerprint(undefined)).toBe("");
});

it("merges single and batched log entries and keeps the newest within the limit", () => {
  const current = [entry(1)];
  expect(mergeSyncLog(current, [])).toBe(current);
  expect(mergeSyncLog(current, entry(2))).toEqual([entry(1), entry(2)]);
  const fresh = mergeSyncLog([], [entry(1)]);
  expect(fresh).toEqual([entry(1)]);
  expect(mergeSyncLog([entry(1), entry(2)], [entry(3), entry(4)], 3)).toEqual([entry(2), entry(3), entry(4)]);
  const full = Array.from({ length: SYNC_LOG_LIMIT }, (_, i) => entry(i));
  const merged = mergeSyncLog(full, entry(SYNC_LOG_LIMIT));
  expect(merged).toHaveLength(SYNC_LOG_LIMIT);
  expect(merged[0]).toEqual(entry(1));
  expect(merged.at(-1)).toEqual(entry(SYNC_LOG_LIMIT));
});
