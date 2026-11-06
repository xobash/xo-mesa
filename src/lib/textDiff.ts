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

export function diffTextLines(original: string, other: string): TextDiffPart[] {
  const rawA = splitLines(original);
  const rawB = splitLines(other);
  const a = rawA.map(matchKey);
  const b = rawB.map(matchKey);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  const columns = b.length - prefix + 1;
  const remainingA = a.length - prefix;
  const remainingB = b.length - prefix;
  const cells = (remainingA + 1) * columns;
  // An LCS cannot exceed the shorter side. Most 1 MiB review documents fit
  // in 16-bit cells, halving the matrix without changing any tie decisions.
  const dp = Math.min(remainingA, remainingB) <= 0xffff
    ? new Uint16Array(cells)
    : new Uint32Array(cells);
  for (let i = a.length - 1; i >= prefix; i--) {
    const row = (i - prefix) * columns;
    const nextRow = row + columns;
    for (let j = b.length - 1; j >= prefix; j--) {
      const col = j - prefix;
      dp[row + col] = a[i] === b[j]
        ? dp[nextRow + col + 1] + 1
        : Math.max(dp[nextRow + col], dp[row + col + 1]);
    }
  }
  const parts: TextDiffPart[] = [];
  let i = prefix, j = prefix;
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
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      pushSame(i, j); i++; j++;
    } else if (j >= b.length || (i < a.length && dp[(i + 1 - prefix) * columns + j - prefix] >= dp[(i - prefix) * columns + j + 1 - prefix])) {
      pushChange(rawA[i], undefined); i++;
    } else {
      pushChange(undefined, rawB[j]); j++;
    }
  }
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
