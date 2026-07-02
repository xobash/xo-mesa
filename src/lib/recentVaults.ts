import { canonicalRoot } from "./vault";

/** Add a vault to the recent list (canonicalized, most-recent first, deduped). */
export function rememberRecentVault(
  recents: string[],
  root: string,
  maxRecents: number,
  demoRoot: string
): string[] {
  const target = canonicalRoot(root);
  if (!target || target === canonicalRoot(demoRoot)) return recents;
  const rest = recents.filter((r) => canonicalRoot(r) !== target);
  return [target, ...rest].slice(0, maxRecents);
}

/** Remove a vault from the recent list, matching by canonical path so a
 *  backslash/forward-slash or trailing-slash difference still removes it. */
export function forgetRecentVault(recents: string[], root: string): string[] {
  const target = canonicalRoot(root);
  return recents.filter((r) => canonicalRoot(r) !== target);
}
