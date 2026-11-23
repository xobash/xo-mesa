import { describe, expect, it } from "vitest";
import { consumeGraphWindowBootstrap, GRAPH_BOOTSTRAP_KEEP_MS, pruneGraphWindowBootstraps, saveGraphWindowBootstrap, type BootstrapStore } from "./graphWindowBootstrap";

function memoryStore(): BootstrapStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    put: async (key, value) => void values.set(key, structuredClone(value)),
    take: async (key) => { const value = values.get(key) ?? null; values.delete(key); return value; },
    remove: async (key) => void values.delete(key),
    keys: async (limit) => [...values.keys()].sort().slice(0, limit),
    removeMany: async (keys) => { for (const key of keys) values.delete(key); },
  };
}

describe("graph window bootstrap", () => {
  it("hands graph metadata to a new window exactly once, without the vault path", async () => {
    const store = memoryStore();
    const snapshot = {
      vaultPath: "/vault",
      vaultName: "Vault",
      files: [{ path: "/vault/A.md", relPath: "A.md", name: "A", ext: "md", isMarkdown: true }],
      notes: { "A.md": { relPath: "A.md", title: "A", rawLinks: [], tags: [], aliases: [] } },
      settings: { graphShowTags: true },
    };
    expect(await saveGraphWindowBootstrap("graph-1", snapshot, store)).toBe(true);
    expect(JSON.stringify(store.values.get("graph-1"))).not.toContain("/vault");
    expect(await consumeGraphWindowBootstrap("graph-1", store, "/vault")).toEqual(snapshot);
    expect(await consumeGraphWindowBootstrap("graph-1", store, "/vault")).toBeNull();
  });

  it("hands over a heavy vault that localStorage could not hold, and reports a failed store", async () => {
    const store = memoryStore();
    const files = Array.from({ length: 10_000 }, (_, i) => ({ path: `/vault/Area/Note ${i}.md`, relPath: `Area/Note ${i}.md`, name: `Note ${i}`, ext: "md", isMarkdown: true }));
    const notes = Object.fromEntries(files.map((f, i) => [f.relPath, { relPath: f.relPath, title: f.name, rawLinks: Array.from({ length: 11 }, (_, k) => `Note ${(i * 7 + k) % 10_000}`), rawReferences: Array.from({ length: 11 }, (_, k) => `Note ${(i * 7 + k) % 10_000}`), tags: [], aliases: [] }]));
    // Over 5 million characters as JSON: past localStorage's quota.
    expect(JSON.stringify({ files, notes }).length).toBeGreaterThan(5_000_000);
    expect(await saveGraphWindowBootstrap("heavy", { vaultPath: "/vault", vaultName: "V", files, notes, settings: {} }, store)).toBe(true);
    expect(Object.keys((await consumeGraphWindowBootstrap("heavy", store, "/vault"))!.notes)).toHaveLength(10_000);
    const failing: BootstrapStore = { put: async () => { throw new Error("quota"); }, take: async () => null, remove: async () => {}, keys: async () => [], removeMany: async () => {} };
    expect(await saveGraphWindowBootstrap("x", { vaultPath: "/vault", vaultName: "V", files: [], notes: {}, settings: {} }, failing)).toBe(false);
  });

  it("removes snapshots no window consumed when main starts, keeping recent ones, in bounded batches", async () => {
    const store = memoryStore();
    const now = Date.UTC(2026, 10, 22, 12);
    const key = (at: number, suffix: string) => `panel-graph-${at.toString(36)}-${suffix}`;
    const snapshot = { vaultPath: "/vault", vaultName: "V", files: [], notes: {}, settings: {} };
    await saveGraphWindowBootstrap(key(now - GRAPH_BOOTSTRAP_KEEP_MS - 1, "old1"), snapshot, store);
    await saveGraphWindowBootstrap(key(now - 86_400_000, "old2"), snapshot, store);
    await saveGraphWindowBootstrap(key(now - 1_000, "fresh"), snapshot, store);
    await saveGraphWindowBootstrap(key(now + 86_400_000, "ahead"), snapshot, store);
    await saveGraphWindowBootstrap("not-a-stamp!", snapshot, store);
    expect(await pruneGraphWindowBootstraps(now, store)).toBe(4);
    expect([...store.values.keys()]).toEqual([key(now - 1_000, "fresh")]);
    // A window still opening can consume its snapshot after the prune.
    expect(await consumeGraphWindowBootstrap(key(now - 1_000, "fresh"), store, "/vault")).not.toBeNull();

    for (let i = 0; i < 300; i++) store.values.set(key(now - 86_400_000 - i, `s${i}`), {});
    expect(await pruneGraphWindowBootstraps(now, store)).toBe(256);
    expect(await pruneGraphWindowBootstraps(now, store)).toBe(44);
    expect(store.values.size).toBe(0);
    const broken: BootstrapStore = { ...store, keys: async () => { throw new Error("unavailable"); } };
    expect(await pruneGraphWindowBootstraps(now, broken)).toBe(0);
  });
});
