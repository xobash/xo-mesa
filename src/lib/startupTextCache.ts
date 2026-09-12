import type { VaultFile } from "../types";
import { forEachConcurrent } from "./concurrency";

/** In-flight per-file reads on the per-file path. Large enough to keep local
 * storage busy, small enough to bound decoded response buffers and IPC
 * bookkeeping during vault open. */
export const STARTUP_TEXT_READ_CONCURRENCY = 16;

/**
 * Chunk reads in flight at once.
 *
 * A chunk is already read with native parallelism, so this is not a storage
 * throughput knob — it exists so the next batch's syscalls overlap the current
 * batch's decode/intern work on the JS side. Beyond a small number it only
 * raises peak memory.
 */
export const STARTUP_CHUNK_CONCURRENCY = 3;

/** Split `items` into fixed-size groups, preserving order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.trunc(size) || 1);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    out.push(items.slice(i, i + step));
  }
  return out;
}

/**
 * Read the vault's markdown into the content cache.
 *
 * `readChunk` is the bulk path: one IPC round-trip per group of files instead
 * of one per file (see `readVaultText` in `vault.ts` for why the round-trip
 * count, not the disk, is what this costs). `read` stays as the per-file
 * fallback for the browser demo and for shells without the native command.
 * Exactly one of them does the work; both produce the same map, and an
 * unreadable file yields `""` either way.
 */
export async function loadStartupTextCache(
  files: readonly VaultFile[],
  read: (file: VaultFile) => Promise<string>,
  concurrency = STARTUP_TEXT_READ_CONCURRENCY,
  /** Optional deduper — see `textInterner.ts`. Vaults duplicate text heavily,
   *  and one shared instance per distinct document is invisible to consumers. */
  intern: (text: string) => string = (text) => text,
  /** Abort a superseded vault-open generation without starting more reads. */
  stopped?: () => boolean,
  /** Bulk reader: resolves to one string per input file, in order. */
  readChunk?: (files: readonly VaultFile[]) => Promise<string[]>,
  chunkSize?: number,
  /** Bound overlapping bulk reads; remote mounts should use one. */
  chunkConcurrency?: number
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  if (readChunk && chunkSize) {
    const groups = chunk(files, chunkSize);
    await forEachConcurrent(
      groups,
      chunkConcurrency ?? STARTUP_CHUNK_CONCURRENCY,
      async (group) => {
        // Read first, then store — the same ordering rule as below.
        const texts = await readChunk(group);
        group.forEach((file, i) => {
          contents.set(file.relPath, intern(texts[i] ?? ""));
        });
      },
      stopped
    );
    return contents;
  }
  await forEachConcurrent(files, concurrency, async (file) => {
    // Read first, then store: `contents.set(k, await read(f))` would bind the
    // Map before suspending (harmless for a Map that is never replaced, but the
    // same shape silently dropped files in `searchCorpus.ts`).
    const text = await read(file);
    contents.set(file.relPath, intern(text));
  }, stopped);
  return contents;
}
