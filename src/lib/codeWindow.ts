export interface CodeLineIndex {
  starts: number[];
  lineCount: number;
}

export interface CodeVisibleRange {
  start: number;
  end: number;
}

export const LARGE_CODE_CHAR_THRESHOLD = 250_000;
export const LARGE_CODE_LINE_THRESHOLD = 5_000;
export const CODE_ROW_HEIGHT = 20;

export function buildCodeLineIndex(text: string): CodeLineIndex {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return { starts, lineCount: starts.length };
}

export function codeLineAt(
  text: string,
  index: number,
  lineIndex: CodeLineIndex
): string {
  if (index < 0 || index >= lineIndex.lineCount) return "";
  const start = lineIndex.starts[index];
  const next =
    index + 1 < lineIndex.lineCount ? lineIndex.starts[index + 1] : text.length;
  const end = next > start && text.charCodeAt(next - 1) === 10 ? next - 1 : next;
  const trimmedEnd = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
  return text.slice(start, trimmedEnd);
}

export function shouldWindowCode(textLength: number, lineCount: number): boolean {
  return textLength >= LARGE_CODE_CHAR_THRESHOLD || lineCount >= LARGE_CODE_LINE_THRESHOLD;
}

export function visibleCodeLineRange(
  lineCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = CODE_ROW_HEIGHT,
  overscan = 12
): CodeVisibleRange {
  if (lineCount <= 0) return { start: 0, end: 0 };
  if (!Number.isFinite(viewportHeight)) return { start: 0, end: lineCount };
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  return {
    start: first,
    end: Math.min(lineCount, first + visible),
  };
}
