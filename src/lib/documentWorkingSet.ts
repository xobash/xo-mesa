import { inflateSync } from 'fflate';
import type { IndexedDocument } from "./documentCodec";
import type { TaskItem } from "./taskParsing";
export type { IndexedDocument } from "./documentCodec";

interface Entry { value?: string; indexed?: IndexedDocument }
interface State { buckets: Map<string, Entry>[]; shared: Set<number>; pool: WorkingSet }
const states = new WeakMap<object, State>();

const compactions: WeakRef<Entry>[] = [];
const scheduled = new WeakSet<Entry>();
let compacting = false;
function scheduleCompaction(entry: Entry): void {
  if (scheduled.has(entry)) return;
  scheduled.add(entry); compactions.push(new WeakRef(entry));
  if (compacting) return;
  compacting = true;
  setTimeout(() => { void drainCompactions().catch(() => { compacting = false; }); }, 500);
}
async function drainCompactions(): Promise<void> {
  const { createIndexCodec } = await import('./indexCodec');
  const codec = createIndexCodec();
  try {
    while (compactions.length) {
      const entries: Entry[] = [];
      let chars = 0;
      while (compactions.length && entries.length < 64 && chars < 2 * 1024 * 1024) {
        const entry = compactions.shift()!.deref();
        if (entry?.value !== undefined) { entries.push(entry); chars += entry.value.length; }
      }
      const texts = entries.map(entry => entry.value!);
      const docs = await codec.encode(texts);
      entries.forEach((entry, i) => { entry.indexed = docs[i]; delete entry.value; });
      if (compactions.length) await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally { codec.dispose(); compacting = false; }
}

const BUCKETS = 256;
export const DOCUMENT_WORKING_SET_CHARS = 8 * 1024 * 1024;
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
      const bucket = hash(key) % BUCKETS;
      if (s.shared.has(bucket)) { s.buckets[bucket] = new Map(s.buckets[bucket]); s.shared.delete(bucket); }
      const entry = { value };
      s.buckets[bucket].set(key, entry); scheduleCompaction(entry); return true;
    },
    deleteProperty: (_target, key) => {
      if (typeof key !== 'string') return true;
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
  for (const [key, value] of Object.entries(changes)) copy[key] = value;
  return copy;
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
  const bucket = hash(key) % BUCKETS;
  if (state.shared.has(bucket)) { state.buckets[bucket] = new Map(state.buckets[bucket]); state.shared.delete(bucket); }
  state.buckets[bucket].set(key, { indexed });
}
