/**
 * Which Markdown lines the renderer shows as code, exactly as markdown-it 14
 * (`markdownParser.ts`, `html: true`) parses them, including where it differs
 * from CommonMark. Link, tag, task, rename-repair and report-heading scans use
 * it so none of them reads or edits code. Dependency-free: the startup
 * extraction module imports it. `markdownCode.test.ts` checks it against
 * markdown-it line by line.
 *
 * - Fenced code (CommonMark 4.5): 3+ backticks or tildes, indented at most 3
 *   columns into its container; a backtick info string cannot hold a
 *   backtick. It closes on the same character, at least the same length, with
 *   only spaces or tabs after it, or when its block quote or list item ends.
 * - Indented code (4.4): a line 4+ columns into its container that does not
 *   continue a paragraph.
 * - Inline code (6.1): backtick spans found per paragraph, so a span may wrap
 *   across lines.
 * - Block quotes, list items, lazy continuation lines and HTML blocks decide
 *   where those containers and paragraphs end. HTML blocks hold no code.
 *
 * Other text files (`.txt`, source code, data) are not rendered as Markdown.
 * Their only code is fenced blocks: a fence line at any indentation, closed by
 * the same rules. Indentation never makes code there.
 */

/** Whether a vault path is a Markdown note, which the preview renders as Markdown. */
export const isMarkdownPath = (path: string): boolean => /\.(md|markdown)$/i.test(path);

