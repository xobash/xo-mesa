import { openIdbWithTimeout } from "./idbOpen";
import { privateImagePath, restoreImagePath } from "./vaultStorage";
import type { NoteMeta, Settings, VaultFile } from "../types";

export interface GraphWindowBootstrap {
  vaultPath: string;
  vaultName: string;
  files: VaultFile[];
  notes: Record<string, NoteMeta>;
  settings: Partial<Settings>;
}

/**
 * Where the main window leaves a graph window's snapshot. IndexedDB, not
 * localStorage: a heavy vault's snapshot is past localStorage's quota, and
 * the window then had nothing to show.
 */
export interface BootstrapStore {
  put(key: string, value: unknown): Promise<void>;
  /** Read and delete in one step, so a snapshot is used at most once. */
  take(key: string): Promise<unknown>;
  remove(key: string): Promise<void>;
  /** At most `limit` stored keys, in key order. */
  keys(limit: number): Promise<string[]>;
  /** Delete these keys in one step. */
  removeMany(keys: readonly string[]): Promise<void>;
}

const DATABASE = "mesa-graph-window";
const STORE = "bootstrap";

function openDatabase(): Promise<IDBDatabase> {
  return openIdbWithTimeout(DATABASE, 1, (db) => {
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
  }, "Graph window storage");
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest | null): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve((request?.result ?? null) as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export const indexedDbBootstrapStore: BootstrapStore = {
  put: (key, value) => transact<void>("readwrite", (store) => store.put(value, key)),
  take: (key) => transact<unknown>("readwrite", (store) => { const read = store.get(key); store.delete(key); return read; }),
  remove: (key) => transact<void>("readwrite", (store) => store.delete(key)),
  keys: async (limit) => ((await transact<IDBValidKey[]>("readonly", (store) => store.getAllKeys(null, limit))) ?? []).filter((key): key is string => typeof key === "string"),
  removeMany: (keys) => transact<void>("readwrite", (store) => { for (const key of keys) store.delete(key); return null; }),
};

/** A snapshot younger than this may belong to a graph window still opening. */
export const GRAPH_BOOTSTRAP_KEEP_MS = 5 * 60_000;
/** Keys inspected per main-window start; later starts prune the rest. */
const PRUNE_KEY_LIMIT = 256;

/** Save time encoded in a key `<label>-<base36 ms>-<suffix>` (workspace.ts
 *  tear-out); null for any other shape. */
function keySavedAt(key: string): number | null {
  const parts = key.split("-");
  const stamp = parts.length >= 3 ? parts[parts.length - 2] : "";
  if (!/^[0-9a-z]{1,11}$/.test(stamp)) return null;
  const savedAt = parseInt(stamp, 36);
  return Number.isSafeInteger(savedAt) ? savedAt : null;
}

/**
 * Remove snapshots no graph window consumed (the window failed, or the app
 * quit before the timed discard ran). Keeps snapshots saved within
 * `GRAPH_BOOTSTRAP_KEEP_MS` of `now`; unreadable keys and keys from a clock
 * far ahead are stale. Returns the number removed; storage failure removes none.
 */
export async function pruneGraphWindowBootstraps(
  now: number = Date.now(),
  store: BootstrapStore = indexedDbBootstrapStore
): Promise<number> {
  try {
    const stale = (await store.keys(PRUNE_KEY_LIMIT)).filter((key) => {
      const savedAt = keySavedAt(key);
      return savedAt === null || Math.abs(now - savedAt) > GRAPH_BOOTSTRAP_KEEP_MS;
    });
    if (stale.length > 0) await store.removeMany(stale);
    return stale.length;
  } catch {
    return 0;
  }
}

/** Store a snapshot without the vault's absolute path; true when the window can use it. */
export async function saveGraphWindowBootstrap(
  id: string,
  snapshot: GraphWindowBootstrap,
  store: BootstrapStore = indexedDbBootstrapStore
): Promise<boolean> {
  try {
    await store.put(id, {
      ...snapshot,
      vaultPath: "",
      files: snapshot.files.map((file) => ({ ...file, path: file.relPath })),
      notes: Object.fromEntries(Object.entries(snapshot.notes).map(([rel, note]) => [rel, { ...note, firstImagePath: privateImagePath(note.firstImagePath, snapshot.vaultPath) }])),
    });
    return true;
  } catch {
    return false;
  }
}

export async function consumeGraphWindowBootstrap(
  id: string,
  store: BootstrapStore = indexedDbBootstrapStore,
  root?: string
): Promise<GraphWindowBootstrap | null> {
  try {
    const value = (await store.take(id)) as GraphWindowBootstrap | null;
    if (!value || !root || !Array.isArray(value.files) || !value.notes) return null;
    const base = root.replace(/\/$/, "");
    return {
      ...value,
      vaultPath: root,
      files: value.files.map((file) => ({ ...file, path: base + "/" + file.relPath })),
      notes: Object.fromEntries(Object.entries(value.notes).map(([rel, note]) => [rel, { ...note, firstImagePath: restoreImagePath(note.firstImagePath, root) }])),
    };
  } catch {
    return null;
  }
}

export async function discardGraphWindowBootstrap(id: string, store: BootstrapStore = indexedDbBootstrapStore): Promise<void> {
  try { await store.remove(id); } catch { /* unavailable storage holds nothing to discard */ }
}
