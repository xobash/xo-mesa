import { forkContentCache, compactDocument } from "./documentWorkingSet";
/**
 * Background hydration of the search-only half of the content cache.
 *
 * Vault open used to read EVERY textual file before the UI existed. On the
 * measured 4,165-file vault that is 2,394 reads / 60.6 M characters, of which
 * the non-markdown share — read for `searchVault` and nothing else — is
 * **1,673 files (70% of the reads), 45.1 MB, and 69% of the pure filesystem
 * read time** (436.9 ms of 635.8 ms in Node; more in the app, where each read
 * is a Tauri IPC round-trip). Markdown is different: `buildNotes` needs all of
 * it to produce the note graph, backlinks and tags the first paint renders.
 *
 * So markdown loads on the critical path and the rest streams in afterwards,
 * in batches, while the app is already usable. Search coverage is therefore
 * incomplete for a moment — `indexingTextFiles` says so out loud rather than
 * letting a search look exhaustive when it is not.
 */

import { forEachConcurrent } from "./concurrency";
import { runCancellableBackgroundWork } from "./backgroundWorkGovernor";
import { chunk, STARTUP_CHUNK_CONCURRENCY } from "./startupTextCache";
import { TEXT_CACHE_BUDGET_CHARS } from "./textCachePlan";

/** Chunk reads in flight during background hydration. Shared with the startup
 *  load so both phases put the same bounded pressure on storage. */
const CHUNK_CONCURRENCY = STARTUP_CHUNK_CONCURRENCY;

/**
 * Files merged into the store per commit. Small enough that a batch never
 * blocks a frame, large enough that a 1,673-file vault costs ~13 commits
 * instead of 1,673 (a per-file commit measured 576 ms for a 1,500-file change).
 */
export const SEARCH_CORPUS_BATCH = 128;

/**
 * Ceiling on the non-markdown text held in memory for search.
 *
 * The budget used to be applied to `size` from the vault scan, before any read.
 * That is no longer possible on the open path: the per-file stat pass is 93% of
 * the scan and now runs AFTER the first paint, so `openVault` plans without
 * sizes. Applying it to characters as they stream in is a better measure
 * anyway — a JS string's cost is its length, not its UTF-8 byte count — and it
 * needs no metadata at all. Files are hydrated in the same deterministic
 * `files` order `planTextCache` produced, so which files a given vault caches
 * stays stable across runs. The measured vault streams 47.1 M characters, well
 * under this, and caches everything.
 */
export { TEXT_CACHE_BUDGET_CHARS };

export interface TextBudgetSelection {
  accepted: Map<string, string>;
  usedChars: number;
  skipped: number;
}

/**
 * Keep a batch within the retained search-cache budget.
 *
 * A single huge file must not stop smaller later files from entering the cache.
 * Also, a completed chunk can contain many files, so the budget must be applied
 * per file before the batch reaches `contentCache`.
 */
export function selectTextWithinBudget(
  batch: ReadonlyMap<string, string>,
  usedChars: number,
  budgetChars: number
): TextBudgetSelection {
  const accepted = new Map<string, string>();
  let skipped = 0;
  let nextUsed = usedChars;
  batch.forEach((text, rel) => {
    if (nextUsed + text.length > budgetChars) {
      skipped++;
      return;
    }
    accepted.set(rel, text);
    nextUsed += text.length;
  });
  return { accepted, usedChars: nextUsed, skipped };
}

/**
 * Merge freshly read text into the content cache, keeping whatever the cache
 * already holds.
 *
 * Absent-only is the rule that makes background hydration safe: while it runs,
 * the same key can be filled by an editor edit, a watcher refresh, an agent
 * write, or a lazy `ensureContent` read — all of them newer than the bytes this
 * batch read. Overwriting would resurrect stale text and, for an edited file,
 * silently discard the edit.
 *
 * Returns the SAME object when nothing was added, so a no-op batch cannot churn
 * the cache identity (search drops its incremental narrowing whenever that
 * identity changes).
 */
