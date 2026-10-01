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
  });
});
