import { isIndexedCache } from "./documentWorkingSet";
import type { VaultFile } from "../types";

/** The predicate must match `isTextualVaultFile` — passed in to keep this
 *  module free of the vault's Tauri imports. */
export type TextualPredicate = (file: {
  ext: string;
  isMarkdown?: boolean;
}) => boolean;


/**
 * One non-markdown text file may not consume the whole search cache or native
 * response buffer by itself. Markdown stays exempt because `buildNotes` owns
 * that startup contract.
 */
export const MAX_TEXT_CACHE_FILE_BYTES = 8 * 1024 * 1024;

/** Character budget for the lazy, non-markdown cache. Markdown remains pinned
 * because the note graph and the active editor own that content. */
export const TEXT_CACHE_BUDGET_CHARS = 64 * 1024 * 1024;

/**
 * Bound text added by lazy viewers and previews without evicting markdown or
 * content that the active editor/save coordinator still owns. Recency is kept
 * by the store so this pure helper does not retain vault data itself.
 */
export function retainLazyTextCache(
  cache: Record<string, string>,
  files: readonly VaultFile[],
  isTextual: TextualPredicate,
  recency: Map<string, number>,
  pinned: ReadonlySet<string>,
  budgetChars: number = TEXT_CACHE_BUDGET_CHARS
): Record<string, string> {
  // Indexed documents retain compressed search coverage; only decoded text is evicted.
  if (isIndexedCache(cache)) return cache;
  const fileByRel = new Map(files.map((file) => [file.relPath, file]));
  const candidates: { relPath: string; chars: number; order: number }[] = [];
  let usedChars = 0;
  let seed = 0;

  for (const [relPath, text] of Object.entries(cache)) {
    const file = fileByRel.get(relPath);
    if (!file || file.isMarkdown || !isTextual(file)) continue;
    if (!recency.has(relPath)) recency.set(relPath, seed++);
    const chars = text.length;
    usedChars += chars;
    candidates.push({
      relPath,
      chars,
      order: recency.get(relPath) ?? 0,
    });
  }

  if (usedChars <= budgetChars) return cache;

  candidates.sort((a, b) => a.order - b.order);
  let next: Record<string, string> | null = null;
  for (const candidate of candidates) {
    if (usedChars <= budgetChars) break;
    if (pinned.has(candidate.relPath)) continue;
    if (!next) next = { ...cache };
    delete next[candidate.relPath];
    recency.delete(candidate.relPath);
    usedChars -= candidate.chars;
  }
  return next ?? cache;
}
