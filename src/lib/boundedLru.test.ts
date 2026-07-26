import { describe, expect, it } from "vitest";
import { lruGet, lruSet } from "./boundedLru";

describe("bounded LRU cache", () => {
  it("evicts the least recently used entry at the requested bound", () => {
    const cache = new Map<string, number>();
    lruSet(cache, "a", 1, 3);
    lruSet(cache, "b", 2, 3);
    lruSet(cache, "c", 3, 3);

    expect(lruGet(cache, "a")).toBe(1);
    lruSet(cache, "d", 4, 3);

    expect([...cache.entries()]).toEqual([
      ["c", 3],
      ["a", 1],
      ["d", 4],
    ]);
    expect(cache.has("b")).toBe(false);
  });

  it("promotes replacements and handles zero-sized caches", () => {
    const cache = new Map<string, number>([
      ["a", 1],
      ["b", 2],
    ]);
    lruSet(cache, "a", 3, 2);
    expect([...cache.entries()]).toEqual([
      ["b", 2],
      ["a", 3],
    ]);

    lruSet(cache, "c", 4, 0);
    expect(cache.size).toBe(0);
  });
});
