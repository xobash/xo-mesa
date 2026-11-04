/**
 * Bloom bit of the trigram at `i`: FNV-1a of three UTF-16 units, without a
 * substring. Stored index blooms depend on it; a change invalidates them.
 */
export function trigramBit(s: string, i: number): number {
  let h = Math.imul(2166136261 ^ s.charCodeAt(i), 16777619);
  h = Math.imul(h ^ s.charCodeAt(i + 1), 16777619);
  h = Math.imul(h ^ s.charCodeAt(i + 2), 16777619);
  return (h >>> 0) % 4096;
}
