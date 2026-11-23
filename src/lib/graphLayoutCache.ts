import type { GraphForceSettings } from "./graphForceDefaults";
import { openIdbWithTimeout } from "./idbOpen";

/**
 * Warmed open layouts, keyed by everything the open warm-up reads: node ids in
 * order, links in order and the force settings. Seeding and the warm-up are
 * deterministic, so a cached layout equals the one a new warm-up would make;
 * reopening the same graph skips the warm-up. Layouts also persist in
 * IndexedDB as a disposable
 * cache: positions keyed by hashes and counts, never names or paths, so an
 * app restart or a torn-out window shows a known graph at once.
 *
 * After a small change (at least `REUSE_SHARE` of the nodes shared both ways,
 * same forces) the last layout is reused instead: kept nodes start where they
 * were, matched by two 32-bit hashes of each node id (never the id itself).
 */

const MAX_ENTRIES = 4;
/** Share of nodes both graphs must have in common for a layout to be reused. */
const REUSE_SHARE = 0.9;
const DATABASE = "mesa-graph-layout";
const STORE = "layouts";

/** x, y, vx, vy per node; `ids` two hashes per node id when the nodes had ids. */
interface CachedLayout { state: Float64Array; ids?: Uint32Array }
const cache = new Map<string, CachedLayout>();

type KeyNode = { id: string };
type KeyLink = { source: string | KeyNode; target: string | KeyNode };

/** The force-settings part of a layout key. */
function forcesPart(settings: GraphForceSettings): string {
  return [settings.center, settings.repel, settings.linkForce, settings.linkDistance].join(",");
}

/** Two independent 32-bit FNV-1a hashes plus the counts, as one key. */
export function graphLayoutKey(nodes: readonly KeyNode[], links: readonly KeyLink[], settings: GraphForceSettings): string {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  const mix = (code: number) => {
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b ^ code, 2246822519) ^ (b >>> 13);
  };
  const index = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    const id = nodes[i].id;
    index.set(id, i);
    for (let k = 0; k < id.length; k++) mix(id.charCodeAt(k));
    mix(0x1f);
  }
  for (const link of links) {
    const s = typeof link.source === "string" ? link.source : link.source.id;
    const t = typeof link.target === "string" ? link.target : link.target.id;
    const si = index.get(s) ?? -1, ti = index.get(t) ?? -1;
    mix(si & 0xffff); mix(si >>> 16); mix(ti & 0xffff); mix(ti >>> 16);
  }
  return `${nodes.length}:${links.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}:${forcesPart(settings)}`;
}

/** The forces part of a key made by `graphLayoutKey`. */
function keyForces(key: string): string {
  return key.split(":").slice(4).join(":");
}

/** Two independent 32-bit hashes of each node id, in node order. */
function nodeIdHashes(nodes: readonly KeyNode[]): Uint32Array {
  const out = new Uint32Array(nodes.length * 2);
  for (let i = 0; i < nodes.length; i++) {
    const id = nodes[i].id;
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let k = 0; k < id.length; k++) {
      const code = id.charCodeAt(k);
      a = Math.imul(a ^ code, 16777619);
      b = Math.imul(b ^ code, 2246822519) ^ (b >>> 13);
    }
    out[i * 2] = a >>> 0; out[i * 2 + 1] = b >>> 0;
  }
  return out;
}

/** One number per id hash pair (32 + 21 bits, exact in a double). */
function hashKey(ids: Uint32Array, i: number): number {
  return ids[i * 2] * 2097152 + (ids[i * 2 + 1] >>> 11);
}

/** Kept positions for `nodes` (x, y per node, NaN for new ones) and how many were kept. */
export interface ReusableLayout { positions: Float64Array; kept: number }

/** Match `nodes` against one cached layout; null unless both sides share `REUSE_SHARE`. */
function matchLayout(wanted: Uint32Array, entry: CachedLayout): ReusableLayout | null {
  const { state, ids } = entry;
  const count = state.length / 4, size = wanted.length / 2;
  if (!ids || ids.length !== count * 2 || count === 0 || size === 0) return null;
  // A hash seen twice is ambiguous and never reused.
  const byHash = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const h = hashKey(ids, i);
    byHash.set(h, byHash.has(h) ? -1 : i);
  }
  const positions = new Float64Array(size * 2).fill(NaN);
  let kept = 0;
  for (let i = 0; i < size; i++) {
    const at = byHash.get(hashKey(wanted, i)) ?? -1;
    if (at < 0) continue;
    const x = state[at * 4], y = state[at * 4 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    positions[i * 2] = x; positions[i * 2 + 1] = y;
    kept++;
  }
  return kept >= REUSE_SHARE * size && kept >= REUSE_SHARE * count ? { positions, kept } : null;
}

