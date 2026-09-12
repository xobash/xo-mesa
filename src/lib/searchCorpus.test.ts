import { describe, expect, it } from "vitest";
import {
  SEARCH_CORPUS_BATCH,
  TEXT_CACHE_BUDGET_CHARS,
  mergeAbsentText,
  selectTextWithinBudget,
  streamTextBatches,
} from "./searchCorpus";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mergeAbsentText", () => {
  it("adds text for keys the cache does not have", () => {
    const cache = { "a.md": "A" };
    const next = mergeAbsentText(cache, new Map([["b.txt", "B"]]));
    expect(next).toEqual({ "a.md": "A", "b.txt": "B" });
    expect(cache).toEqual({ "a.md": "A" }); // caller's object untouched
  });

  it("never overwrites text the cache already holds", () => {
    // The live value can be an editor edit, a watcher refresh or an agent
    // write — all newer than the bytes this batch read.
    const cache = { "note.txt": "edited while indexing" };
    const next = mergeAbsentText(cache, new Map([["note.txt", "stale from disk"]]));
    expect(next["note.txt"]).toBe("edited while indexing");
  });

  it("treats an empty cached string as present, not as missing", () => {
    const cache = { "cleared.txt": "" };
    const next = mergeAbsentText(cache, new Map([["cleared.txt", "old body"]]));
    expect(next["cleared.txt"]).toBe("");
  });

  it("returns the same object when nothing was added", () => {
    // A changed identity makes search throw away its incremental narrowing.
    const cache = { "a.md": "A" };
    expect(mergeAbsentText(cache, new Map())).toBe(cache);
    expect(mergeAbsentText(cache, new Map([["a.md", "other"]]))).toBe(cache);
  });

  it("merges a partially-new batch in one copy", () => {
    const cache = { keep: "kept" };
    const next = mergeAbsentText(
      cache,
      new Map([
        ["keep", "ignored"],
        ["add", "added"],
      ])
    );
    expect(next).not.toBe(cache);
    expect(next).toEqual({ keep: "kept", add: "added" });
  });

  it("batches in chunks that are neither per-file nor unbounded", () => {
    expect(SEARCH_CORPUS_BATCH).toBeGreaterThan(1);
    expect(SEARCH_CORPUS_BATCH).toBeLessThanOrEqual(512);
  });
});

describe("selectTextWithinBudget", () => {
  it("skips an oversized file without stopping smaller later files", () => {
    const batch = new Map([
      ["huge.log", "x".repeat(20)],
      ["small.log", "ok"],
    ]);
    const selected = selectTextWithinBudget(batch, 0, 10);
    expect([...selected.accepted.keys()]).toEqual(["small.log"]);
    expect(selected.usedChars).toBe(2);
    expect(selected.skipped).toBe(1);
  });

  it("never admits text after the hard character budget is full", () => {
    const selected = selectTextWithinBudget(
      new Map([["later.txt", "x"]]),
      TEXT_CACHE_BUDGET_CHARS,
      TEXT_CACHE_BUDGET_CHARS
    );
    expect(selected.accepted.size).toBe(0);
    expect(selected.skipped).toBe(1);
    expect(selected.usedChars).toBe(TEXT_CACHE_BUDGET_CHARS);
  });
});

describe("streamTextBatches", () => {
  const collect = async (
    items: readonly string[],
    read: (item: string) => Promise<string>,
    opts: Partial<Parameters<typeof streamTextBatches>[3]> = {}
  ) => {
    const seen = new Map<string, string>();
    const batches: number[] = [];
    await streamTextBatches(items, (k) => k, read, {
      concurrency: 8,
      batchSize: 4,
      commit: (b) => {
        batches.push(b.size);
        b.forEach((v, k) => {
          if (seen.has(k)) throw new Error(`duplicate commit for ${k}`);
          seen.set(k, v);
        });
      },
      ...opts,
    });
    return { seen, batches };
  };

  it("delivers every item exactly once even when reads finish out of order", async () => {
    // The regression this pins: buffering with `batch.set(k, await read(x))`
    // binds the Map BEFORE suspending, so a worker resuming after a flush
    // writes into the discarded buffer. Staggered latencies make several
    // workers resume across flush boundaries.
    const items = Array.from({ length: 60 }, (_, i) => `f${i}`);
    const { seen } = await collect(items, async (k) => {
      await delay(Number(k.slice(1)) % 7);
      return `text:${k}`;
    });
    expect(seen.size).toBe(items.length);
    for (const k of items) expect(seen.get(k)).toBe(`text:${k}`);
  });

  it("commits in batches rather than per item", async () => {
    const items = Array.from({ length: 10 }, (_, i) => `f${i}`);
    const { batches, seen } = await collect(items, async (k) => k);
    expect(seen.size).toBe(10);
    expect(batches.length).toBeLessThan(10);
    expect(Math.max(...batches)).toBeLessThanOrEqual(4);
  });

  it("skips an unreadable item instead of aborting the rest", async () => {
    const items = ["ok1", "boom", "ok2"];
    const errors: string[] = [];
    const { seen } = await collect(
      items,
      async (k) => {
        if (k === "boom") throw new Error("EACCES");
        return k;
      },
      { onError: (item) => errors.push(item as string) }
    );
    expect([...seen.keys()]).toEqual(["ok1", "ok2"]);
    expect(errors).toEqual(["boom"]);
  });

  it("skips null results from a chunk read instead of caching empty text", async () => {
    const items = ["ok1", "huge", "ok2"];
    const errors: string[] = [];
    const { seen } = await collect(
      items,
      async (k) => k,
      {
        readChunk: async (group) =>
          group.map((item) => (item === "huge" ? null : `text:${item}`)),
        chunkSize: 3,
        onError: (item) => errors.push(item as string),
      }
    );
    expect([...seen.entries()]).toEqual([
      ["ok1", "text:ok1"],
      ["ok2", "text:ok2"],
    ]);
    expect(errors).toEqual(["huge"]);
  });

  it("stops reading once the caller reports it is stale", async () => {
    const items = Array.from({ length: 40 }, (_, i) => `f${i}`);
    let reads = 0;
    let stale = false;
    const { seen } = await collect(
      items,
      async (k) => {
        reads++;
        if (reads >= 8) stale = true;
        return k;
      },
      { stopped: () => stale }
    );
    expect(reads).toBeLessThan(items.length);
    expect(seen.size).toBeLessThan(items.length);
  });

  it("does nothing for an empty list", async () => {
    const { seen, batches } = await collect([], async (k) => k);
    expect(seen.size).toBe(0);
    expect(batches).toEqual([]);
  });
});
