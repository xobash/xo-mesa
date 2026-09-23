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
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const parts: TextDiffPart[] = [];
  let i = 0, j = 0;
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
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      pushSame(a[i]); i++; j++;
    } else if (j >= b.length || (i < a.length && dp[i + 1][j] >= dp[i][j + 1])) {
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
