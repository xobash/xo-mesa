import { extractLinksAndFirstImage } from "./markdownExtract";
import type { NoteMeta, VaultFile } from '../types';
import { buildNotes, createImageResolver } from './graph';
import { isTextualVaultFile } from './vault';
import { indexedContentCache, type IndexedDocument } from './documentWorkingSet';
import { runCancellableBackgroundWork } from "./backgroundWorkGovernor";

const VERSION = 1;
interface RecordEntry { digest: string; document: IndexedDocument; note: NoteMeta; integrity: string; imageTarget?: string }
interface Snapshot { version: number; root: string; entries: [string, RecordEntry][]; cachedAt: number }
export interface VaultIndexStorage { load(root: string): Promise<Snapshot | null>; save(snapshot: Snapshot): Promise<void> }
const epochs = new Map<string, number>();
const MAX_PERSISTED_CHARS = 32 * 1024 * 1024;
/** One browser profile budget, rather than four independent vault allowances. */
export const GLOBAL_INDEX_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;
export interface VaultIndexStorageStats { bytes: number; snapshots: number; budgetBytes: number }
function snapshotBytes(snapshot: Snapshot): number {
  return snapshot.entries.reduce((total, [, entry]) => total + entry.document.bytes.byteLength + entry.document.bloom.byteLength + JSON.stringify([entry.digest, entry.note, entry.imageTarget, entry.document.tasks]).length * 2, 0);
}
const database = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') { reject(new Error('Index storage unavailable')); return; }
  const request = indexedDB.open('mesa-vault-index', VERSION);
  let finished = false;
  const timer = setTimeout(() => { finished = true; reject(new Error('Index storage timed out')); }, 2000);
  request.onupgradeneeded = () => { if (request.result.objectStoreNames.contains('vaults')) request.result.deleteObjectStore('vaults'); const store = request.result.createObjectStore('vaults', { keyPath: 'root' }); store.createIndex('cachedAt', 'cachedAt'); };
  request.onblocked = () => { finished = true; clearTimeout(timer); reject(new Error('Index storage blocked')); };
  request.onerror = () => { finished = true; clearTimeout(timer); reject(request.error); };
  request.onsuccess = () => { clearTimeout(timer); if (finished) request.result.close(); else { finished = true; request.result.onversionchange = () => request.result.close(); resolve(request.result); } };
});
export const vaultIndexStorage: VaultIndexStorage = {
  async load(root) {
    const db = await database();
    try { return await new Promise((resolve, reject) => {
      const tx = db.transaction('vaults', 'readonly'); const request = tx.objectStore('vaults').get(root);
      request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error); tx.onabort = () => reject(tx.error);
    }); } finally { db.close(); }
  },
  async save(snapshot) {
    const epoch = epochs.get(snapshot.root) ?? 0;
    const db = await database();
    if ((epochs.get(snapshot.root) ?? 0) !== epoch) { db.close(); return; }
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('vaults', 'readwrite'); const store = tx.objectStore('vaults'); store.put(snapshot);
      // Account the actual payload, then evict oldest snapshots globally. This
      // keeps a busy four-vault laptop from silently reserving 512 MB.
      const all = store.getAll();
      all.onsuccess = () => {
        const snapshots = (all.result as Snapshot[]).filter(value => value?.root);
        const newest = snapshots.filter(value => value.root !== snapshot.root);
        newest.push(snapshot);
        let used = newest.reduce((total, value) => total + snapshotBytes(value), 0);
        for (const old of newest.sort((a, b) => a.cachedAt - b.cachedAt)) {
          if (used <= GLOBAL_INDEX_CACHE_BUDGET_BYTES) break;
          if (old.root === snapshot.root && newest.length === 1) break;
          store.delete(old.root); used -= snapshotBytes(old);
        }
      };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    }); } finally { db.close(); }
  },
};