/** A layout of this window, newest first, that a slightly changed graph can start from; or null. */
export function reusableGraphLayout(nodes: readonly KeyNode[], settings: GraphForceSettings): ReusableLayout | null {
  const forces = forcesPart(settings), wanted = nodeIdHashes(nodes);
  for (const [key, entry] of [...cache].reverse()) {
    if (keyForces(key) !== forces) continue;
    const found = matchLayout(wanted, entry);
    if (found) return found;
  }
  return null;
}

/** `reusableGraphLayout` over layouts saved by this or an earlier session. Never throws. */
export async function persistedReusableLayout(nodes: readonly KeyNode[], settings: GraphForceSettings): Promise<ReusableLayout | null> {
  try {
    const forces = forcesPart(settings), wanted = nodeIdHashes(nodes);
    for (const { key, state, ids } of (await persistent.recent?.()) ?? []) {
      if (keyForces(key) !== forces) continue;
      const found = matchLayout(wanted, { state, ids });
      if (found) return found;
    }
    return null;
  } catch {
    return null;
  }
}

/** x, y, vx, vy per node, or null. A hit refreshes its recency. */
export function cachedGraphLayout(key: string, count: number): Float64Array | null {
  const entry = cache.get(key);
  if (!entry || entry.state.length !== count * 4) return null;
  cache.delete(key);
  cache.set(key, entry);
  return entry.state;
}

export function rememberGraphLayout(key: string, nodes: readonly { id?: string; x?: number; y?: number; vx?: number; vy?: number }[]): void {
  const state = new Float64Array(nodes.length * 4);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    state[i * 4] = n.x ?? NaN; state[i * 4 + 1] = n.y ?? NaN; state[i * 4 + 2] = n.vx ?? 0; state[i * 4 + 3] = n.vy ?? 0;
  }
  const ids = nodes.every((n) => typeof n.id === "string") ? nodeIdHashes(nodes as readonly KeyNode[]) : undefined;
  keep(key, { state, ids });
  void persistent.put(key, state, ids).catch(() => { /* a disposable cache */ });
}

/** Insert as most recent; oldest first in insertion order, at most MAX_ENTRIES remain. */
function keep(key: string, entry: CachedLayout): void {
  cache.delete(key);
  cache.set(key, entry);
  for (const old of cache.keys()) {
    if (cache.size <= MAX_ENTRIES) break;
    cache.delete(old);
  }
}

/** A persistent layout store; IndexedDB in the app. */
export interface LayoutStore {
  get(key: string): Promise<Float64Array | null>;
  put(key: string, state: Float64Array, ids?: Uint32Array): Promise<void>;
  /** Saved layouts, newest first, for reuse after a small change. */
  recent?(): Promise<{ key: string; state: Float64Array; ids?: Uint32Array }[]>;
}

function openDatabase(): Promise<IDBDatabase> {
  return openIdbWithTimeout(DATABASE, 1, (db) => {
    const store = db.createObjectStore(STORE, { keyPath: "key" });
    store.createIndex("savedAt", "savedAt");
  }, "Graph layout storage");
}

export const indexedDbLayoutStore: LayoutStore = {
  async get(key) {
    const db = await openDatabase();
    try {
      return await new Promise<Float64Array | null>((resolve, reject) => {
        const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
        request.onsuccess = () => resolve((request.result as { state?: Float64Array } | undefined)?.state ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  },
  async recent() {
    const db = await openDatabase();
    try {
      return await new Promise<{ key: string; state: Float64Array; ids?: Uint32Array }[]>((resolve, reject) => {
        const request = db.transaction(STORE, "readonly").objectStore(STORE).index("savedAt").getAll();
        request.onsuccess = () => resolve((request.result as { key: string; state: Float64Array; ids?: Uint32Array }[]).reverse());
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  },
  async put(key, state, ids) {
    const db = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        store.put({ key, state, ids, savedAt: Date.now() });
        // Keep the newest MAX_ENTRIES layouts; older ones are disposable.
        const all = store.index("savedAt").getAllKeys();
        all.onsuccess = () => {
          const keys = all.result as IDBValidKey[];
          for (let i = 0; i < keys.length - MAX_ENTRIES; i++) store.delete(keys[i]);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
};

let persistent: LayoutStore = indexedDbLayoutStore;

/** Test seam: the store behind `persistedGraphLayout` and `rememberGraphLayout`. */
export function setGraphLayoutStore(store: LayoutStore): void {
  persistent = store;
}

/** A layout saved by this or an earlier session, or null. Never throws. */
export async function persistedGraphLayout(key: string, count: number): Promise<Float64Array | null> {
  try {
    const state = await persistent.get(key);
    if (!state || state.length !== count * 4) return null;
    keep(key, { state });
    return state;
  } catch {
    return null;
  }
}

/** Test-only reset. */
export function clearGraphLayoutCache(): void {
  cache.clear();
}
