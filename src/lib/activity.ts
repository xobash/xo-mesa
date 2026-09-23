/**
 * Keystroke activity tracker.
 *
 * Lives outside React on purpose: keystrokes fire dozens of times a second and
 * we don't want each one to re-render the app. The editor calls `bumpActivity`
 * on every change; the graph's animation loop samples `getActivity` per frame
 * to make the matching node flicker and glow, then calls `decayActivity` so the
 * effect fades once you stop typing.
 */
/** What kind of access is happening — drives the status face/label on the card. */
export type ActivityOp = "read" | "edit" | "write" | "create";

export interface ActivityRec {
  /** Recent burst amplitude (0..~1.8). Drives glow size / flicker depth. */
  intensity: number;
  /** EMA of keystrokes per second. Drives flicker *speed*. */
  rate: number;
  /** Timestamp (ms) of the last keystroke. */
  last: number;
  /** Most recent operation on this node. */
  op: ActivityOp;
  /** Optional free-text status from an agent (e.g. "computing…"). */
  status?: string;
  /** The chunk being read/edited/created — highlighted in the live card. */
  detail?: string;
  /** Line-level delta for GPT-style live counters. */
  added?: number;
  removed?: number;
}

/**
 * Shared prefix/suffix scans for the per-keystroke diff below. These run on
 * EVERY editor change over the full previous/next text, so they must not walk
 * the document one `a[i] === b[i]` character at a time — that cost 4.2 ms per
 * keystroke on a real 420 kB note. Comparing 2 KiB native substrings first
 * (memcmp speed) and narrowing only the mismatching block per character gives
 * the same answer in ~0.2 ms. Block size is deliberately small: larger blocks
 * were measured slower because the throwaway substring allocations dominate.
 */
const CHANGE_SCAN_BLOCK = 2048;

/** Length of the longest common prefix of `a` and `b`. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let lo = 0;
  while (
    lo + CHANGE_SCAN_BLOCK <= max &&
    a.startsWith(b.substring(lo, lo + CHANGE_SCAN_BLOCK), lo)
  )
    lo += CHANGE_SCAN_BLOCK;
  const end = Math.min(max, lo + CHANGE_SCAN_BLOCK);
  while (lo < end && a.charCodeAt(lo) === b.charCodeAt(lo)) lo++;
  return lo;
}

/**
 * Length of the longest common suffix of `a` and `b` that does not overlap
 * the first `start` characters of either string — the same clamp the
 * character loop had (`endA > start && endB > start`), so an edit inside a
 * repeated region resolves to the identical changed span.
 */
function commonSuffixLength(a: string, b: string, start: number): number {
  const max = Math.min(a.length, b.length) - start;
  let n = 0;
  while (
    n + CHANGE_SCAN_BLOCK <= max &&
    a.substring(a.length - n - CHANGE_SCAN_BLOCK, a.length - n) ===
      b.substring(b.length - n - CHANGE_SCAN_BLOCK, b.length - n)
  )
    n += CHANGE_SCAN_BLOCK;
  const end = Math.min(max, n + CHANGE_SCAN_BLOCK);
  while (n < end && a.charCodeAt(a.length - 1 - n) === b.charCodeAt(b.length - 1 - n))
    n++;
  return n;
}

/**
 * The substring of `next` that changed relative to `prev` (between the common
 * prefix and common suffix). Used to highlight exactly what's being edited in
 * the live preview. Returns a trimmed, length-capped plain snippet.
 * `activity.test.ts` pins equivalence with the original per-character scan
 * over randomized edit shapes.
 */
export function changedSnippet(prev: string, next: string, cap = 160): string {
  if (next === prev) return "";
  const a = prev ?? "";
  const b = next ?? "";
  const start = commonPrefixLength(a, b);
  const endB = b.length - commonSuffixLength(a, b, start);
  const slice = b.slice(start, endB).trim();
  return slice.length > cap ? slice.slice(0, cap).trim() : slice;
}

export function changedLineStats(
  prev: string,
  next: string
): { added: number; removed: number } {
  if (prev === next) return { added: 0, removed: 0 };
  if (!prev.length) {
    let n = 0;
    for (let i = 0; i < next.length; i++) if (next.charCodeAt(i) === 10) n++;
    return { added: n + 1, removed: 0 };
  }
  if (!next.length) {
    let n = 0;
    for (let i = 0; i < prev.length; i++) if (prev.charCodeAt(i) === 10) n++;
    return { added: 0, removed: n + 1 };
  }
  const cStart = commonPrefixLength(prev, next);
  const suf = commonSuffixLength(prev, next, cStart);
  let lo = cStart;
  while (lo > 0 && prev.charCodeAt(lo - 1) !== 10) lo--;
  const endA = prev.length - suf;
  const endB = next.length - suf;
  let ext = 0;
  while (ext < suf && prev.charCodeAt(endA + ext) !== 10) ext++;
  if (ext < suf) ext++;
  const a = prev.substring(lo, endA + ext).split(/\r?\n/);
  const b = next.substring(lo, endB + ext).split(/\r?\n/);
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let eA = a.length;
  let eB = b.length;
  while (eA > start && eB > start && a[eA - 1] === b[eB - 1]) {
    eA--;
    eB--;
  }
  return {
    added: Math.max(0, eB - start),
    removed: Math.max(0, eA - start),
  };
}

