/** Read and promote an entry in a Map-backed least-recently-used cache. */
export function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key) as V;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

/** Insert/promote an entry and evict the least-recently-used entries. */
export function lruSet<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number
): void {
  cache.delete(key);
  cache.set(key, value);
  const limit = Math.max(0, Math.trunc(maxEntries));
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}
