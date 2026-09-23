/**
 * Share one string instance between vault files whose text is byte-identical.
 *
 * Real vaults duplicate text heavily — exported chat logs, saved pages fetched
 * twice, generated reports, template copies. On the measured 4,165-file vault
 * **686 of the 2,452 cached files are an exact copy of another cached file**:
 * 9,775,294 characters, ~9.8 MB of the ~84 MB the content cache occupies. The
 * cache holds each of those as its own string, so the vault pays for the same
 * bytes hundreds of times.
 *
 * Sharing is invisible to every consumer because JS strings are immutable:
 * `searchVault` reads by value, the editor and save paths always build a NEW
 * string rather than mutating, and `searchMatch`'s eligibility memo compares by
 * value — where sharing actually helps, since a shared instance turns its
 * comparison into a reference hit.
 *
 * ## Why sampling instead of hashing
 *
 * Hashing the corpus would mean 61 M character reads at vault open. The bucket
 * key here is O(1) — length plus three 48-character samples — and it is only a
 * bucket key: candidates are confirmed with `===`, so a colliding key costs one
 * comparison and can never dedupe two different documents. `MAX_BUCKET` caps
 * the work a pathological bucket (many same-length files agreeing at all three
 * sample points) can do, at the cost of missing some duplicates — the wrong
 * direction is always "keep both copies", never "merge two files".
 */

/** Candidates compared per bucket before giving up and keeping a new instance. */
export const MAX_BUCKET = 8;

const SAMPLE = 48;

function bucketKey(text: string): string {
  if (text.length <= SAMPLE * 3) return `${text.length}|${text}`;
  const mid = (text.length >> 1) - (SAMPLE >> 1);
  return `${text.length}|${text.slice(0, SAMPLE)}|${text.slice(
    mid,
    mid + SAMPLE
  )}|${text.slice(-SAMPLE)}`;
}

export interface TextInterner {
  /** The canonical instance for `text` — always `=== text` in value. */
  intern(text: string): string;
  /** Files that reused an existing instance (what the vault stopped paying for). */
  readonly shared: number;
  /** Characters those files would otherwise have duplicated. */
  readonly sharedChars: number;
  /** Drop every retained instance. Call when the vault it was built for is gone. */
  clear(): void;
}

export function createTextInterner(): TextInterner {
  const buckets = new Map<string, string[]>();
  let shared = 0;
  let sharedChars = 0;
  return {
    intern(text: string): string {
      // An empty string is already shared by the engine and would collapse a
      // bucket key to nothing useful.
      if (!text) return text;
      const key = bucketKey(text);
      const bucket = buckets.get(key);
      if (!bucket) {
        buckets.set(key, [text]);
        return text;
      }
      for (const candidate of bucket) {
        if (candidate === text) {
          shared++;
          sharedChars += text.length;
          return candidate;
        }
      }
      if (bucket.length < MAX_BUCKET) bucket.push(text);
      return text;
    },
    get shared() {
      return shared;
    },
    get sharedChars() {
      return sharedChars;
    },
    clear() {
      buckets.clear();
    },
  };
}
