/**
 * localStorage key migration — pure planning logic.
 *
 * Kept DOM-free (no `localStorage` access here) so it's unit-testable; `store.ts`
 * gathers the real keys, calls `planKeyMigration`, and applies the result. Used
 * for the rename that moved persisted settings from the old `telperion:` prefix
 * to `mesa:` without losing anyone's theme, last vault, settings, or tour state.
 */
export interface KeyMove {
  from: string;
  to: string;
}

/**
 * Plan the copies needed to move keys under `fromPrefix` to `toPrefix`.
 *
 * - Only keys that start with `fromPrefix` are considered.
 * - A target key that already exists is left alone (newer data wins), so this is
 *   safe to run on every load and is idempotent once migrated.
 */
export function planKeyMigration(
  keys: string[],
  fromPrefix: string,
  toPrefix: string,
  exists: (key: string) => boolean
): KeyMove[] {
  const moves: KeyMove[] = [];
  for (const key of keys) {
    if (!key.startsWith(fromPrefix)) continue;
    const to = toPrefix + key.slice(fromPrefix.length);
    if (!exists(to)) moves.push({ from: key, to });
  }
  return moves;
}
