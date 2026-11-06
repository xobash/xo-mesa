/**
 * Line-ending bookkeeping for text that must round-trip byte-faithfully.
 *
 * Policy for every text surface that edits a file Mesa did not write:
 * untouched lines keep the exact break they had on disk; a break the user
 * creates or retypes takes the file's dominant break. A file is never
 * converted as a whole, so a Mac↔Windows round trip only changes the lines
 * somebody edited.
 */

export type LineBreak = "\n" | "\r\n" | "\r";

const BREAK = /\r\n|\r|\n/g;

/** Every line break in `text`, in order. `text.split(BREAK)` gives the lines. */
export function lineBreaksOf(text: string): LineBreak[] {
  return (text.match(BREAK) ?? []) as LineBreak[];
}

/** Most frequent break; a tie goes to the break that appears first. LF when there is none. */
export function dominantLineBreak(breaks: readonly LineBreak[]): LineBreak {
  let lf = 0, crlf = 0, cr = 0;
  for (const b of breaks) {
    if (b === "\n") lf++;
    else if (b === "\r\n") crlf++;
    else cr++;
  }
  const best = Math.max(lf, crlf, cr);
  if (!best) return "\n";
  for (const b of breaks) {
    if ((b === "\n" ? lf : b === "\r\n" ? crlf : cr) === best) return b;
  }
  return "\n";
}

/** True when the text holds anything except LF breaks (CRLF, lone CR, or a mix). */
export function needsLineBreakTracking(text: string): boolean {
  return text.includes("\r");
}

export type LineEndingStyle = "none" | "LF" | "CRLF" | "CR" | "mixed";

export function lineEndingStyle(text: string): LineEndingStyle {
  const breaks = lineBreaksOf(text);
  if (!breaks.length) return "none";
  const first = breaks[0];
  if (breaks.some((b) => b !== first)) return "mixed";
  return first === "\n" ? "LF" : first === "\r\n" ? "CRLF" : "CR";
}

export function describeLineEndingStyle(style: LineEndingStyle): string {
  switch (style) {
    case "LF": return "LF (macOS and Linux)";
    case "CRLF": return "CRLF (Windows)";
    case "CR": return "CR (classic Mac)";
    case "mixed": return "a mix of line endings";
    default: return "no line breaks";
  }
}

/**
 * The breaks between the lines of an editable document. `breaks[i]` follows
 * line `i + 1` (1-based). `odd` counts breaks that differ from `dominant`, so
 * a uniform document can be serialized with one join.
 */
export interface TrackedLineBreaks {
  readonly breaks: readonly LineBreak[];
  readonly dominant: LineBreak;
  readonly odd: number;
}

export function trackLineBreaks(text: string): TrackedLineBreaks {
  const breaks = lineBreaksOf(text);
  const dominant = dominantLineBreak(breaks);
  let odd = 0;
  for (const b of breaks) if (b !== dominant) odd++;
  return { breaks, dominant, odd };
}

/**
 * One replaced range, in old-document line numbers (1-based): the breaks
 * after lines `fromLine .. toLine - 1` are removed and `insertedBreaks` new
 * breaks take their place.
 */
export interface LineBreakEdit {
  fromLine: number;
  toLine: number;
  insertedBreaks: number;
}

/** Apply ascending, non-overlapping edits. New breaks take the dominant break. */
export function updateLineBreaks(tracked: TrackedLineBreaks, edits: readonly LineBreakEdit[]): TrackedLineBreaks {
  const touched = edits.filter((e) => e.toLine > e.fromLine || e.insertedBreaks > 0);
  if (!touched.length) return tracked;
  const { dominant } = tracked;
  const breaks = tracked.breaks.slice();
  let odd = tracked.odd;
  // Right to left, so earlier line numbers stay valid while splicing.
  for (let k = touched.length - 1; k >= 0; k--) {
    const { fromLine, toLine, insertedBreaks } = touched[k];
    const removed = breaks.splice(fromLine - 1, toLine - fromLine, ...Array<LineBreak>(insertedBreaks).fill(dominant));
    for (const b of removed) if (b !== dominant) odd--;
  }
  return { breaks, dominant, odd };
}

/**
 * Put back the exact breaks of a run of lines that undo reinserted. The run
 * starts with the break after line `fromLine`. A run that does not fit is
 * ignored, which leaves the dominant breaks the edit gave those lines.
 */
export function restoreLineBreakRun(
  tracked: TrackedLineBreaks,
  fromLine: number,
  run: readonly LineBreak[]
): TrackedLineBreaks {
  const start = fromLine - 1;
  if (!run.length || start < 0 || start + run.length > tracked.breaks.length) return tracked;
  const { dominant } = tracked;
  const breaks = tracked.breaks.slice();
  let odd = tracked.odd;
  for (let k = 0; k < run.length; k++) {
    if (breaks[start + k] !== dominant) odd--;
    if (run[k] !== dominant) odd++;
    breaks[start + k] = run[k];
  }
  return { breaks, dominant, odd };
}

/** Join lines with their tracked breaks. `lines.length` must be `breaks.length + 1`. */
export function joinWithLineBreaks(lines: Iterable<string>, tracked: TrackedLineBreaks): string {
  const out: string[] = [];
  let i = 0;
  for (const line of lines) {
    if (i > 0) out.push(tracked.breaks[i - 1] ?? tracked.dominant);
    out.push(line);
    i++;
  }
  return out.join("");
}

/**
 * Restore the line breaks a text control normalized away. `before` is the
 * faithful text; `after` is the control's new value, whose breaks are all LF.
 * Lines shared at the start and end keep their original breaks; the edited
 * middle takes the dominant break of `before`.
 */
export function restoreLineBreaks(before: string, after: string): string {
  if (!needsLineBreakTracking(before) || after.includes("\r")) return after;
  const oldLines = before.split(BREAK);
  const oldBreaks = lineBreaksOf(before);
  const newLines = after.split("\n");
  const dominant = dominantLineBreak(oldBreaks);
  let prefix = 0;
  const max = Math.min(oldLines.length, newLines.length);
  while (prefix < max - 1 && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix - 1 &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;
  const out: string[] = [];
  for (let i = 0; i < newLines.length; i++) {
    if (i > 0) {
      // Break i-1 sits between new lines i-1 and i.
      let b: LineBreak = dominant;
      if (i <= prefix) b = oldBreaks[i - 1];
      else if (i >= newLines.length - suffix) b = oldBreaks[oldBreaks.length - (newLines.length - i)];
      out.push(b);
    }
    out.push(newLines[i]);
  }
  return out.join("");
}

/** Rewrite every break in `text` as `lineBreak`. */
export function withLineBreak(text: string, lineBreak: LineBreak): string {
  return text.replace(BREAK, lineBreak);
}