export function mergeAbsentText(
  cache: Record<string, string>,
  batch: ReadonlyMap<string, string>
): Record<string, string> {
  let next: Record<string, string> | null = null;
  batch.forEach((text, rel) => {
    if (rel in cache) return;
    if (!next) next = forkContentCache(cache);
    next[rel] = text;
    compactDocument(next, rel, text);
  });
  return next ?? cache;
}

/**
 * Read `items` with bounded concurrency and hand the results over in batches.
 *
 * The batch buffer is owned here rather than by the caller because of a hazard
 * that is easy to write and silent when you do: in
 * `batch.set(key, await read(item))` JavaScript evaluates `batch.set` — binding
 * the CURRENT Map — before it suspends on the await. Any worker that resumes
 * after another worker flushed and replaced the buffer writes into the
 * discarded Map, and its file is lost. That cost 180 of 1,731 files on the
 * measured vault while `indexingTextFiles` still reported completion.
 * `streamTextBatches` reads first and buffers second, and
 * `searchCorpus.test.ts` pins it with staggered read latencies.
 *
 * `stopped()` is polled before each read and before each commit so a vault
 * switch abandons the remaining work without pouring the old vault's text into
 * the new one. A failing read calls `onError` and is skipped: one unreadable
 * file must not abort the rest.
 *
 * `readChunk` switches the unit of work from a file to a GROUP of files, so the
 * whole hydration costs one IPC round-trip per group instead of one per file
 * (see `readVaultText` in `vault.ts`). Everything else is unchanged: the same
 * buffer, the same `batchSize` commits, the same cancellation points. The
 * buffering rule matters more here, not less — a chunk resolves many files at
 * once, so binding the Map before the await would lose a whole group.
 */
export async function streamTextBatches<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  read: (item: T) => Promise<string>,
  options: {
    concurrency: number;
    batchSize: number;
    commit: (batch: Map<string, string>) => void;
    onError?: (item: T, error: unknown) => void;
    stopped?: () => boolean;
    /** Bulk reader: resolves to one string or null per input item, in order. */
    readChunk?: (items: readonly T[]) => Promise<(string | null)[]>;
    /** Items per `readChunk` call. Required for `readChunk` to be used. */
    chunkSize?: number;
    /** Bound overlapping bulk reads; remote mounts should use one. */
    chunkConcurrency?: number;
  }
): Promise<void> {
  const {
    concurrency,
    batchSize,
    commit,
    onError,
    stopped,
    readChunk,
    chunkSize,
    chunkConcurrency,
  } = options;
  let batch = new Map<string, string>();
  const flush = () => {
    if (!batch.size) return;
    const done = batch;
    batch = new Map();
    commit(done);
  };
  if (readChunk && chunkSize) {
    const groups = chunk(items, chunkSize);
    await forEachConcurrent(
      groups,
      chunkConcurrency ?? CHUNK_CONCURRENCY,
      async (group) => {
        if (stopped?.()) return;
        let texts: (string | null)[];
        try {
          texts = await runCancellableBackgroundWork("index", () => readChunk(group), () => Boolean(stopped?.()));
        } catch (error) {
          // A whole batch failing is reported per file, so the caller's
          // accounting (`indexingTextFiles`) stays a file count either way.
          for (const item of group) onError?.(item, error);
          return;
        }
        // Buffer only after the read has resolved — see the hazard above.
        group.forEach((item, i) => {
          const text = texts[i] ?? null;
          if (text == null) {
            onError?.(item, new Error("text read skipped"));
            return;
          }
          batch.set(keyOf(item), text);
        });
        if (batch.size >= batchSize) flush();
      },
      stopped
    );
    flush();
    return;
  }
  await forEachConcurrent(items, concurrency, async (item) => {
    if (stopped?.()) return;
    let text: string;
    try {
      text = await runCancellableBackgroundWork("index", () => read(item), () => Boolean(stopped?.()));
    } catch (error) {
      onError?.(item, error);
      return;
    }
    // Buffer only after the read has resolved — see the hazard above.
    batch.set(keyOf(item), text);
    if (batch.size >= batchSize) flush();
  }, stopped);
  flush();
}
