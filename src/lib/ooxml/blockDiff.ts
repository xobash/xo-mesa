// Bounded sequence diff (Myers, "An O(ND) Difference Algorithm", 1986) over
// interned block keys. Common prefix and suffix are trimmed first; the middle
// runs Myers up to `maxEdits` edit steps. Past that bound the whole middle is
// reported as replaced, so time stays O((N + M) * maxEdits) and memory
// O(maxEdits^2) whatever the input. No recursion.

export const BLOCK_DIFF_MAX_EDITS = 2_000;

export interface BlockMatch {
  /** For each index of `before`, the matched index of `after`, or -1 when removed. */
  readonly beforeToAfter: Int32Array;
  /** For each index of `after`, the matched index of `before`, or -1 when inserted. */
  readonly afterToBefore: Int32Array;
}

function intern(before: readonly string[], after: readonly string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const idOf = (key: string) => {
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    return id;
  };
  return [Int32Array.from(before, idOf), Int32Array.from(after, idOf)];
}

/** Myers forward pass on a[lo..], b[lo..]; returns the per-step frontier, or null past the bound. */
function myersTrace(a: Int32Array, b: Int32Array, aLo: number, aHi: number, bLo: number, bHi: number, maxEdits: number): Int32Array[] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const trace: Int32Array[] = [];
  const limit = Math.min(maxEdits, n + m);
  for (let d = 0; d <= limit; d++) {
    const v = new Int32Array(2 * d + 1);
    const prev = d > 0 ? trace[d - 1] : null;
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (!prev) x = 0;
      else if (k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1])) x = prev[k + 1 + d - 1];
      else x = prev[k - 1 + d - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) { x++; y++; }
      v[k + d] = x;
      if (x >= n && y >= m) { trace.push(v); return trace; }
    }
    trace.push(v);
  }
  return null;
}

function link(match: BlockMatch, i: number, j: number): void {
  match.beforeToAfter[i] = j;
  match.afterToBefore[j] = i;
}

/** Walks the trace back from (n, m), recording the matched diagonals. */
function backtrack(trace: Int32Array[], n: number, m: number, aLo: number, bLo: number, match: BlockMatch): void {
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[prevK + d - 1];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; link(match, aLo + x, bLo + y); }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { x--; y--; link(match, aLo + x, bLo + y); }
}

/** Matches equal keys of `before` and `after` in order (a longest common subsequence within the bound). */
export function diffBlocks(before: readonly string[], after: readonly string[], maxEdits = BLOCK_DIFF_MAX_EDITS): BlockMatch {
  const [a, b] = intern(before, after);
  const match: BlockMatch = { beforeToAfter: new Int32Array(a.length).fill(-1), afterToBefore: new Int32Array(b.length).fill(-1) };
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) { link(match, lo, lo); lo++; }
  let aHi = a.length;
  let bHi = b.length;
  while (aHi > lo && bHi > lo && a[aHi - 1] === b[bHi - 1]) { aHi--; bHi--; link(match, aHi, bHi); }
  if (aHi === lo || bHi === lo) return match;
  const trace = myersTrace(a, b, lo, aHi, lo, bHi, maxEdits);
  if (trace) backtrack(trace, aHi - lo, bHi - lo, lo, lo, match);
  return match;
}
