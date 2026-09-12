import { documentEntries, isIndexedCache, type IndexedDocument } from './documentWorkingSet';
import type { SearchFile, SearchPass } from './search';

export function createIndexSearch(cache?: Record<string, string>) {
  if (cache && !isIndexedCache(cache)) return null;
  if (typeof Worker === 'undefined') return null;
  let worker: Worker;
  try { worker = new Worker(new URL('./indexSearch.worker.ts', import.meta.url), { type: 'module' }); } catch { return null; }
  let sequence = 0;
  let previousFiles: readonly SearchFile[] | null = null;
  let seen = new Map<string, { revision: unknown; document: unknown }>();
  const pending = new Map<number, { resolve: (pass: SearchPass) => void; reject: (error: Error) => void }>();
  const cancel = () => {
    const id = ++sequence;
    try { worker.postMessage({ id, cancel: true }); } catch { /* crashed worker still releases pending callers */ }
    for (const job of pending.values()) job.reject(new Error('Search superseded'));
    pending.clear();
  };
  worker.onmessage = event => {
    const job = pending.get(event.data.id); if (!job) return;
    pending.delete(event.data.id);
    if (event.data.error) job.reject(new Error(event.data.error)); else job.resolve(event.data.result);
  };
  const fail = () => { for (const job of pending.values()) job.reject(new Error('Search worker failed')); pending.clear(); };
  worker.onerror = fail;
  worker.onmessageerror = fail;
  return {
    accepts: isIndexedCache,
    run(files: readonly SearchFile[], cache: Record<string, string>, query: string): Promise<SearchPass> {
      cancel();
      const id = ++sequence;
      const changes: { rel: string; document?: IndexedDocument; text?: string }[] = [];
      const next = new Map<string, { revision: unknown; document: unknown }>();
      for (const item of documentEntries(cache)) {
        const old = seen.get(item.rel);
        if (!old || old.revision !== item.revision || old.document !== item.document) changes.push({ rel: item.rel, document: item.document, text: item.text });
        next.set(item.rel, { revision: item.revision, document: item.document });
      }
      const removed = [...seen.keys()].filter(rel => !next.has(rel));
      seen = next;
      const changedFiles = files !== previousFiles; previousFiles = files;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { worker.postMessage({ id, query, files: changedFiles ? files : undefined, changes, removed }); }
        catch (error) { pending.delete(id); seen = new Map(); previousFiles = null; reject(error instanceof Error ? error : new Error(String(error))); }
      });
    },
    cancel,
    dispose() { cancel(); worker.terminate(); seen.clear(); previousFiles = null; },
  };
}

// One worker per vault/cache identity. Search surfaces are transient (the
// palette and the dedicated search pane can both mount), but the indexed
// document set is vault state, not UI state. A short idle grace period avoids
// rebuilding the worker when a surface is closed and reopened.
let shared: { scope: string; cache: Record<string, string>; search: NonNullable<ReturnType<typeof createIndexSearch>>; users: number; timer: ReturnType<typeof setTimeout> | null } | null = null;

export function acquireSharedIndexSearch(cache: Record<string, string>, scope = "default") {
  if (!isIndexedCache(cache)) return null;
  if (shared && shared.scope !== scope) {
    shared.search.dispose();
    shared = null;
  }
  if (!shared) {
    const search = createIndexSearch(cache);
    if (!search) return null;
    shared = { scope, cache, search, users: 0, timer: null };
  }
  // Cache identity changes on every local edit. The worker's revision diff is
  // specifically designed to absorb that change without rebuilding it.
  shared.cache = cache;
  if (shared.timer) { clearTimeout(shared.timer); shared.timer = null; }
  shared.users++;
  const current = shared;
  return {
    accepts: current.search.accepts,
    run: current.search.run,
    cancel: current.search.cancel,
    release() {
      if (!shared || shared !== current) return;
      current.users = Math.max(0, current.users - 1);
      if (!current.users) current.timer = setTimeout(() => {
        if (shared === current && current.users === 0) { current.search.dispose(); shared = null; }
      }, 30_000);
    },
  };
}
