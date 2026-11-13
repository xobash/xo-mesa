/** Escape every RegExp metacharacter so `value` matches only itself. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