export async function vaultIndexStorageStats(): Promise<VaultIndexStorageStats> {
  try {
    const db = await database();
    try { return await new Promise((resolve, reject) => {
      const request = db.transaction('vaults', 'readonly').objectStore('vaults').getAll();
      request.onsuccess = () => {
        const snapshots = (request.result as Snapshot[]).filter(value => value?.root);
        resolve({ bytes: snapshots.reduce((total, value) => total + snapshotBytes(value), 0), snapshots: snapshots.length, budgetBytes: GLOBAL_INDEX_CACHE_BUDGET_BYTES });
      };
      request.onerror = () => reject(request.error);
    }); } finally { db.close(); }
  } catch { return { bytes: 0, snapshots: 0, budgetBytes: GLOBAL_INDEX_CACHE_BUDGET_BYTES }; }
}

/** Removes only disposable IndexedDB indexes. Vault files and settings remain untouched. */
export async function clearLocalIndexCache(): Promise<void> {
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const request = db.transaction('vaults', 'readwrite').objectStore('vaults').clear();
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  }); } finally { db.close(); }
}
function valid(entry: RecordEntry): boolean {
  return !!entry && typeof entry.digest === 'string' && /^[a-f0-9]{64}$/.test(entry.digest) &&
    entry.document?.bytes instanceof Uint8Array && (entry.document.encoding === 'utf8' || entry.document.encoding === 'utf16') && entry.document.bloom instanceof Uint8Array && entry.document.bloom.length === 512 &&
    Number.isSafeInteger(entry.document.chars) && entry.document.chars >= 0 && entry.document.chars <= MAX_PERSISTED_CHARS &&
    Array.isArray(entry.document.tasks) &&
    !!entry.note && typeof entry.note.title === 'string' && [entry.note.rawLinks, entry.note.tags, entry.note.aliases].every(a => Array.isArray(a) && a.every(x => typeof x === 'string'));
}
export async function fingerprintText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
async function integrity(entry: Omit<RecordEntry, 'integrity'>): Promise<string> {
  const metadata = new TextEncoder().encode(JSON.stringify([entry.digest, entry.document.chars, entry.document.encoding, entry.note, entry.imageTarget, entry.document.tasks]));
  const bytes = new Uint8Array(entry.document.bytes.length + entry.document.bloom.length + metadata.length);
  bytes.set(entry.document.bytes); bytes.set(entry.document.bloom, entry.document.bytes.length); bytes.set(metadata, entry.document.bytes.length + entry.document.bloom.length);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
/** Bound read/worker batches by bytes as well as document count. */
export function indexReadBatches(files: readonly VaultFile[]): VaultFile[][] {
  const groups: VaultFile[][] = [];
  let group: VaultFile[] = [], bytes = 0;
  for (const file of files) {
    const size = file.size ?? 1024 * 1024;
    if (group.length && (group.length >= 64 || bytes + size > 4 * 1024 * 1024)) { groups.push(group); group = []; bytes = 0; }
    group.push(file); bytes += size;
  }
  if (group.length) groups.push(group);
  return groups;
}
/** Hashes validate bytes, not timestamps. Failure of any cache facility is a miss. */
export async function loadIndexedNotes(options: {
  root: string; files: VaultFile[];
  read(files: VaultFile[]): Promise<string[]>;
  fingerprints(rels: string[]): Promise<(string | null)[]>;
  stopped(): boolean;
  storage?: VaultIndexStorage;
}): Promise<{ notes: Record<string, NoteMeta>; cache: Record<string, string>; reused: number; read: number }> {
  const { root, files, read, fingerprints, stopped } = options;
  const storage = options.storage ?? vaultIndexStorage;
  const epoch = epochs.get(root) ?? 0;
  let snapshot: Snapshot | null = null;
  try { snapshot = await storage.load(root); } catch { /* disposable cache */ }
  const prior = snapshot?.version === VERSION && snapshot.root === root && Array.isArray(snapshot.entries) ? new Map(snapshot.entries.filter(pair => Array.isArray(pair) && typeof pair[0] === 'string' && valid(pair[1]))) : new Map<string, RecordEntry>();
  const textDocuments = files.filter(isTextualVaultFile);
  const entries = new Map<string, RecordEntry>();
  let reused = 0, reads = 0;
  const { createIndexCodec } = await import("./indexCodec");
  const codec = createIndexCodec();
  try {
  // Bounded batches keep disk work and decoded text out of a whole-corpus peak.
  for (let offset = 0; offset < textDocuments.length && !stopped(); offset += 128) {
    const group = textDocuments.slice(offset, offset + 128);
    const candidates = group.filter(file => prior.has(file.relPath));
    let hashes: (string | null)[] = [];
    try { hashes = await fingerprints(candidates.map(f => f.relPath)); } catch { /* rebuild */ }
    if (stopped()) break;
    const reusable = new Map<string, string | null>();
    for (let i = 0; i < candidates.length; i++) {
      const file = candidates[i], entry = prior.get(file.relPath)!;
      try { if (hashes[i] === entry.digest && await integrity(entry) === entry.integrity) reusable.set(file.relPath, hashes[i]); } catch { /* corrupt entry is rebuilt */ }
    }
    const missing = group.filter(file => reusable.get(file.relPath) !== prior.get(file.relPath)?.digest || !prior.has(file.relPath));
    for (const file of group) {
      if (!missing.includes(file)) { entries.set(file.relPath, prior.get(file.relPath)!); reused++; }
    }
    for (const batch of indexReadBatches(missing)) {
    if (stopped()) break;
    const texts = await runCancellableBackgroundWork("index", () => read(batch), stopped);
    if (stopped()) break;
    const metadata = buildNotes(files, new Map(batch.map((f, i) => [f.relPath, texts[i] ?? ''])), new Set(batch.map(f => f.relPath)));
    const documents = await runCancellableBackgroundWork("index", () => codec.encode(texts), stopped);
    if (stopped()) break;
    for (let i = 0; i < batch.length; i++) {
      const file = batch[i], text = texts[i] ?? '';
      let sha = '';
      try { sha = await fingerprintText(text); } catch { /* not persisted/reused */ }
      const entry = { digest: sha, document: documents[i], note: metadata[file.relPath], integrity: '', imageTarget: extractLinksAndFirstImage(text).firstImage ?? undefined };
      try { entry.integrity = await integrity(entry); } catch { /* cache unavailable */ }
      entries.set(file.relPath, entry); reads++;
    }
    }
    // Yield between corpus batches, including all-cache-hit batches.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  } finally { codec.dispose(); }
  // Resolve image targets against today's file list, even when note bytes were reused.
  const resolveImage = createImageResolver(files);
  const notes: Record<string, NoteMeta> = {};
  for (const file of textDocuments) {
    const entry = entries.get(file.relPath);
    if (entry) notes[file.relPath] = { ...entry.note, relPath: file.relPath, title: file.name, firstImagePath: entry.imageTarget ? resolveImage(entry.imageTarget) : undefined };
  }
  if (!stopped() && (epochs.get(root) ?? 0) === epoch) {
    // One atomic IndexedDB transaction; failure never changes vault files.
    let persistedBytes = 0;
    const persisted = [...entries].filter(([, entry]) => {
      if (!valid(entry)) return false;
      const bytes = entry.document.bytes.byteLength + entry.document.bloom.byteLength + JSON.stringify([entry.note, entry.document.tasks]).length * 2;
      // A single snapshot cannot evict every other vault by itself. The
      // global transaction above decides cross-vault retention.
      if (persistedBytes + bytes > GLOBAL_INDEX_CACHE_BUDGET_BYTES) return false;
      persistedBytes += bytes; return true;
    });
    void storage.save({ version: VERSION, root, cachedAt: Date.now(), entries: persisted }).catch(() => {});
  }
  return { notes, cache: indexedContentCache([...entries].map(([rel, entry]) => [rel, entry.document])), reused, read: reads };
}

export async function forgetVaultIndex(root: string): Promise<void> {
  epochs.set(root, (epochs.get(root) ?? 0) + 1);
  try {
    const db = await database();
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('vaults', 'readwrite'); tx.objectStore('vaults').delete(root);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    }); } finally { db.close(); }
  } catch { /* unavailable storage holds no usable index */ }
}
