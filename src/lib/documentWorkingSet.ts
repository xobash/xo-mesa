import { inflateSync } from 'fflate';
import type { IndexedDocument } from "./documentCodec";
import { isMarkdownPath } from "./markdownCode";
import type { TaskItem } from "./taskParsing";
export type { IndexedDocument } from "./documentCodec";

/** `markdown` is false for other text files, whose tasks follow plain-text code rules. */
/** `superseded` marks a revision replaced in a newer fork; older forks still read it, but it is not worth compacting. */
interface Entry { value?: string; indexed?: IndexedDocument; markdown?: boolean; superseded?: boolean }
interface State { buckets: Map<string, Entry>[]; shared: Set<number>; pool: WorkingSet }
const states = new WeakMap<object, State>();
const cacheLineage = new WeakMap<object, { parent: WeakRef<object>; changed: Set<string>; taskStable: Set<string> }>();
/** Changed keys in one cache fork; null means the caller must use a full pass. */
export function cacheChangedKeysSince(cache: Record<string, string>, parent: Record<string, string>): ReadonlySet<string> | null {
  const lineage = cacheLineage.get(cache);
  return lineage?.parent.deref() === parent ? lineage.changed : null;
}
export function markCacheTaskStable(cache: Record<string, string>, key: string): void {
  cacheLineage.get(cache)?.taskStable.add(key);
}
export function cacheTaskStableSince(cache: Record<string, string>, parent: Record<string, string>, key: string): boolean {
  const lineage = cacheLineage.get(cache);
  return lineage?.parent.deref() === parent && lineage.taskStable.has(key) || false;
}

const compactions: WeakRef<Entry>[] = [];
const scheduled = new WeakSet<Entry>();
/** Compaction waits for this much quiet, so a typing burst encodes once. */
const COMPACTION_QUIET_MS = 2000;
/** The shared codec worker is released after this long without compaction. */
const CODEC_IDLE_MS = 30_000;
let compactTimer: ReturnType<typeof setTimeout> | null = null;
let draining = false;
type IndexCodec = ReturnType<typeof import('./indexCodec').createIndexCodec>;
let codec: IndexCodec | null = null;
let codecIdleTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleDrain(): void {
  if (compactTimer) clearTimeout(compactTimer);
  compactTimer = setTimeout(() => { compactTimer = null; void drainCompactions(); }, COMPACTION_QUIET_MS);
}
function scheduleCompaction(entry: Entry): void {
  if (scheduled.has(entry)) return;
  scheduled.add(entry); compactions.push(new WeakRef(entry));
  scheduleDrain();
}
async function sharedCodec(): Promise<IndexCodec> {
  if (codecIdleTimer) { clearTimeout(codecIdleTimer); codecIdleTimer = null; }
  if (codec && !codec.available) { codec.dispose(); codec = null; }
  if (!codec) {
    const { createIndexCodec } = await import('./indexCodec');
    codec ??= createIndexCodec();
  }
  return codec;
}
async function drainCompactions(): Promise<void> {
  if (draining) return;
  draining = true;
  // Entries queued during this drain wait for their own quiet period.
  const queue = compactions.splice(0);
  try {
    const active = await sharedCodec();
    while (queue.length) {
      const entries: Entry[] = [];
      let chars = 0;
      while (queue.length && entries.length < 64 && chars < 2 * 1024 * 1024) {
        const entry = queue.shift()!.deref();
        if (entry?.value !== undefined && !entry.superseded) { entries.push(entry); chars += entry.value.length; }
      }
      const texts = entries.map(entry => entry.value!);
      const docs = await active.encode(texts, entries.map(entry => entry.markdown ?? true));
      entries.forEach((entry, i) => { entry.indexed = docs[i]; delete entry.value; });
      if (queue.length) await new Promise(resolve => setTimeout(resolve, 0));
    }
  } catch {
    // Compaction is optional; uncompacted entries keep their exact text.
  } finally {
    draining = false;
    if (compactions.length && !compactTimer) scheduleDrain();
    if (codecIdleTimer) clearTimeout(codecIdleTimer);
    codecIdleTimer = setTimeout(() => { codecIdleTimer = null; if (!draining) { codec?.dispose(); codec = null; } }, CODEC_IDLE_MS);
  }
}

