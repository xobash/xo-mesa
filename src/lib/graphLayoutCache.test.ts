import { beforeEach, describe, expect, it } from "vitest";
import { cachedGraphLayout, clearGraphLayoutCache, graphLayoutKey, persistedGraphLayout, persistedReusableLayout, rememberGraphLayout, reusableGraphLayout, setGraphLayoutStore, indexedDbLayoutStore, type LayoutStore } from "./graphLayoutCache";
import { GRAPH_FORCE_DEFAULTS } from "./graphForceDefaults";

const nodes = [{ id: "A" }, { id: "B" }, { id: "C" }];
const links = [{ source: "A", target: "B" }, { source: "B", target: "C" }];
beforeEach(() => { clearGraphLayoutCache(); setGraphLayoutStore(indexedDbLayoutStore); });

it("keys on node order, links, endpoint form and force settings", () => {
  const key = graphLayoutKey(nodes, links, GRAPH_FORCE_DEFAULTS);
  // Link endpoints resolved to node objects key the same as id strings.
  expect(graphLayoutKey(nodes, links.map((l) => ({ source: nodes.find((n) => n.id === l.source)!, target: nodes.find((n) => n.id === l.target)! })), GRAPH_FORCE_DEFAULTS)).toBe(key);
  expect(graphLayoutKey([nodes[1], nodes[0], nodes[2]], links, GRAPH_FORCE_DEFAULTS)).not.toBe(key);
  expect(graphLayoutKey(nodes, [links[1], links[0]], GRAPH_FORCE_DEFAULTS)).not.toBe(key);
  expect(graphLayoutKey(nodes, [{ source: "A", target: "C" }, links[1]], GRAPH_FORCE_DEFAULTS)).not.toBe(key);
  expect(graphLayoutKey(nodes, links, { ...GRAPH_FORCE_DEFAULTS, repel: GRAPH_FORCE_DEFAULTS.repel + 1 })).not.toBe(key);
  expect(graphLayoutKey([{ id: "AB" }, { id: "" }, { id: "C" }], links, GRAPH_FORCE_DEFAULTS)).not.toBe(graphLayoutKey([{ id: "A" }, { id: "B" }, { id: "C" }], links, GRAPH_FORCE_DEFAULTS));
});

it("returns a remembered layout for the same node count and keeps the four most recent", () => {
  rememberGraphLayout("k0", [{ x: 1, y: 2, vx: 3, vy: 4 }]);
  expect([...cachedGraphLayout("k0", 1)!]).toEqual([1, 2, 3, 4]);
  expect(cachedGraphLayout("k0", 2)).toBeNull();
  for (let i = 1; i <= 4; i++) rememberGraphLayout(`k${i}`, [{ x: i, y: i }]);
  expect(cachedGraphLayout("k0", 1)).toBeNull();
  expect(cachedGraphLayout("k4", 1)).not.toBeNull();
});

it("persists remembered layouts and serves them to a later session of the same graph", async () => {
  const saved = new Map<string, Float64Array>();
  const store: LayoutStore = { get: async (key) => saved.get(key) ?? null, put: async (key, state) => void saved.set(key, state) };
  setGraphLayoutStore(store);
  rememberGraphLayout("graph", [{ x: 5, y: 6, vx: 0, vy: 0 }]);
  await Promise.resolve();
  clearGraphLayoutCache();
  expect(cachedGraphLayout("graph", 1)).toBeNull();
  expect([...(await persistedGraphLayout("graph", 1))!]).toEqual([5, 6, 0, 0]);
  expect(cachedGraphLayout("graph", 1)).not.toBeNull();
  expect(await persistedGraphLayout("graph", 2)).toBeNull();
  setGraphLayoutStore({ get: async () => { throw new Error("blocked"); }, put: async () => { throw new Error("quota"); } });
  expect(await persistedGraphLayout("other", 1)).toBeNull();
  rememberGraphLayout("other", [{ x: 1, y: 1 }]);
});

it("keeps the memory cache at four layouts when layouts come back from storage", async () => {
  setGraphLayoutStore({ get: async () => new Float64Array([1, 2, 0, 0]), put: async () => {} });
  for (let i = 0; i < 5; i++) await persistedGraphLayout(`p${i}`, 1);
  expect(cachedGraphLayout("p0", 1)).toBeNull();
  for (let i = 1; i < 5; i++) expect(cachedGraphLayout(`p${i}`, 1)).not.toBeNull();
});

describe("reuse after a small change", () => {
  const graph = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `note ${i}`, x: i * 10, y: -i, vx: 1, vy: 1 }));
  const forces = (nodes: readonly { id: string }[]) => graphLayoutKey(nodes, [], GRAPH_FORCE_DEFAULTS);

  it("places kept nodes where they were, leaves new ones unplaced, and refuses a large change or other forces", () => {
    const before = graph(100);
    rememberGraphLayout(forces(before), before);
    const after = [...graph(100).slice(5), { id: "new note" }];
    const reuse = reusableGraphLayout(after, GRAPH_FORCE_DEFAULTS)!;
    expect(reuse.kept).toBe(95);
    expect([reuse.positions[0], reuse.positions[1]]).toEqual([50, -5]);
    expect(reuse.positions[95 * 2]).toBeNaN();
    // Under 90% of either side shared: lay out afresh.
    expect(reusableGraphLayout(graph(100).slice(20), GRAPH_FORCE_DEFAULTS)).toBeNull();
    expect(reusableGraphLayout([...graph(100), ...graph(20).map((n) => ({ id: "x" + n.id }))], GRAPH_FORCE_DEFAULTS)).toBeNull();
    expect(reusableGraphLayout(after, { ...GRAPH_FORCE_DEFAULTS, repel: GRAPH_FORCE_DEFAULTS.repel + 1 })).toBeNull();
  });

  it("finds a changed graph's layout saved by an earlier session, by node id hashes only", async () => {
    const saved = new Map<string, { state: Float64Array; ids?: Uint32Array }>();
    setGraphLayoutStore({
      get: async (key) => saved.get(key)?.state ?? null,
      put: async (key, state, ids) => void saved.set(key, { state, ids }),
      recent: async () => [...saved].map(([key, entry]) => ({ key, ...entry })),
    });
    const before = graph(50);
    rememberGraphLayout(forces(before), before);
    await Promise.resolve();
    expect(JSON.stringify([...saved.values()][0])).not.toContain("note");
    clearGraphLayoutCache();
    const after = [...graph(50), { id: "new note" }];
    expect(reusableGraphLayout(after, GRAPH_FORCE_DEFAULTS)).toBeNull();
    const reuse = (await persistedReusableLayout(after, GRAPH_FORCE_DEFAULTS))!;
    expect(reuse.kept).toBe(50);
    expect([reuse.positions[98], reuse.positions[99]]).toEqual([490, -49]);
    setGraphLayoutStore({ get: async () => null, put: async () => {}, recent: async () => { throw new Error("blocked"); } });
    expect(await persistedReusableLayout(after, GRAPH_FORCE_DEFAULTS)).toBeNull();
  });
});
