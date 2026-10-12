import { vaultStorageId } from "./vaultStorage";

export interface TextRevision {
  id: string;
  root: string;
  relPath: string;
  savedAt: number;
  content: string;
  /** Serialized order for equal-millisecond saves; assigned inside IndexedDB. */
  order?: number;
  source?: RevisionSource;
}

const STORAGE_KEY = "mesa:textRevisionHistory:v1";
const DATABASE_NAME = "mesa-text-revision-history";
const DATABASE_VERSION = 1;
const DATABASE_STORE = "revisions";
export type RevisionSource = "autosave" | "external" | "restore";
const MAX_PER_FILE = 20;
const MAX_REVISION_CHARS = 1_000_000;
const MAX_FILES = 500;
const REVISION_COALESCE_MS = 60_000;
const MAX_TOTAL_CHARS = 2_000_000;

function isTextRevision(entry: unknown): entry is TextRevision {
  return typeof (entry as TextRevision | null)?.id === "string" &&
    typeof (entry as TextRevision | null)?.root === "string" &&
    typeof (entry as TextRevision | null)?.relPath === "string" &&
    typeof (entry as TextRevision | null)?.savedAt === "number" &&
    typeof (entry as TextRevision | null)?.content === "string" &&
    (typeof (entry as TextRevision | null)?.order === "undefined" ||
      (Number.isSafeInteger((entry as TextRevision).order) && (entry as TextRevision).order! >= 0));
}

function readAll(): TextRevision[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTextRevision);
  } catch {
    return [];
  }
}

function writeAll(entries: TextRevision[]): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    // Revision history is a convenience copy, never part of the verified vault
    // transaction. Quota/private-mode failures must not retroactively turn a
    // byte-verified disk save into a failed save state.
    return false;
  }
}

let fallbackSequence = 0;

function nextOrder(entries: readonly TextRevision[]): number {
  const highest = entries.reduce((value, entry) => Math.max(value, entry.order ?? 0), fallbackSequence);
  fallbackSequence = highest + 1;
  return fallbackSequence;
}

function revisionId(now: number): string {
  // UUIDs identify records across windows; the transaction assigns their order.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${now}-${crypto.randomUUID()}`;
  }
  const bytes = new Uint32Array(4);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
    return `${now}-${[...bytes].map((value) => value.toString(16)).join("")}`;
  }
  fallbackSequence += 1;
  return `${now}-${Math.random().toString(36).slice(2)}-${fallbackSequence}`;
}

function trim(entries: TextRevision[]): TextRevision[] {
  const newest = [...entries].sort(compareNewestFirst);
  const perFile = new Map<string, number>();
  const kept = new Set<TextRevision>();
  const key = (entry: TextRevision) => `${entry.root}\0${entry.relPath}`;
  let chars = 0;
  // Protect one copy for each of the 500 most recently revised files.
  for (const entry of newest) {
    if (perFile.has(key(entry)) || entry.content.length > MAX_REVISION_CHARS) continue;
    if (perFile.size >= MAX_FILES) break;
    kept.add(entry);
    perFile.set(key(entry), 1);
    chars += entry.content.length;
  }
  for (const entry of newest) {
    const count = perFile.get(key(entry));
    if (kept.has(entry) || count === undefined || count >= MAX_PER_FILE ||
        entry.content.length > MAX_REVISION_CHARS || chars + entry.content.length > MAX_TOTAL_CHARS) continue;
    kept.add(entry);
    perFile.set(key(entry), count + 1);
    chars += entry.content.length;
  }
  return newest.filter(entry => kept.has(entry));
}

function compareNewestFirst(a: TextRevision, b: TextRevision): number {
  if (a.savedAt !== b.savedAt) return b.savedAt - a.savedAt;
  if ((a.order ?? 0) !== (b.order ?? 0)) return (b.order ?? 0) - (a.order ?? 0);
  return b.id.localeCompare(a.id, undefined, { numeric: true });
}

/**
 * History is recovery data, so normal Mesa use stores it transactionally and
 * asynchronously. `localStorage` remains only as a browser-demo fallback for
 * profiles without IndexedDB.
 */
function revisionDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("revision history storage unavailable"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("revision history storage timed out"));
    }, 2_000);
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains(DATABASE_STORE)
        ? request.transaction!.objectStore(DATABASE_STORE)
        : request.result.createObjectStore(DATABASE_STORE, { keyPath: "id" });
      if (!store.indexNames.contains("by-file")) store.createIndex("by-file", ["root", "relPath"]);
    };
    request.onblocked = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("revision history storage is blocked")); } };
    request.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(request.error); } };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) { request.result.close(); return; }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