const MARKER_RE = /^(?:[-+*]|(\d{1,9})[.)])(?=[ \t]|$)/;
const MARKER_AT_RE = /(?:[-+*]|(\d{1,9})[.)])(?=[ \t]|$)/y;
const BREAK_RE = /^([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const HEADING_RE = /^#{1,6}(?:[ \t]|$)/;
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const SETEXT_RE = /^(?:=+|-+)[ \t]*$/;
/** A first character that starts no block, container or indentation. */
const ORDINARY_START = /^[^\s\d<>#*+\-_=`~]/;

const HTML_BLOCK_NAMES = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|" +
  "details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|" +
  "header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|" +
  "section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_ATTRIBUTE = "(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^\"'=<>`\\x00-\\x20]+|'[^']*'|\"[^\"]*\"))?)";
const HTML_TAG = `(?:<[A-Za-z][A-Za-z0-9-]*${HTML_ATTRIBUTE}*\\s*\\/?>|<\\/[A-Za-z][A-Za-z0-9-]*\\s*>)`;
/** markdown-it's HTML block kinds: start, end (null: a blank line), and whether it interrupts a paragraph. */
const HTML_BLOCKS: Array<[RegExp, RegExp | null, boolean]> = [
  [/^<(script|pre|style|textarea)(?=(\s|>|$))/i, /<\/(script|pre|style|textarea)>/i, true],
  [/^<!--/, /-->/, true],
  [/^<\?/, /\?>/, true],
  [/^<![A-Za-z]/, />/, true],
  [/^<!\[CDATA\[/, /\]\]>/, true],
  [new RegExp(`^</?(${HTML_BLOCK_NAMES})(?=(\\s|/?>|$))`, "i"), null, true],
  [new RegExp(`^${HTML_TAG}\\s*$`), null, false],
];

/** An open block quote, or a list item whose content starts `indent` columns into its parent. */
type Container = { quote: true } | { quote: false; indent: number };
interface Fence { char: string; length: number; depth: number }
interface Html { end: RegExp | null; depth: number }

// Results of `skip`, kept outside it so the per-line hot path allocates nothing.
let skipIndex = 0;
let skipCol = 0;

/** Sets `skipIndex`/`skipCol` to the first non-space at or after `i`; tabs stop every 4 columns. */
function skip(line: string, i: number, col: number): void {
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
  }
  skipIndex = i;
  skipCol = col;
}

function blank(line: string, i: number): boolean {
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The opening marker of a fence at `i`, or null. */
function fenceOpen(line: string, i: number): string | null {
  if (line[i] !== "`" && line[i] !== "~") return null;
  const m = FENCE_RE.exec(line.slice(i));
  if (!m) return null;
  return m[1][0] === "`" && m[2].includes("`") ? null : m[1];
}

/** The HTML block kind that starts `rest`, if any. */
function htmlBlock(rest: string): (typeof HTML_BLOCKS)[number] | undefined {
  return rest[0] === "<" ? HTML_BLOCKS.find(([start]) => start.test(rest)) : undefined;
}

/** What a line is: other prose, the first line of a paragraph, a later paragraph line, or code. */
const OTHER = 0;
const PARAGRAPH = 1;
const CONTINUATION = 2;
const CODE = 3;
type Kind = typeof OTHER | typeof PARAGRAPH | typeof CONTINUATION | typeof CODE;

/**
 * Returns a function that takes each line of one document in order (without
 * its "\n"; a trailing "\r" is fine) and says whether that line is code.
 */
export function codeLineScanner(markdown = true): (line: string) => boolean {
  const kind = markdown ? lineKinds() : fenceKinds();
  return (line) => kind(line) === CODE;
}

/** Plain-text files: fence lines at any indentation are code; nothing else is. */
function fenceKinds(): (line: string) => Kind {
  let fence: Omit<Fence, "depth"> | null = null;
  return (raw) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    skip(line, 0, 0);
    const j = skipIndex;
    if (fence) {
      const rest = line.slice(j);
      const run = rest.length - rest.replace(fence.char === "`" ? /^`+/ : /^~+/, "").length;
      if (run >= fence.length && blank(rest, run)) fence = null;
      return CODE;
    }
    const marker = fenceOpen(line, j);
    if (!marker) return OTHER;
    fence = { char: marker[0], length: marker.length };
    return CODE;
  };
}

function lineKinds(): (line: string) => Kind {
  const open: Container[] = [];
  let fence: Fence | null = null;
  let html: Html | null = null;
  let indented = -1; // container depth of an open indented code block
  let paragraph = false; // the previous line can be lazily continued
  let emptyItem = -1; // index of a list item the previous line opened with no content

  /** A list marker at `i` that may open an item here, with the item's content column. */
  const listItem = (line: string, i: number, col: number): number | null => {
    const first = line.charCodeAt(i);
    if (first !== 45 && first !== 43 && first !== 42 && (first < 48 || first > 57)) return null; // - + * 0-9
    MARKER_AT_RE.lastIndex = i;
    const m = MARKER_AT_RE.exec(line);
    if (!m) return null;
    const end = i + m[0].length;
    const endCol = col + m[0].length;
    skip(line, end, endCol);
    const after = skipCol;
    // `- - -` and `* * *` are thematic breaks, not items.
    if ((first === 45 || first === 42) && line.charCodeAt(skipIndex) === first && BREAK_RE.test(line.slice(i))) return null;
    const empty = blank(line, end);
    // Only a non-empty bullet or an ordered list starting at 1 interrupts a paragraph.
    if (paragraph && (empty || (m[1] !== undefined && Number(m[1]) !== 1))) return null;
    return empty || after - endCol > 4 ? endCol + 1 : after;
  };

  /**
   * Whether a block starts at `i`, indented `rel` columns into the container
   * being checked. A negative `rel` (an outdented line) never blocks a rule on
   * indentation. A list marker is no terminator when `listIndent` says it sits
   * 4+ columns into the list's parent but outside the item.
   */
  const terminates = (line: string, i: number, rel: number, c = 0, listIndent = -1): boolean => {
    if (rel > 3) return false;
    const rest = line.slice(i);
    if (rest[0] === ">" || fenceOpen(line, i) !== null || HEADING_RE.test(rest) || BREAK_RE.test(rest)) return true;
    if (htmlBlock(rest)?.[2]) return true;
    if (!MARKER_RE.test(rest)) return false;
    return !(listIndent >= 0 && c - listIndent >= 4 && rel < 0);
  };

  /**
   * Whether a line that misses the open containers `closing` continues their
   * paragraph, as markdown-it decides it: the outermost closing block quote
   * checks the line against its parent's indentation, and once it keeps the
   * line every inner block quote ends at anything that would start a block.
   * Without a closing block quote, the innermost list item checks the line.
   */
  const lazy = (
    line: string, i: number, col: number, base: number, listIndent: number, closing: Container[]
  ): boolean => {
    if (blank(line, i)) return false;
    skip(line, i, col);
    const j = skipIndex;
    const c = skipCol;
    let parent = base;
    let quoted = false;
    for (const container of closing) {
      if (container.quote) {
        if (terminates(line, j, quoted ? -1 : c - parent, c, quoted ? -1 : listIndent)) return false;
        quoted = true;
      } else if (!quoted) {
        listIndent = parent;
        parent += container.indent;
      }
    }
    return quoted || !terminates(line, j, c - parent, c, listIndent);
  };

  return (raw): Kind => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // Most lines are top-level prose starting with an ordinary character, which
    // can neither open nor close anything.
    if (!open.length && !fence && !html && indented < 0 && ORDINARY_START.test(line)) {
      emptyItem = -1;
      const continues = paragraph;
      paragraph = true;
      return continues ? CONTINUATION : PARAGRAPH;
    }
    const openedEmpty = emptyItem;
    emptyItem = -1;
    // Match the open containers in order.
    let i = 0;
    let col = 0;
    let base = 0;
    let listIndent = -1; // content column of the innermost matched list item's parent
    let matched = 0;
    for (; matched < open.length; matched++) {
      const container = open[matched];
      skip(line, i, col);
      const j = skipIndex;
      const c = skipCol;
      if (container.quote) {
        // markdown-it accepts a continuation marker at any indentation.
        if (line[j] !== ">") break;
        listIndent = -1;
        i = j + 1;
        col = c + 1;
        base = col;
        if (line[i] === " ") { i++; col++; base++; } else if (line[i] === "\t") base++;
      } else {
        if (!blank(line, j) && c - base < container.indent) break;
        listIndent = base;
        base += container.indent;
      }
    }

    // An item that starts empty ends at a following blank line.
    if (openedEmpty >= 0 && openedEmpty < open.length && blank(line, i)) {
      open.length = openedEmpty;
      matched = Math.min(matched, openedEmpty);
    }

    if (fence) {
      if (matched >= fence.depth) {
        skip(line, i, col);
        const j = skipIndex;
        const c = skipCol;
        const rest = line.slice(j);
        const run = rest.length - rest.replace(fence.char === "`" ? /^`+/ : /^~+/, "").length;
        if (c - base <= 3 && run >= fence.length && blank(rest, run)) fence = null;
        return CODE;
      }
      fence = null;
    }
    if (html) {
      if (matched >= html.depth) {
        skip(line, i, col);
        const j = skipIndex;
        if (html.end ? html.end.test(line.slice(j)) : blank(line, j)) html = null;
        return OTHER;
      }
      html = null;
    }
    if (indented >= 0) {
      if (matched >= indented) {
        skip(line, i, col);
        const j = skipIndex;
        const c = skipCol;
        if (blank(line, j) || c - base >= 4) return CODE;
      }
      indented = -1;
    }
    if (matched < open.length) {
      if (paragraph && lazy(line, i, col, base, listIndent, open.slice(matched))) return CONTINUATION;
      open.length = matched;
      paragraph = false;
    }

    // Open new containers.
    for (;;) {
      skip(line, i, col);
      const j = skipIndex;
      const c = skipCol;
      if (c - base > 3) break;
      if (line[j] === ">") {
        open.push({ quote: true });
        i = j + 1;
        col = c + 1;
        base = col;
        if (line[i] === " ") { i++; col++; base++; } else if (line[i] === "\t") base++;
        paragraph = false;
        continue;
      }
      const itemCol = listItem(line, j, c);
      if (itemCol === null) break;
      open.push({ quote: false, indent: itemCol - base });
      i = j;
      col = c;
      while (i < line.length && line[i] !== " " && line[i] !== "\t") { i++; col++; }
      emptyItem = blank(line, i) ? open.length - 1 : -1;
      base = itemCol;
      paragraph = false;
    }

    skip(line, i, col);
    const j = skipIndex;
    const c = skipCol;
    if (blank(line, j)) {
      paragraph = false;
      return OTHER;
    }
    if (c - base >= 4) {
      if (paragraph) return CONTINUATION;
      indented = open.length;
      return CODE;
    }
    const marker = fenceOpen(line, j);
    if (marker) {
      fence = { char: marker[0], length: marker.length, depth: open.length };
      paragraph = false;
      return CODE;
    }
    const first = line[j];
    const rest = first === "<" || first === "#" || first === "-" || first === "*" || first === "_" || first === "="
      ? line.slice(j)
      : "";
    const kind = first === "<" ? htmlBlock(rest) : undefined;
    if (kind && (kind[2] || !paragraph)) {
      if (!kind[1]?.test(rest)) html = { end: kind[1], depth: open.length };
      paragraph = false;
      return OTHER;
    }
    // A setext underline or thematic break ends the paragraph, as does a heading.
    const continues = paragraph;
    paragraph = !rest || (!HEADING_RE.test(rest) && !BREAK_RE.test(rest) && !(paragraph && SETEXT_RE.test(rest)));
    if (!paragraph) return OTHER;
    return continues ? CONTINUATION : PARAGRAPH;
  };
}

/** Whether `source` can hold code at all: a backtick, a tilde fence, or (Markdown) 4 columns of indentation. */
const MAY_HOLD_CODE_RE = /`|~~~| {4}|\t/;
const MAY_HOLD_FENCE_RE = /```|~~~/;
export const mayHoldCode = (source: string, markdown = true): boolean =>
  (markdown ? MAY_HOLD_CODE_RE : MAY_HOLD_FENCE_RE).test(source);

/**
 * Calls `visit`, in order, with [start, end) offsets of each run of `source`
 * that the renderer reads as one inline text or as code: a paragraph (which
 * may span lines), any other prose line, or a code line. Runs are separated by
 * single "\n" characters, which `end` excludes. Plain text (`markdown`
 * false) yields one run per line.
 */
export function forEachSegment(
  source: string,
  visit: (start: number, end: number, code: boolean) => void,
  markdown = true,
): void {
  // Plain text has no paragraphs: each line stands alone.
  const kind = markdown ? lineKinds() : fenceKinds();
  let start = -1;
  let end = -1;
  for (let at = 0; at <= source.length; ) {
    let lineEnd = source.indexOf("\n", at);
    if (lineEnd < 0) lineEnd = source.length;
    const k = kind(source.slice(at, lineEnd));
    if (k === CONTINUATION && start >= 0) {
      end = lineEnd;
    } else {
      if (start >= 0) visit(start, end, false);
      start = -1;
      if (k === CODE) visit(at, lineEnd, true);
      else {
        start = at;
        end = lineEnd;
      }
    }
    at = lineEnd + 1;
  }
  if (start >= 0) visit(start, end, false);
}

let lastSource: string | null = null;
let lastMarkdown = true;
let lastMasks: number[] = [];

/**
 * Code offsets of `source` as sorted, merged [start, end) pairs. Plain text
 * (`markdown` false) has fenced blocks only. Remembers the last note, because
 * callers extract several things from one note.
 */
export function codeRanges(source: string, markdown = true): readonly number[] {
  if (source === lastSource && markdown === lastMarkdown) return lastMasks;
  const masks: number[] = [];
  const add = (start: number, end: number) => {
    if (end <= start) return;
    // Merge with a run that touches this one or ends at the line break before it.
    const last = masks.length - 1;
    if (last > 0 && (start === masks[last] || (start === masks[last] + 1 && source[start - 1] === "\n"))) {
      masks[last] = end;
    } else masks.push(start, end);
  };
  if (mayHoldCode(source, markdown)) {
    let tick = -1; // the first backtick at or after the current segment
    forEachSegment(source, (start, end, code) => {
      if (code) return add(start, end);
      if (!markdown) return;
      if (tick < start) {
        tick = source.indexOf("`", start);
        if (tick < 0) tick = Infinity;
      }
      if (tick >= end) return;
      const spans = inlineCodeSpans(source.slice(start, end));
      for (let k = 0; k < spans.length; k += 2) add(start + spans[k], start + spans[k + 1]);
    }, markdown);
  }
  lastSource = source;
  lastMarkdown = markdown;
  lastMasks = masks;
  return masks;
}

/**
 * `source` with each code character replaced by a space, so text scans see only
 * prose (see `codeRanges`). Line breaks and offsets are kept. Returns `source` itself when no code
 * holds a character in `significant`, since blanking it changes nothing a scan
 * for those characters can find.
 */
export function proseText(source: string, markdown = true, significant = /[^ \t\n]/): string {
  const ranges = codeRanges(source, markdown);
  let changed = false;
  for (let k = 0; k < ranges.length && !changed; k += 2) {
    changed = significant.test(source.slice(ranges[k], ranges[k + 1]));
  }
  if (!changed) return source;
  const parts: string[] = [];
  let at = 0;
  for (let k = 0; k < ranges.length; k += 2) {
    parts.push(source.slice(at, ranges[k]));
    // Keep the line breaks of a range that spans lines.
    for (const line of source.slice(ranges[k], ranges[k + 1]).split("\n")) parts.push(" ".repeat(line.length), "\n");
    parts.pop();
    at = ranges[k + 1];
  }
  parts.push(source.slice(at));
  return parts.join("");
}

/**
 * Inline code spans of one line or paragraph as flat [start, end) pairs,
 * delimiters included, found as markdown-it's backtick rule finds them: a run
 * closes only on a later run of the same length, an unmatched run is literal
 * text, and so is a backslash-escaped backtick. Like markdown-it, once a scan
 * reaches the end, a run whose length was last seen before it stays literal.
 * Backticks that other inline syntax takes first (a link destination, raw
 * HTML, an autolink) are still read as backticks here.
 */
export function inlineCodeSpans(text: string): number[] {
  const out: number[] = [];
  const lastRun: number[] = []; // latest start of a non-closing run, by length
  let scanned = false;
  for (let at = text.indexOf("`"); at >= 0; ) {
    let slashes = 0;
    while (text[at - 1 - slashes] === "\\") slashes++;
    if (slashes % 2) {
      // The escaped backtick is literal; a run may still start right after it.
      at = text[at + 1] === "`" ? at + 1 : text.indexOf("`", at + 1);
      continue;
    }
    let end = at;
    while (text[end] === "`") end++;
    const length = end - at;
    let close = -1;
    let closeEnd = end;
    if (!scanned || (lastRun[length] || 0) > at) {
      for (let run = text.indexOf("`", closeEnd); run >= 0; run = text.indexOf("`", closeEnd)) {
        closeEnd = run + 1;
        while (text[closeEnd] === "`") closeEnd++;
        if (closeEnd - run === length) {
          close = run;
          break;
        }
        lastRun[closeEnd - run] = run;
      }
      if (close < 0) scanned = true;
    }
    if (close < 0) {
      at = text.indexOf("`", end);
      continue;
    }
    out.push(at, closeEnd);
    at = text.indexOf("`", closeEnd);
  }
  return out;
}
