import { createDocumentDeltaReader, isIndexedCache } from './documentWorkingSet';
import type { SearchFile, SearchPass } from './search';

export function createIndexSearch(cache?: Record<string, string>) {
  if (cache && !isIndexedCache(cache)) return null;
  if (typeof Worker === 'undefined') return null;
  let worker: Worker;
  try { worker = new Worker(new URL('./indexSearch.worker.ts', import.meta.url), { type: 'module' }); } catch { return null; }
  let sequence = 0;
  let disposed = false;
  let previousFiles: readonly SearchFile[] | null = null;
  const documents = createDocumentDeltaReader();
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
      // A terminated worker drops messages; waiting on one would never settle.
      if (disposed) return Promise.reject(new Error('Search worker disposed'));
      cancel();
      const id = ++sequence;
      const { changes, removed } = documents.read(cache);
      const changedFiles = files !== previousFiles; previousFiles = files;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { worker.postMessage({ id, query, files: changedFiles ? files : undefined, changes, removed }); }
        catch (error) { pending.delete(id); documents.reset(); previousFiles = null; reject(error instanceof Error ? error : new Error(String(error))); }
      });
    },
    cancel,
    dispose() { disposed = true; cancel(); worker.terminate(); documents.reset(); previousFiles = null; },
  };
}

// One worker per vault/cache identity. Search surfaces are transient (the
// palette and the dedicated search pane can both mount), but the indexed
// document set is vault state, not UI state. A short idle grace period avoids
// rebuilding the worker when a surface is closed and reopened.
type IndexSearch = NonNullable<ReturnType<typeof createIndexSearch>>;
type SearchArgs = Parameters<IndexSearch["run"]>;
interface QueuedSearch { owner: object; args: SearchArgs; resolve: (pass: SearchPass) => void; reject: (error: Error) => void }

/**
 * The shared worker scans one search at a time and any new message stops the
 * current scan, so surfaces take turns: a surface's new search replaces only
 * its own earlier one, and another surface's search runs next instead of
 * being rejected (the palette and the search pane cancelled each other and
 * fell back to main-thread scans).
 */
function createSearchTurns(search: IndexSearch) {
  const queue: QueuedSearch[] = [];
  let running: QueuedSearch | null = null;
  const pump = () => {
    if (running || queue.length === 0) return;
    const job = queue.shift()!;
    running = job;
    const done = () => { if (running === job) running = null; pump(); };
    search.run(...job.args).then((pass) => { done(); job.resolve(pass); }, (error: Error) => { done(); job.reject(error); });
  };
  const cancel = (owner: object) => {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].owner === owner) queue.splice(i, 1)[0].reject(new Error("Search superseded"));
    }
    if (running?.owner === owner) search.cancel();
  };
  return {
    run(owner: object, args: SearchArgs): Promise<SearchPass> {
      cancel(owner);
      return new Promise((resolve, reject) => { queue.push({ owner, args, resolve, reject }); pump(); });
    },
    cancel,
  };
}

let shared: { scope: string; cache: Record<string, string>; search: IndexSearch; turns: ReturnType<typeof createSearchTurns>; users: number; timer: ReturnType<typeof setTimeout> | null } | null = null;

export function acquireSharedIndexSearch(cache: Record<string, string>, scope = "default") {
  if (!isIndexedCache(cache)) return null;
  if (shared && shared.scope !== scope) {
    shared.search.dispose();
    shared = null;
  }
  if (!shared) {
    const search = createIndexSearch(cache);
    if (!search) return null;
    shared = { scope, cache, search, turns: createSearchTurns(search), users: 0, timer: null };
  }
  // Cache identity changes on every local edit. The worker's revision diff is
  // specifically designed to absorb that change without rebuilding it.
  shared.cache = cache;
  if (shared.timer) { clearTimeout(shared.timer); shared.timer = null; }
  shared.users++;
  const current = shared;
  const owner = {};
  return {
    accepts: current.search.accepts,
    run: (...args: SearchArgs) => current.turns.run(owner, args),
    cancel: () => current.turns.cancel(owner),
    release() {
      if (!shared || shared !== current) return;
      current.turns.cancel(owner);
      current.users = Math.max(0, current.users - 1);
      if (!current.users) current.timer = setTimeout(() => {
        if (shared === current && current.users === 0) { current.search.dispose(); shared = null; }
      }, 30_000);
    },
  };
}
