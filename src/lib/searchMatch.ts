/**
 * Allocation-free case-insensitive matching for vault search.
 *
 * `searchVault` used to do `raw.toLowerCase()` on every scanned file on every
 * keystroke. That allocates a full copy of the corpus per character typed —
 * affordable when only markdown was cached, ruinous once every textual file is
 * (a real vault: 61 M characters, ~290 ms for one cold pass). This module
 * matches against the RAW text instead, so nothing is copied.
 *
 * ## Why a character class is exactly equivalent to lowercasing
 *
 * The legacy predicate is `raw.toLowerCase().indexOf(termLower)`. Over the
 * whole BMP there are exactly two code points that make lowercasing anything
 * other than a per-code-unit ASCII fold (both verified exhaustively in
 * `searchMatch.test.ts`):
 *
 *   - **U+212A KELVIN SIGN** is the ONLY non-ASCII code point whose
 *     `toLowerCase()` is an ASCII string (`"k"`). It is length-preserving, so
 *     folding it into the `k` character class reproduces it exactly.
 *   - **U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE** is the ONLY code point
 *     whose lowercase is longer than one unit (`"i̇"`). Length changes
 *     shift every subsequent index, so any text containing it takes the exact
 *     legacy path instead of the fast one.
 *
 * With those two handled, `toLowerCase()` is a pure per-code-unit map and an
 * ASCII term's character class is equivalent by construction.
 *
 * Matching on raw text also fixes a latent defect: the old code took `idx` from
 * the LOWERED string and sliced the RAW string with it, so a note containing
 * U+0130 before the hit produced a snippet cut at the wrong offset.
 */

/** The one code point whose lowercase is longer than itself. Text containing
 *  it cannot use the fast path, because raw and lowered indices diverge. */
export const LENGTH_CHANGING_CHAR = "İ";

/** The one non-ASCII code point that lowercases into ASCII (`"k"`). */
const KELVIN_SIGN = "K";

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function escapeLiteral(ch: string): string {
  return ch.replace(REGEX_SPECIAL, "\\$&");
}

/**
 * A global regex matching `termLower` case-insensitively against RAW text, or
 * `null` when the term is not plain ASCII and the caller must use the exact
 * `toLowerCase()` path.
 *
 * `termLower` must already be lowercased (what `searchVault` produces).
 */
export function buildRawMatcher(termLower: string): RegExp | null {
  if (!termLower) return null;
  // Non-ASCII terms carry the full complexity of Unicode case folding; they are
  // rare and stay on the exact path rather than being approximated here.
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]+$/.test(termLower)) return null;

  let pattern = "";
  for (const ch of termLower) {
    if (ch >= "a" && ch <= "z") {
      const upper = ch.toUpperCase();
      // `k` additionally accepts U+212A, whose lowercase IS "k".
      pattern +=
        ch === "k" ? `[kK${KELVIN_SIGN}]` : `[${ch}${upper}]`;
    } else {
      pattern += escapeLiteral(ch);
    }
  }
  return new RegExp(pattern, "g");
}

export interface RawScan {
  /** Index of the first match in the RAW string, or -1. */
  first: number;
  /** Non-overlapping match count — the value that ranks results. */
  count: number;
}

/**
 * One pass over `raw`, returning both the first match offset and the total
 * count. `re` must be the global regex from `buildRawMatcher`; its `lastIndex`
 * is reset here, so a single matcher can be reused across every file.
 *
 * Uses `test`, not `exec`: `exec` allocates a result array per match, and a
 * common two-letter term hits hundreds of thousands of times across a real
 * vault. `test` allocates nothing and still advances `lastIndex`, and because
 * `buildRawMatcher` only ever emits fixed-width patterns (one character class
 * or one escaped literal per ASCII character of the term), the match start is
 * exactly `lastIndex - width`.
 */
export function scanRaw(raw: string, re: RegExp, width: number): RawScan {
  re.lastIndex = 0;
  let first = -1;
  let count = 0;
  while (re.test(raw)) {
    if (first < 0) first = re.lastIndex - width;
    count++;
    // A zero-width pattern cannot occur for a non-empty term, but guard so a
    // future pattern change can never spin forever.
    if (width === 0) re.lastIndex++;
  }
  return { first, count };
}

/** Whether `raw` can use the fast path at all (see `LENGTH_CHANGING_CHAR`). */
export function canScanRaw(raw: string): boolean {
  return raw.indexOf(LENGTH_CHANGING_CHAR) < 0;
}

/**
 * Eligibility memo, keyed by a caller-stable id (the file's `relPath`).
 *
 * `canScanRaw` is a full pass over the file's text, and it ran for every
 * scanned file on every keystroke — yet its answer depends only on the TEXT,
 * never on the query. On a real vault that was 13.5 ms of a 66.8 ms search pass
 * (20.2%) spent re-proving the same thing about 2,452 files, of which exactly
 * **2** actually contain U+0130.
 *
 * Correctness rests on reference equality, not on a heuristic: the content cache
 * hands out the same string instance until a file's text actually changes, and a
 * changed file produces a different instance, so a stale answer is unreachable.
 * A miss simply recomputes. The retained strings are the ones the content cache
 * already holds, so this adds entry overhead only (~2,452 small objects here);
 * `resetSearchEligibility` drops them when the vault changes.
 */
const eligibility = new Map<string, { text: string; ok: boolean }>();

export function canScanRawFor(key: string, raw: string): boolean {
  const hit = eligibility.get(key);
  if (hit !== undefined && hit.text === raw) return hit.ok;
  const ok = canScanRaw(raw);
  eligibility.set(key, { text: raw, ok });
  return ok;
}

/** Drop the memo so a closed vault's text is not retained by it. */
export function resetSearchEligibility(): void {
  eligibility.clear();
}
