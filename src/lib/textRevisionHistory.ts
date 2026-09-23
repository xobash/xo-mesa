export interface TextRevision {
  id: string;
  root: string;
  relPath: string;
  savedAt: number;
  content: string;
  /** Serialized order for equal-millisecond saves; assigned inside IndexedDB. */
  order?: number;
}

const STORAGE_KEY = "mesa:textRevisionHistory:v1";
const DATABASE_NAME = "mesa-text-revision-history";
const DATABASE_VERSION = 1;
const DATABASE_STORE = "revisions";
const LEGACY_MIGRATION_MARKER_ID = "\u0000mesa:textRevisionHistory:legacy-v1-imported";
const MAX_PER_FILE = 20;
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
  // UUIDs make records collision-resistant across independent windows. Ordering
  // is deliberately separate: it is assigned in the same IndexedDB transaction.
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
  const kept: TextRevision[] = [];
  let chars = 0;
  for (const entry of newest) {
    const key = `${entry.root}\0${entry.relPath}`;
    const count = perFile.get(key) ?? 0;
    if (count >= MAX_PER_FILE) continue;
    if (kept.length > 0 && chars + entry.content.length > MAX_TOTAL_CHARS) continue;
    kept.push(entry);
    perFile.set(key, count + 1);
    chars += entry.content.length;
  }
  return kept.sort(compareNewestFirst);
}

function compareNewestFirst(a: TextRevision, b: TextRevision): number {
  if (a.savedAt !== b.savedAt) return b.savedAt - a.savedAt;
  if ((a.order ?? 0) !== (b.order ?? 0)) return (b.order ?? 0) - (a.order ?? 0);
  return b.id.localeCompare(a.id, undefined, { numeric: true });
}

/**
 * History is recovery data, so normal Mesa use stores it transactionally and
 * asynchronously. `localStorage` remains only as a browser-demo fallback for
 * profiles where IndexedDB is intentionally unavailable.
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
    left.savedAt === right.savedAt && left.content === right.content && left.order === right.order;
}

/**
 * Runs the complete history decision in one serializable IndexedDB transaction.
 * This is intentionally per-record reconciliation: `clear()` followed by
 * `put()` lets another window erase an acknowledged revision between phases.
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
    let migratedLegacy = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      db.close();
      reject(error);
    };
    request.onerror = () => fail(request.error ?? new Error("Could not read revision history."));
    request.onsuccess = () => {
      try {
        const rawStored = request.result as unknown[];
        const stored = rawStored.filter(isTextRevision);
        // Legacy localStorage is imported exactly once, in the same transaction
        // that first uses the database. A durable marker prevents an old copy
        // from reappearing after the user later purges every database revision.
        const importingLegacy = !rawStored.some((entry) =>
          typeof entry === "object" && entry !== null &&
          (entry as { id?: unknown }).id === LEGACY_MIGRATION_MARKER_ID
        );
        const legacy = importingLegacy && stored.length === 0 ? readAll() : [];
        migratedLegacy = importingLegacy;
        if (importingLegacy) store.put({ id: LEGACY_MIGRATION_MARKER_ID, migratedAt: Date.now() });
        const current = [...stored, ...legacy];
        const outcome = mutation(current);
        value = outcome.value;
        const desired = trim(outcome.entries);
        const desiredById = new Map(desired.map((entry) => [entry.id, entry]));
        for (const existing of stored) {
          const next = desiredById.get(existing.id);
          if (!next) store.delete(existing.id);
          else if (!sameRevision(existing, next)) store.put(next);
        }
        for (const entry of desired) {
          if (!stored.some((existing) => existing.id === entry.id)) store.put(entry);
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
      if (migratedLegacy && typeof localStorage !== "undefined") {
        // A failed removal only leaves a duplicate legacy recovery copy; it can
        // never make the just-committed IndexedDB record disappear.
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* best effort */ }
      }
      resolve(value);
    };
  });
}

export function recordTextRevisionAsync(
  root: string,
  relPath: string,
  content: string,
  now = Date.now()
): Promise<TextRevision | null> {
  if (!root || !relPath || !content) return Promise.resolve(null);
  if (typeof indexedDB === "undefined") return Promise.resolve(recordTextRevision(root, relPath, content, now));
  return mutateDatabase((entries) => {
    const last = entries
      .filter((entry) => entry.root === root && entry.relPath === relPath)
      .sort(compareNewestFirst)[0];
    if (last?.content === content) return { value: null, entries };
    const revision: TextRevision = { id: revisionId(now), root, relPath, savedAt: now, content, order: nextOrder(entries) };
    return { value: revision, entries: [revision, ...entries] };
  }).catch(() => null);
}

export async function listTextRevisionsAsync(root: string, relPath: string): Promise<TextRevision[]> {
  if (typeof indexedDB === "undefined") return listTextRevisions(root, relPath);
  try {
    return await mutateDatabase((entries) => ({
      value: entries
      .filter((entry) => entry.root === root && entry.relPath === relPath)
      .sort(compareNewestFirst),
      entries,
    }));
  } catch {
    return [];
  }
}

export async function migrateTextRevisionsAsync(root: string, fromRelPath: string, toRelPath: string): Promise<boolean> {
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
  if (!root || !relPath || !content) return null;
  const entries = readAll();
  const last = entries.filter((entry) => entry.root === root && entry.relPath === relPath).sort(compareNewestFirst)[0];
  if (last?.content === content) return null;
  const revision: TextRevision = {
    id: revisionId(now),
    root,
    relPath,
    savedAt: now,
    content,
    order: nextOrder(entries),
  };
  return writeAll(trim([revision, ...entries])) ? revision : null;
}

export function listTextRevisions(root: string, relPath: string): TextRevision[] {
  return readAll().filter((entry) => entry.root === root && entry.relPath === relPath);
}

/** Move local recovery identity after Mesa's verified filesystem rename. */
export function migrateTextRevisions(root: string, fromRelPath: string, toRelPath: string): boolean {
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
