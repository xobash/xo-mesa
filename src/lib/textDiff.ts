export type TextDiffPart =
  | { kind: "same"; lines: string[] }
  | { kind: "change"; original: string[]; other: string[] };

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffTextLines(original: string, other: string): TextDiffPart[] {
  const a = splitLines(original);
  const b = splitLines(other);
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
  const pushSame = (line: string) => {
    const last = parts[parts.length - 1];
    if (last?.kind === "same") last.lines.push(line);
    else parts.push({ kind: "same", lines: [line] });
  };
  const pushChange = (originalLine?: string, otherLine?: string) => {
    const last = parts[parts.length - 1];
    const part = last?.kind === "change" ? last : null;
    const target = part ?? { kind: "change" as const, original: [], other: [] };
    if (originalLine !== undefined) target.original.push(originalLine);
    if (otherLine !== undefined) target.other.push(otherLine);
    if (!part) parts.push(target);
  };
  if (prefix) parts.push({ kind: "same", lines: a.slice(0, prefix) });
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      pushSame(a[i]); i++; j++;
    } else if (j >= b.length || (i < a.length && dp[(i + 1 - prefix) * columns + j - prefix] >= dp[(i - prefix) * columns + j + 1 - prefix])) {
      pushChange(a[i], undefined); i++;
    } else {
      pushChange(undefined, b[j]); j++;
    }
  }
  return parts.filter(part => part.kind === "same" ? part.lines.length : part.original.length || part.other.length);
}

export function applyTextDiffChoice(draft: string, part: TextDiffPart, choice: "original" | "other"): string {
  if (part.kind !== "change") return draft;
  const from = part.original.join("");
  const to = (choice === "original" ? part.original : part.other).join("");
  if (!from) return draft.endsWith("\n") || !draft ? draft + to : `${draft}\n${to}`;
  const index = draft.indexOf(from);
  if (index < 0) return draft;
  return draft.slice(0, index) + to + draft.slice(index + from.length);
}
