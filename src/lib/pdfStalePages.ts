/**
 * Which pages of the open PDF went stale, and therefore have to be redone.
 *
 * Mesa tracks this twice — once for repainting canvases, once for re-extracting
 * text runs — and both need the identical rule: a page-scoped edit invalidates
 * only the page it touched, while anything that can shift page indices
 * (structural edits, undo/redo, an external reload) invalidates the whole
 * document. Both consumers merge pending page sets through this implementation
 * so quick edits on different pages remain visible.
 *
 * `null`  — nothing recorded yet; the consumer does the whole document.
 * `"all"` — something happened that makes every page suspect.
 * `Set`   — exactly these zero-based pages are stale.
 */
export type StalePages = ReadonlySet<number> | "all" | null;

/**
 * Merge newly-stale pages into an accumulator.
 *
 * `"all"` always wins — once Mesa can no longer say which pages are still
 * trustworthy, narrowing back down to a subset would leave stale pixels (or,
 * worse, stale text-run hit boxes that place an edit on the wrong glyphs).
 */
export function addStalePages(
  current: StalePages,
  next: ReadonlySet<number> | "all"
): StalePages {
  if (next === "all" || current === "all") return "all";
  if (current === null) return new Set(next);
  const merged = new Set(current);
  for (const page of next) merged.add(page);
  return merged;
}

/**
 * The 1-based page numbers a pass should process, or `null` for "every page".
 *
 * Out-of-range pages are dropped: a stale set recorded before a structural edge
 * case can name a page the current document no longer has.
 */
export function stalePageNumbers(
  stale: StalePages,
  pageCount: number
): number[] | null {
  if (stale === null || stale === "all") return null;
  return [...stale]
    .filter((page) => Number.isInteger(page) && page >= 0 && page < pageCount)
    .sort((a, b) => a - b)
    .map((page) => page + 1);
}
