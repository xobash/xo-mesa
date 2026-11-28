import { dominantLineBreak, lineBreaksOf, withLineBreak } from "./lineEndings";

/**
 * Lines keep their own break. Lines that differ only in CRLF/LF/CR match as
 * "same" (a Mac↔Windows round trip must not look like every line changed);
 * `lineEndingOnly` counts them so the review can say so out loud. Whether a
 * line HAS a break still counts, so an added final newline is a change.
 */
export type TextDiffPart =
  | { kind: "same"; lines: string[]; lineEndingOnly?: number }
  | { kind: "change"; original: string[]; other: string[] };

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const matchKey = (line: string) => line.replace(/\r\n?$/, "\n");

/** Lines shown as unchanged whose line endings differ between the copies. */
export function lineEndingOnlyLines(parts: readonly TextDiffPart[]): number {
  let count = 0;
  for (const part of parts) if (part.kind === "same") count += part.lineEndingOnly ?? 0;
  return count;
}

/** Largest line-comparison table the exact method may fill (cells). Above it the scripted method runs. */
export const DIFF_TABLE_CELL_LIMIT = 8 * 1024 * 1024;
/** Most changed lines the scripted method follows before it reports one whole change. */
export const DIFF_SCRIPT_CHANGE_LIMIT = 2048;

/** One number per distinct line, so a comparison is a number comparison. */
function lineIds(a: readonly string[], b: readonly string[]): { idsA: Int32Array; idsB: Int32Array } {
  const ids = new Map<string, number>();
  const idOf = (line: string) => {
    let id = ids.get(line);
    if (id === undefined) { id = ids.size; ids.set(line, id); }
    return id;
  };
  const idsA = Int32Array.from(a, idOf);
  return { idsA, idsB: Int32Array.from(b, idOf) };
}

/** Diff steps in order: both lines kept, an original line, or a line of the other copy. */
type Step = (same: (i: number, j: number) => void, removed: (i: number) => void, added: (j: number) => void) => void;

/**
 * Longest-common-subsequence table over `a[from..]` and `b[from..]`. Its tie
 * choices are the reference behavior (`textDiff.test.ts`). The table has
 * (lines of a + 1) x (lines of b + 1) cells, so the caller bounds it.
 */
function tableSteps(a: Int32Array, b: Int32Array, from: number): Step {
  const columns = b.length - from + 1;
  const cells = (a.length - from + 1) * columns;
  // An LCS cannot exceed the shorter side, which the cell limit keeps far below 65,536.
  const dp = new Uint16Array(cells);
  for (let i = a.length - 1; i >= from; i--) {
    const row = (i - from) * columns;
    const nextRow = row + columns;
    for (let j = b.length - 1; j >= from; j--) {
      const col = j - from;
      dp[row + col] = a[i] === b[j] ? dp[nextRow + col + 1] + 1 : Math.max(dp[nextRow + col], dp[row + col + 1]);
    }
  }
  return (same, removed, added) => {
    let i = from, j = from;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) same(i++, j++);
      else if (j >= b.length || (i < a.length && dp[(i + 1 - from) * columns + j - from] >= dp[(i - from) * columns + j + 1 - from])) removed(i++);
      else added(j++);
    }
  };
}

/**
 * Shortest edit script (E. W. Myers, "An O(ND) Difference Algorithm and Its
 * Variations", 1986) over `a[from..endA)` and `b[from..endB)`. Work and
 * memory grow with the number of changed lines, not with the product of the
 * two lengths. `null` when the copies differ by more than `limit` lines.
 */
function scriptSteps(a: Int32Array, b: Int32Array, from: number, endA: number, endB: number, limit: number): Step | null {
  const n = endA - from;
  const m = endB - from;
  const max = Math.min(n + m, limit);
  const furthest = new Int32Array(2 * max + 3);
  const rounds: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    rounds.push(furthest.slice(max + 1 - d, max + 2 + d));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && furthest[max + k] < furthest[max + k + 2]);
      let x = down ? furthest[max + k + 2] : furthest[max + k] + 1;
      let y = x - k;
      while (x < n && y < m && a[from + x] === b[from + y]) { x++; y++; }
      furthest[max + 1 + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  // Walk back from the end; `kinds` holds the steps last to first (0 same, 1 removed, 2 added).
  const kinds = new Uint8Array(n + m);
  let count = 0;
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const before = rounds[d]; // diagonals -d..d as they stood before round d; index k + d
    const k = x - y;
    const down = k === -d || (k !== d && before[k - 1 + d] < before[k + 1 + d]);
    const previousX = down ? before[k + 1 + d] : before[k - 1 + d];
    const previousY = previousX - (down ? k + 1 : k - 1);
    while (x > previousX && y > previousY) { kinds[count++] = 0; x--; y--; }
    kinds[count++] = down ? 2 : 1;
    x = previousX; y = previousY;
  }
  for (; x > 0; x--) kinds[count++] = 0;
  return (same, removed, added) => {
    let i = from, j = from;
    for (let at = count - 1; at >= 0; at--) {
      if (kinds[at] === 0) same(i++, j++);
      else if (kinds[at] === 1) removed(i++);
      else added(j++);
    }
  };
}

