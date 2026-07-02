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
 * The substring of `next` that changed relative to `prev` (between the common
 * prefix and common suffix). Used to highlight exactly what's being edited in
 * the live preview. Returns a trimmed, length-capped plain snippet.
 */
export function changedSnippet(prev: string, next: string, cap = 160): string {
  if (next === prev) return "";
  const a = prev ?? "";
  const b = next ?? "";
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endB > start && endA > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const slice = b.slice(start, endB).trim();
  return slice.length > cap ? slice.slice(0, cap).trim() : slice;
}

export function changedLineStats(
  prev: string,
  next: string
): { added: number; removed: number } {
  if (prev === next) return { added: 0, removed: 0 };
  const a = prev.length ? prev.split(/\r?\n/) : [];
  const b = next.length ? next.split(/\r?\n/) : [];
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return {
    added: Math.max(0, endB - start),
    removed: Math.max(0, endA - start),
  };
}

const records = new Map<string, ActivityRec>();
let lastDecay = typeof performance !== "undefined" ? performance.now() : 0;

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
  rec.status = status;
  if (detail !== undefined) rec.detail = detail;
  if (stats) {
    rec.added = Math.max(0, stats.added ?? 0);
    rec.removed = Math.max(0, stats.removed ?? 0);
  }
  records.set(id, rec);
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
