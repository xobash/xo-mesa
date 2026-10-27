/** Raw ASCII matching preserves lowercase-search semantics with Kelvin-sign and dotted-I handling.
 * Non-ASCII terms use the lowercase path; snippet offsets always refer to raw text. */

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
  // eslint-disable-next-line no-control-regex -- The fast path accepts ASCII terms only.
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

/** Return first offset and non-overlapping count. Reset the shared fixed-width matcher before each file;
 * match start is lastIndex minus pattern width. */
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

/** Characters inspected per resumable step; bounded windows allow intra-file yields. */
const RAW_SCAN_CHUNK_CHARS = 64 * 1024;

export interface IncrementalRawScan {
  /** Inspect one bounded text window. True means that the file is complete. */
  advance(): boolean;
  /** The exact result. Only meaningful after `advance()` returns true. */
  result(): RawScan;
}

/**
 * Resumable equivalent of `scanRaw` for a fixed-width matcher.
 *
 * Each window includes `width - 1` trailing characters so a match that starts
 * before the boundary and ends after it is visible. A match belongs to the
 * window in which it STARTS. `nextAllowed` carries the global regex's
 * non-overlap position across boundaries, so a second window cannot count an
 * overlap that one unsliced regex pass would skip.
 */
export function createIncrementalRawScan(
  raw: string,
  re: RegExp,
  width: number,
  chunkChars = RAW_SCAN_CHUNK_CHARS
): IncrementalRawScan {
  if (chunkChars < 1) throw new Error("chunkChars must be positive");
  let chunkStart = 0;
  let nextAllowed = 0;
  let first = -1;
  let count = 0;
  let finished = raw.length === 0;

  return {
    advance(): boolean {
      if (finished) return true;
      const primaryEnd = Math.min(raw.length, chunkStart + chunkChars);
      const extendedEnd = Math.min(
        raw.length,
        primaryEnd + Math.max(0, width - 1)
      );
      const segment = raw.slice(chunkStart, extendedEnd);
      re.lastIndex = Math.max(0, nextAllowed - chunkStart);
      while (re.test(segment)) {
        const start = chunkStart + re.lastIndex - width;
        // The overlap only makes a boundary-spanning match visible. A match
        // that starts in the next window belongs to that window.
        if (primaryEnd < raw.length && start >= primaryEnd) break;
        if (start < nextAllowed) continue;
        if (first < 0) first = start;
        count++;
        nextAllowed = start + width;
        if (width === 0) re.lastIndex++;
      }
      chunkStart = primaryEnd;
      finished = chunkStart >= raw.length;
      return finished;
    },
    result(): RawScan {
      return { first, count };
    },
  };
}

/** Whether `raw` can use the fast path at all (see `LENGTH_CHANGING_CHAR`). */
export function canScanRaw(raw: string): boolean {
  return raw.indexOf(LENGTH_CHANGING_CHAR) < 0;
}

/** Check raw-search eligibility without retaining source strings or keys. */
export function canScanRawFor(_key: string, raw: string): boolean {
  return canScanRaw(raw);
}

/** Compatibility hook for existing vault-open callers; no state is retained. */
export function resetSearchEligibility(): void {}