/** Steps for copies too large for the table: the shared end is matched first, then the script. */
function largeSteps(a: Int32Array, b: Int32Array, from: number): Step {
  let endA = a.length, endB = b.length;
  while (endA > from && endB > from && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const middle = scriptSteps(a, b, from, endA, endB, DIFF_SCRIPT_CHANGE_LIMIT);
  return (same, removed, added) => {
    if (middle) middle(same, removed, added);
    else {
      // Too many changed lines to align: one change holds both middles.
      for (let i = from; i < endA; i++) removed(i);
      for (let j = from; j < endB; j++) added(j);
    }
    for (let i = endA, j = endB; i < a.length; i++, j++) same(i, j);
  };
}

/**
 * Line diff of two copies. Up to `DIFF_TABLE_CELL_LIMIT` it is the exact
 * table method. Above it (about 2,900 differing-region lines a side) the
 * table would take seconds and hundreds of megabytes on the interface
 * thread, so a shortest edit script is used: an equally small diff whose
 * choice between equal alignments of repeated lines may differ.
 */
export function diffTextLines(original: string, other: string): TextDiffPart[] {
  const rawA = splitLines(original);
  const rawB = splitLines(other);
  const { idsA: a, idsB: b } = lineIds(rawA.map(matchKey), rawB.map(matchKey));
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  const cells = (a.length - prefix + 1) * (b.length - prefix + 1);
  const steps = cells <= DIFF_TABLE_CELL_LIMIT ? tableSteps(a, b, prefix) : largeSteps(a, b, prefix);
  const parts: TextDiffPart[] = [];
  const pushSame = (index: number, otherIndex: number) => {
    const line = rawA[index];
    const eolOnly = line !== rawB[otherIndex];
    let last = parts[parts.length - 1];
    if (last?.kind === "same") last.lines.push(line);
    else parts.push(last = { kind: "same", lines: [line] });
    if (eolOnly && last.kind === "same") last.lineEndingOnly = (last.lineEndingOnly ?? 0) + 1;
  };
  const pushChange = (originalLine?: string, otherLine?: string) => {
    const last = parts[parts.length - 1];
    const part = last?.kind === "change" ? last : null;
    const target = part ?? { kind: "change" as const, original: [], other: [] };
    if (originalLine !== undefined) target.original.push(originalLine);
    if (otherLine !== undefined) target.other.push(otherLine);
    if (!part) parts.push(target);
  };
  for (let k = 0; k < prefix; k++) pushSame(k, k);
  steps(pushSame, (i) => pushChange(rawA[i], undefined), (j) => pushChange(undefined, rawB[j]));
  return parts.filter(part => part.kind === "same" ? part.lines.length : part.original.length || part.other.length);
}

export function applyTextDiffChoice(draft: string, part: TextDiffPart, choice: "original" | "other"): string {
  if (part.kind !== "change") return draft;
  const from = part.original.join("");
  // Applied lines take the draft's dominant break, so picking one change never
  // turns a CRLF draft into a mixed file.
  const draftBreaks = lineBreaksOf(draft);
  const lineBreak = dominantLineBreak(draftBreaks);
  const chosen = (choice === "original" ? part.original : part.other).join("");
  const to = draftBreaks.length ? withLineBreak(chosen, lineBreak) : chosen;
  if (!from) return !draft || /[\r\n]$/.test(draft) ? draft + to : draft + lineBreak + to;
  const index = draft.indexOf(from);
  if (index < 0) return draft;
  return draft.slice(0, index) + to + draft.slice(index + from.length);
}
