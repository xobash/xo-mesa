import type { VaultFile } from "../types";

/**
 * Which files' text `openVault` loads into the content cache.
 *
 * Vault search reads `contentCache[relPath]` for EVERY scanned file, but the
 * cache was populated for `isMarkdown` files only. Every other file the text
 * pipeline owns — `.txt`, `.html`, `.py`, `.json`, `.csv`, … — could therefore
 * only ever match on its NAME, and a phrase sitting in a `.txt` returned
 * nothing. It was also inconsistent rather than merely incomplete: opening such
 * a file caches it lazily (`ensureContent`), so the same query returned more
 * hits later in a session than it did at open.
 *
 * Loading that text costs memory, so the extra files are budgeted. Markdown is
 * never budgeted — it is the note corpus, and `buildNotes` needs all of it.
 *
 * The plan is computed from the scan's `size` metadata BEFORE any read, so no
 * file is read only to be discarded, and it walks `files` in their existing
 * sorted order, which makes the selected set deterministic rather than
 * dependent on which reads happen to resolve first.
 */

/** The predicate must match `isTextualVaultFile` — passed in to keep this
 *  module free of the vault's Tauri imports. */
export type TextualPredicate = (file: {
  ext: string;
  isMarkdown?: boolean;
}) => boolean;

export interface TextCachePlan {
  /** Non-markdown textual files whose content should be read at vault open. */
  extra: VaultFile[];
  /** Textual files left out because the budget was exhausted. */
  skipped: number;
  /** Bytes the planned extra reads account for (unknown sizes count as 0). */
  bytes: number;
}

/**
 * Default budget for non-markdown text. Large enough for real vaults (a
 * 4,165-file vault with 1,506 `.txt` needed ~30 MB) while keeping a
 * pathological folder of huge logs from being pulled into memory wholesale.
 */
export const TEXT_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

export function planTextCache(
  files: readonly VaultFile[],
  isTextual: TextualPredicate,
  budgetBytes: number = TEXT_CACHE_BUDGET_BYTES
): TextCachePlan {
  const extra: VaultFile[] = [];
  let bytes = 0;
  let skipped = 0;
  for (const f of files) {
    if (f.isMarkdown) continue; // always cached, never budgeted
    if (!isTextual(f)) continue; // binaries never enter the text pipeline
    // A file whose stat failed has no size; count it as 0 rather than guessing
    // high and silently dropping it. Sizes come from the same scan, so the
    // budget is evaluated against real bytes in every normal case.
    const size = f.size ?? 0;
    if (bytes + size > budgetBytes) {
      skipped++;
      continue;
    }
    bytes += size;
    extra.push(f);
  }
  return { extra, skipped, bytes };
}
