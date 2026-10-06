import type { VaultFile } from "../types";
import { forEachConcurrent } from "./concurrency";

/** In-flight per-file reads on the per-file path. Large enough to keep local
 * storage busy, small enough to bound decoded response buffers and IPC
 * bookkeeping during vault open. */
export const STARTUP_TEXT_READ_CONCURRENCY = 16;

/** Bound overlapping chunk reads so decoding and native I/O can overlap without unbounded buffers. */
const STARTUP_CHUNK_CONCURRENCY = 3;

/** Split `items` into fixed-size groups, preserving order. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.trunc(size) || 1);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    out.push(items.slice(i, i + step));
  }
  return out;
}

/** Compatibility Markdown loader with either batched or per-file reads; unreadable entries become empty strings.
 * Use the outcome-aware reader for editable baselines. */
export async function loadStartupTextCache(
  files: readonly VaultFile[],
  read: (file: VaultFile) => Promise<string>,
  concurrency = STARTUP_TEXT_READ_CONCURRENCY,
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
          contents.set(file.relPath, texts[i] ?? "");
        });
      },
      stopped
    );
    return contents;
  }
  await forEachConcurrent(files, concurrency, async (file) => {
    // Read before storing so the map contains only completed reads.
    const text = await read(file);
    contents.set(file.relPath, text);
  }, stopped);
  return contents;
}
