import { describe, expect, it } from "vitest";
import { generateSyncKey, validSyncKey } from "./syncKey";

describe("sync key", () => {
  it("creates a distinct 256-bit key using the supplied secure source", () => {
    let next = 0;
    const random = { getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      const bytes = array as Uint8Array;
      for (let i = 0; i < bytes.length; i++) bytes[i] = next++;
      return array;
    } };
    const first = generateSyncKey(random);
    const second = generateSyncKey(random);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(validSyncKey(first)).toBe(true);
    expect(validSyncKey("short-key")).toBe(false);
    expect(validSyncKey("a".repeat(64))).toBe(false);
    expect(validSyncKey("01234567".repeat(8))).toBe(false);
    expect(validSyncKey("70617373776f7264".repeat(4))).toBe(false);
    expect(validSyncKey("A".repeat(64))).toBe(false);
    expect(validSyncKey("g".repeat(64))).toBe(false);
    expect(validSyncKey("a".repeat(63))).toBe(false);
    expect(validSyncKey("a".repeat(65))).toBe(false);
  });
});
