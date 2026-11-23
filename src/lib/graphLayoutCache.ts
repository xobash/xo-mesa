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
 */

const MAX_ENTRIES = 4;
const DATABASE = "mesa-graph-layout";
const STORE = "layouts";
const cache = new Map<string, Float64Array>();

type KeyNode = { id: string };
type KeyLink = { source: string | KeyNode; target: string | KeyNode };

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
  const forces = [settings.center, settings.repel, settings.linkForce, settings.linkDistance].join(",");
  return `${nodes.length}:${links.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}:${forces}`;
}

/** x, y, vx, vy per node, or null. A hit refreshes its recency. */
export function cachedGraphLayout(key: string, count: number): Float64Array | null {
  const state = cache.get(key);
  if (!state || state.length !== count * 4) return null;
  cache.delete(key);
  cache.set(key, state);
  return state;
}

export function rememberGraphLayout(key: string, nodes: readonly { x?: number; y?: number; vx?: number; vy?: number }[]): void {
  const state = new Float64Array(nodes.length * 4);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    state[i * 4] = n.x ?? NaN; state[i * 4 + 1] = n.y ?? NaN; state[i * 4 + 2] = n.vx ?? 0; state[i * 4 + 3] = n.vy ?? 0;
  }
  keep(key, state);
  void persistent.put(key, state).catch(() => { /* a disposable cache */ });
}

/** Insert as most recent; oldest first in insertion order, at most MAX_ENTRIES remain. */
function keep(key: string, state: Float64Array): void {
  cache.delete(key);
  cache.set(key, state);
  for (const old of cache.keys()) {
    if (cache.size <= MAX_ENTRIES) break;
    cache.delete(old);
  }
}

/** A persistent layout store; IndexedDB in the app. */
export interface LayoutStore {
  get(key: string): Promise<Float64Array | null>;
  put(key: string, state: Float64Array): Promise<void>;
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
  async put(key, state) {
    const db = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        store.put({ key, state, savedAt: Date.now() });
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
    keep(key, state);
    return state;
  } catch {
    return null;
  }
}

/** Test-only reset. */
export function clearGraphLayoutCache(): void {
  cache.clear();
}