const BUCKETS = 256;
const DOCUMENT_WORKING_SET_CHARS = 8 * 1024 * 1024;
class WorkingSet {
  values = new Map<Entry, string>();
  chars = 0;
  constructor(readonly budget: number) {}
  read(entry: Entry): string {
    if (entry.value !== undefined) return entry.value;
    const hit = this.values.get(entry);
    if (hit !== undefined) { this.values.delete(entry); this.values.set(entry, hit); return hit; }
    const index = entry.indexed!;
    const bytes = inflateSync(index.bytes);
    let text: string;
    if (index.encoding === 'utf8') text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    else {
      if (bytes.length !== index.chars * 2) throw new Error('Invalid document index length');
      const units = new Uint16Array(index.chars);
      for (let i = 0; i < units.length; i++) units[i] = bytes[i * 2] | bytes[i * 2 + 1] << 8;
      const parts: string[] = [];
      for (let i = 0; i < units.length; i += 8192) parts.push(String.fromCharCode(...units.subarray(i, i + 8192)));
      text = parts.join('');
    }
    if (text.length !== index.chars) throw new Error('Invalid document index length');
    if (text.length <= this.budget) {
      while (this.chars + text.length > this.budget && this.values.size) {
        const first = this.values.keys().next().value!;
        this.chars -= this.values.get(first)!.length; this.values.delete(first);
      }
      this.values.set(entry, text); this.chars += text.length;
    }
    return text;
  }
}
function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function entryOf(cache: Record<string, string>, key: string): Entry | undefined { const s = states.get(cache); return s?.buckets[hash(key) % BUCKETS].get(key); }
/** A conservative candidate filter; exact matching/ranking stays in search.ts. */
export function documentMayMatch(cache: Record<string, string>, key: string, term: string): boolean {
  const indexed = entryOf(cache, key)?.indexed;
  if (!indexed || term.length < 3) return true;
  for (let i = 0; i + 2 < term.length; i++) { const bit = hash(term.slice(i, i + 3)) % 4096; if (!(indexed.bloom[bit >>> 3] & (1 << (bit & 7)))) return false; }
  return true;
}
export function indexedDocumentTasks(cache: Record<string, string>, key: string): readonly TaskItem[] | undefined { return entryOf(cache, key)?.indexed?.tasks; }
export function documentRevision(cache: Record<string, string>, key: string): unknown { return entryOf(cache, key) ?? cache[key]; }
export function workingSetStats(cache: Record<string, string>) { const s = states.get(cache); return { decodedChars: s?.pool.chars ?? 0, decodedDocuments: s?.pool.values.size ?? 0 }; }
export function isIndexedCache(cache: Record<string, string>): boolean { return states.has(cache); }
function wrap(s: State): Record<string, string> {
  const proxy = new Proxy(Object.create(null) as Record<string, string>, {
    get: (_target, key) => typeof key === 'string' ? (() => { const e = s.buckets[hash(key) % BUCKETS].get(key); return e ? s.pool.read(e) : undefined; })() : undefined,
    has: (_target, key) => typeof key === 'string' && s.buckets[hash(key) % BUCKETS].has(key),
    ownKeys: () => s.buckets.flatMap(bucket => [...bucket.keys()]),
    getOwnPropertyDescriptor: (_target, key) => typeof key === 'string' && s.buckets[hash(key) % BUCKETS].has(key) ? { enumerable: true, configurable: true } : undefined,
    set: (_target, key, value) => {
      if (typeof key !== 'string' || typeof value !== 'string') throw new Error('Document cache accepts text only');
      cacheLineage.get(proxy)?.changed.add(key);
      const bucket = hash(key) % BUCKETS;
      if (s.shared.has(bucket)) { s.buckets[bucket] = new Map(s.buckets[bucket]); s.shared.delete(bucket); }
      const previous = s.buckets[bucket].get(key);
      if (previous) previous.superseded = true;
      const entry = { value, markdown: isMarkdownPath(key) };
      s.buckets[bucket].set(key, entry); scheduleCompaction(entry); return true;
    },
    deleteProperty: (_target, key) => {
      if (typeof key !== 'string') return true;
      cacheLineage.get(proxy)?.changed.add(key);
      const bucket = hash(key) % BUCKETS;
      if (s.shared.has(bucket)) { s.buckets[bucket] = new Map(s.buckets[bucket]); s.shared.delete(bucket); }
      s.buckets[bucket].delete(key); return true;
    },
  });
  states.set(proxy, s); return proxy;
}
export function indexedContentCache(records: Iterable<[string, IndexedDocument]>, budget = DOCUMENT_WORKING_SET_CHARS): Record<string, string> {
  const s: State = { buckets: Array.from({ length: BUCKETS }, () => new Map()), shared: new Set(), pool: new WorkingSet(budget) };
  for (const [key, indexed] of records) s.buckets[hash(key) % BUCKETS].set(key, { indexed });
  return wrap(s);
}
/** Copy-on-write buckets preserve old search snapshots without decoding the corpus. */
export function forkContentCache(cache: Record<string, string>, changes: Record<string, string> = {}): Record<string, string> {
  const source = states.get(cache);
  if (!source) return { ...cache, ...changes };
  const shared = new Set(Array.from({ length: BUCKETS }, (_, i) => i));
  source.shared = new Set(shared);
  const copy = wrap({ buckets: source.buckets.slice(), shared, pool: source.pool });
  cacheLineage.set(copy, { parent: new WeakRef(cache), changed: new Set(), taskStable: new Set() });
  for (const [key, value] of Object.entries(changes)) copy[key] = value;
  return copy;
}
/** Move one entry of a cache fork the caller owns to a new key without decoding it. */
export function moveCacheEntry(cache: Record<string, string>, from: string, to: string): boolean {
  if (from === to) return from in cache;
  const state = states.get(cache);
  if (!state) {
    if (!(from in cache)) return false;
    cache[to] = cache[from];
    delete cache[from];
    return true;
  }
  const entry = entryOf(cache, from);
  if (!entry) return false;
  delete cache[from];
  cacheLineage.get(cache)?.changed.add(to);
  const bucket = hash(to) % BUCKETS;
  if (state.shared.has(bucket)) { state.buckets[bucket] = new Map(state.buckets[bucket]); state.shared.delete(bucket); }
  const previous = state.buckets[bucket].get(to);
  if (previous) previous.superseded = true;
  state.buckets[bucket].set(to, entry);
  return true;
}
/** Re-encode only clean, unchanged revisions; representation changes preserve value. */
export function compactDocument(cache: Record<string, string>, key: string, expected: string): void {
  const entry = entryOf(cache, key);
  if (!entry || entry.value !== expected) return;
  scheduleCompaction(entry);
}