function sameRevision(left: TextRevision, right: TextRevision): boolean {
  return left.id === right.id && left.root === right.root && left.relPath === right.relPath &&
    left.savedAt === right.savedAt && left.content === right.content && left.order === right.order && left.source === right.source;
}

/**
 * Runs the complete history decision in one serializable IndexedDB transaction.
 * Reconcile records without clearing revisions acknowledged by another window.
 */
async function mutateDatabase<T>(
  mutation: (entries: TextRevision[]) => { value: T; entries: TextRevision[] }
): Promise<T> {
  const db = await revisionDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(DATABASE_STORE, "readwrite");
    const store = tx.objectStore(DATABASE_STORE);
    const request = store.getAll();
    let settled = false;
    let value!: T;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      db.close();
      reject(error);
    };
    request.onerror = () => fail(request.error ?? new Error("Could not read revision history."));
    request.onsuccess = () => {
      try {
        const stored = (request.result as unknown[]).filter(isTextRevision);
        const outcome = mutation(stored);
        value = outcome.value;
        const desired = trim(outcome.entries);
        const desiredById = new Map(desired.map((entry) => [entry.id, entry]));
        for (const existing of stored) {
          const next = desiredById.get(existing.id);
          if (!next) store.delete(existing.id);
          else if (!sameRevision(existing, next)) store.put(next);
        }
        const storedIds = new Set(stored.map(entry => entry.id));
        for (const entry of desired) {
          if (!storedIds.has(entry.id)) store.put(entry);
        }
      } catch (error) {
        try { tx.abort(); } catch { /* transaction already ended */ }
        fail(error);
      }
    };
    tx.onabort = () => fail(tx.error ?? new Error("Revision history transaction aborted."));
    tx.onerror = () => fail(tx.error ?? new Error("Revision history transaction failed."));
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      db.close();
      resolve(value);
    };
  });
}

export interface RevisionInput {
  relPath: string;
  content: string;
  source: RevisionSource;
}

function addRevision(entries: TextRevision[], root: string, item: RevisionInput, now: number): TextRevision | null {
  if (!root || !item.relPath || item.content.length > MAX_REVISION_CHARS) return null;
  const last = entries.filter(entry => entry.root === root && entry.relPath === item.relPath).sort(compareNewestFirst)[0];
  if (last && (last.source ?? "restore") === item.source && (last.content === item.content ||
      (item.source === "autosave" && now >= last.savedAt && now - last.savedAt < REVISION_COALESCE_MS))) return last;
  const revision: TextRevision = { id: revisionId(now), root, ...item, savedAt: now, order: nextOrder(entries) };
  entries.unshift(revision);
  return revision;
}

/** One retention transaction for a complete external-change batch. */
export function recordTextRevisionsAsync(root: string, items: RevisionInput[], now = Date.now()): Promise<(TextRevision | null)[]> {
  root = vaultStorageId(root);
  if (!items.length) return Promise.resolve([]);
  const mutation = (entries: TextRevision[]) => {
    const updated = [...entries];
    const results = items.map(item => addRevision(updated, root, item, now));
    const retained = trim(updated);
    const ids = new Set(retained.map(entry => entry.id));
    return { value: results.map(entry => entry && ids.has(entry.id) ? entry : null), entries: retained };
  };
  if (typeof indexedDB === "undefined") {
    const result = mutation(readAll());
    return Promise.resolve(writeAll(result.entries) ? result.value : items.map(() => null));
  }
  return mutateDatabase(mutation).catch(() => items.map(() => null));
}

export async function recordTextRevisionAsync(
  root: string, relPath: string, content: string, now = Date.now(),
  options: { source: RevisionSource } = { source: "restore" }
): Promise<TextRevision | null> {
  return (await recordTextRevisionsAsync(root, [{ relPath, content, source: options.source }], now))[0];
}