const records = new Map<string, ActivityRec>();
let lastDecay = typeof performance !== "undefined" ? performance.now() : 0;

/** Activity is a transient visual signal, not a session history. */
export const ACTIVITY_MAX_RECORDS = 4096;
const ACTIVITY_TEXT_MAX = 512;

function boundedActivityText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > ACTIVITY_TEXT_MAX
    ? value.slice(0, ACTIVITY_TEXT_MAX)
    : value;
}

/** Register activity for a note id, adding a custom intensity amount and tagging
 * it with an operation (read/edit/write/create) and optional status text.
 *
 * Design: one keystroke / one word read = one short flicker. Intensity is NOT
 * an accumulator that builds up over a typing burst — each bump produces a
 * brief blip that decays quickly (fast time constant below) so the graph
 * reacts per-edit and stops the moment you stop. `rate` still tracks the EMA
 * of events/sec so faster typing flickers faster. */
export function bumpActivityAmount(
  id: string,
  amount: number,
  op: ActivityOp = "edit",
  status?: string,
  detail?: string,
  stats?: { added?: number; removed?: number }
): void {
  if (!id) return;
  const now = performance.now();
  const rec = records.get(id) ?? { intensity: 0, rate: 0, last: now, op };
  const dt = Math.max(1, now - rec.last);
  const inst = Math.min(20, 1000 / dt); // events/sec, capped
  rec.rate = rec.rate * 0.7 + inst * 0.3;
  // Each edit is a discrete blip. Take the max of the incoming amount and the
  // (already-decayed) residual so rapid typing keeps the flicker crisp without
  // accumulating into a long-tail glow that lingers after you stop.
  rec.intensity = Math.min(1, Math.max(rec.intensity, amount));
  rec.last = now;
  rec.op = op;
  rec.status = boundedActivityText(status);
  if (detail !== undefined) rec.detail = boundedActivityText(detail);
  if (stats) {
    rec.added = Math.max(0, stats.added ?? 0);
    rec.removed = Math.max(0, stats.removed ?? 0);
  }
  records.set(id, rec);
  // GraphView normally reclaims faded records every frame, but activity can
  // arrive while that optional surface is closed. Keep the module-level map
  // bounded even during a long Pi session with many unique paths.
  while (records.size > ACTIVITY_MAX_RECORDS) {
    let oldestId: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [candidateId, candidate] of records) {
      if (candidate.last < oldest) {
        oldest = candidate.last;
        oldestId = candidateId;
      }
    }
    if (oldestId === undefined) break;
    records.delete(oldestId);
  }
}

/** Register a single keystroke for a note id (counts as an edit). */
export function bumpActivity(id: string): void {
  bumpActivityAmount(id, 0.6, "edit");
}

export function getActivity(id: string): ActivityRec | undefined {
  return records.get(id);
}

/**
 * Every node currently "alive" (intensity above a small threshold), strongest
 * first — used to float a live preview card over each file being read/edited/
 * written/created.
 */
export function activeRecords(
  minIntensity = 0.05
): { id: string; rec: ActivityRec }[] {
  const out: { id: string; rec: ActivityRec }[] = [];
  for (const [id, rec] of records) {
    if (rec.intensity >= minIntensity) out.push({ id, rec });
  }
  out.sort((a, b) => b.rec.intensity - a.rec.intensity);
  return out;
}

/** Exponential decay of every record. Call once per animation frame. */
export function decayActivity(now: number): void {
  const dt = now - lastDecay;
  lastDecay = now;
  if (dt <= 0) return;
  // Fast intensity decay so one edit = one short flicker that ends promptly,
  // with no residual glow after typing stops. Rate fades a little slower so
  // the *speed* of a fast burst still reads during the brief blip.
  const ki = Math.exp(-dt / 220); // intensity time constant ~0.22s
  const kr = Math.exp(-dt / 600); // rate fades a little slower
  for (const [id, rec] of records) {
    rec.intensity *= ki;
    rec.rate *= kr;
    if (rec.intensity < 0.002 && rec.rate < 0.05) records.delete(id);
  }
}
