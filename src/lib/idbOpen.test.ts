import { afterEach, describe, expect, it, vi } from "vitest";
import { openIdbWithTimeout } from "./idbOpen";

type FakeRequest = { result: { close: () => void; onversionchange: null | (() => void) }; error: unknown; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; onupgradeneeded?: () => void };

function stubIndexedDb(): FakeRequest {
  const request: FakeRequest = { result: { close: vi.fn(), onversionchange: null }, error: null };
  vi.stubGlobal("indexedDB", { open: () => request });
  return request;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("openIdbWithTimeout", () => {
  it("closes a connection that opens after the time limit", async () => {
    vi.useFakeTimers();
    const request = stubIndexedDb();
    const opening = openIdbWithTimeout("db", 1, () => {}, "Cache");
    vi.advanceTimersByTime(2000);
    await expect(opening).rejects.toThrow("Cache timed out");
    request.onsuccess!();
    expect(request.result.close).toHaveBeenCalledTimes(1);
  });

  it("closes a connection that opens after a block, and yields once", async () => {
    const request = stubIndexedDb();
    const opening = openIdbWithTimeout("db", 1, () => {}, "Cache");
    request.onblocked!();
    await expect(opening).rejects.toThrow("Cache blocked");
    request.onsuccess!();
    expect(request.result.close).toHaveBeenCalledTimes(1);
  });

  it("resolves an open connection that closes when another tab upgrades", async () => {
    const request = stubIndexedDb();
    const opening = openIdbWithTimeout("db", 1, () => {}, "Cache");
    request.onsuccess!();
    const db = await opening;
    expect(request.result.close).not.toHaveBeenCalled();
    (db as unknown as FakeRequest["result"]).onversionchange!();
    expect(request.result.close).toHaveBeenCalledTimes(1);
  });

  it("hands the upgrade its version-change transaction, so it can amend an existing store", async () => {
    const request = stubIndexedDb() as FakeRequest & { transaction: unknown };
    request.transaction = { objectStore: vi.fn() };
    const upgrade = vi.fn();
    const opening = openIdbWithTimeout("db", 2, upgrade, "Cache");
    request.onupgradeneeded!();
    expect(upgrade).toHaveBeenCalledWith(request.result, request.transaction);
    request.onsuccess!();
    await opening;
  });

  it("names the caller's storage when IndexedDB is missing", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(openIdbWithTimeout("db", 1, () => {}, "Revision history")).rejects.toThrow("Revision history unavailable");
  });
});
