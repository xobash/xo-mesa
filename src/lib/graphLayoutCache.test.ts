import { beforeEach, expect, it } from "vitest";
import { cachedGraphLayout, clearGraphLayoutCache, graphLayoutKey, persistedGraphLayout, rememberGraphLayout, setGraphLayoutStore, indexedDbLayoutStore, type LayoutStore } from "./graphLayoutCache";
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