export async function listTextRevisionsAsync(root: string, relPath: string): Promise<TextRevision[]> {
  root = vaultStorageId(root);
  if (typeof indexedDB === "undefined") return listTextRevisions(root, relPath);
  try {
    const db = await revisionDatabase();
    try {
      return await new Promise<TextRevision[]>((resolve, reject) => {
        const tx = db.transaction(DATABASE_STORE, "readonly");
        const request = tx.objectStore(DATABASE_STORE).index("by-file").getAll([root, relPath]);
        let entries: TextRevision[] = [];
        request.onsuccess = () => { entries = (request.result as unknown[]).filter(isTextRevision).sort(compareNewestFirst); };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => resolve(entries);
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  } catch { return []; }
}

export async function migrateTextRevisionsAsync(root: string, fromRelPath: string, toRelPath: string): Promise<boolean> {
  root = vaultStorageId(root);
  if (!root || !fromRelPath || !toRelPath || fromRelPath === toRelPath) return true;
  if (typeof indexedDB === "undefined") return migrateTextRevisions(root, fromRelPath, toRelPath);
  try {
    await mutateDatabase((entries) => ({
      value: true,
      entries: entries.map((entry) => entry.root === root && entry.relPath === fromRelPath
        ? { ...entry, relPath: toRelPath }
        : entry),
    }));
    return true;
  } catch { return false; }
}

/** Explicitly remove one revision copy; this never touches the vault file. */
export async function purgeTextRevisionAsync(root: string, relPath: string, revisionId: string): Promise<boolean> {
  root = vaultStorageId(root);
  if (!root || !relPath || !revisionId) return false;
  if (typeof indexedDB === "undefined") {
    const entries = readAll();
    const kept = entries.filter((entry) => entry.id !== revisionId || entry.root !== root || entry.relPath !== relPath);
    return kept.length !== entries.length && writeAll(kept);
  }
  try {
    return await mutateDatabase((entries) => {
      const kept = entries.filter((entry) => entry.id !== revisionId || entry.root !== root || entry.relPath !== relPath);
      return { value: kept.length !== entries.length, entries: kept };
    });
  } catch {
    return false;
  }
}

export function recordTextRevision(
  root: string,
  relPath: string,
  content: string,
  now = Date.now()
): TextRevision | null {
  root = vaultStorageId(root);
  if (!root || !relPath) return null;
  const entries = readAll();
  const revision = addRevision(entries, root, { relPath, content, source: "restore" }, now);
  return revision && writeAll(trim(entries)) ? revision : null;
}

export function listTextRevisions(root: string, relPath: string): TextRevision[] {
  root = vaultStorageId(root);
  return readAll().filter((entry) => entry.root === root && entry.relPath === relPath);
}

/** Move local recovery identity after Mesa's verified filesystem rename. */
export function migrateTextRevisions(root: string, fromRelPath: string, toRelPath: string): boolean {
  root = vaultStorageId(root);
  if (!root || !fromRelPath || !toRelPath || fromRelPath === toRelPath) return true;
  const entries = readAll();
  let changed = false;
  const migrated = entries.map((entry) => {
    if (entry.root !== root || entry.relPath !== fromRelPath) return entry;
    changed = true;
    return { ...entry, relPath: toRelPath };
  });
  return !changed || writeAll(migrated);
}

export function clearTextRevisionsForTests(): void {
  fallbackSequence = 0;
  if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
}

/** Enumerate recovery identities without exposing their contents or trimming data. */
async function allDatabaseRevisions(): Promise<TextRevision[]> {
  const db = await revisionDatabase();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction(DATABASE_STORE, "readonly");
    const request = tx.objectStore(DATABASE_STORE).getAll();
    request.onsuccess = () => resolve((request.result as unknown[]).filter(isTextRevision));
    request.onerror = () => reject(request.error); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}
export async function legacyRevisionRoots(): Promise<Set<string>> {
  const entries = typeof indexedDB === "undefined" ? readAll() : [...await allDatabaseRevisions(), ...readAll()];
  return new Set(entries.map(entry => entry.root));
}
/** Rewrite identities atomically; never expire or clear authored recovery records. */
export async function migrateRevisionNamespaces(identity: (root: string) => string): Promise<void> {
  const legacy = readAll();
  if (typeof indexedDB !== "undefined") {
    const db = await revisionDatabase();
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DATABASE_STORE, "readwrite");
      const store = tx.objectStore(DATABASE_STORE); const request = store.getAll();
      request.onsuccess = () => {
        try {
          const entries = (request.result as unknown[]).filter(isTextRevision);
          for (const entry of entries) if (identity(entry.root) !== entry.root) store.put({ ...entry, root: identity(entry.root) });
          for (const entry of legacy) if (!entries.some(existing => existing.id === entry.id)) store.put({ ...entry, root: identity(entry.root) });
        } catch { tx.abort(); }
      };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error("History privacy migration failed"));
    }); } finally { db.close(); }
    localStorage.removeItem(STORAGE_KEY);
  } else if (legacy.length && !writeAll(legacy.map(entry => ({ ...entry, root: identity(entry.root) })))) {
    throw new Error("History privacy migration failed; original recovery data was retained");
  }
}