/** Transport identities and compressed bytes without materializing document text. */
export function* documentEntries(cache: Record<string, string>): Generator<{ rel: string; revision: unknown; document?: IndexedDocument; text?: string }> {
  const state = states.get(cache);
  if (!state) { for (const [rel, text] of Object.entries(cache)) yield { rel, revision: text, text }; return; }
  for (const bucket of state.buckets) for (const [rel, entry] of bucket) yield { rel, revision: entry, document: entry.indexed, text: entry.value };
}
export function putIndexedDocument(cache: Record<string, string>, key: string, indexed: IndexedDocument): void {
  const state = states.get(cache);
  if (!state) throw new Error('Indexed cache required');
  cacheLineage.get(cache)?.changed.add(key);
  const bucket = hash(key) % BUCKETS;
  if (state.shared.has(bucket)) { state.buckets[bucket] = new Map(state.buckets[bucket]); state.shared.delete(bucket); }
  const previous = state.buckets[bucket].get(key);
  if (previous) previous.superseded = true;
  state.buckets[bucket].set(key, { indexed });
}

/** A search cursor owns immutable bucket snapshots, not another document index.
 * At most 256 identities are checked per query; only changed buckets are walked.
 * Pinning buckets also catches writes made directly to the same cache proxy.
 */
export function createDocumentDeltaReader() {
  let previous: Map<string, Entry>[] = [];
  return {
    reset() { previous = []; },
    read(cache: Record<string, string>) {
      const state = states.get(cache);
      if (!state) throw new Error('Indexed cache required');
      const changes: { rel: string; document?: IndexedDocument; text?: string }[] = [];
      const removed: string[] = [];
      state.buckets.forEach((bucket, index) => {
        const old = previous[index];
        if (old !== bucket) {
          for (const [rel, entry] of bucket) {
            if (old?.get(rel) !== entry) changes.push({ rel, document: entry.indexed, text: entry.value });
          }
          if (old) for (const rel of old.keys()) if (!bucket.has(rel)) removed.push(rel);
        }
        state.shared.add(index);
      });
      previous = state.buckets.slice();
      return { changes, removed };
    },
  };
}
