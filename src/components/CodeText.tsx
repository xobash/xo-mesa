import { useMemo, useRef } from "react";
import { langForExt, tokenize } from "../lib/highlight";
import { detectDelimiter, parseDelimitedRows as parseDelimited } from "../lib/delimitedTable";
import {
  CODE_ROW_HEIGHT,
  buildCodeLineIndex,
  codeLineAt,
  shouldWindowCode,
  visibleCodeLineRange,
} from "../lib/codeWindow";
import { useScrollViewport } from "./useScrollViewport";

const TYPE_CLASS: Record<string, string> = {
  plain: "",
  comment: "cv-com",
  string: "cv-str",
  number: "cv-num",
  keyword: "cv-kw",
};

/**
 * Read-only rendering of already-loaded text: CSV/TSV as a table, everything
 * else syntax-highlighted with a line-number gutter. Large text mounts only a
 * window of rows, so every surface that shows file text shares this path.
 */
export function CodeText({ text, ext: extRaw }: { text: string; ext: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ext = extRaw.toLowerCase();
  const isTable = ext === "csv" || ext === "tsv";
  const delim = useMemo(
    () => (isTable ? detectDelimiter(text, ext === "tsv" ? "\t" : ",") : ","),
    [isTable, text, ext]
  );
  const lineIndex = useMemo(() => buildCodeLineIndex(text), [text]);
  const lineCount = lineIndex.lineCount;
  const large = shouldWindowCode(text.length, lineCount);

  const rows = useMemo(
    () =>
      isTable && !large
        ? parseDelimited(text, delim)
        : null,
    [isTable, text, delim, large]
  );
  const tokens = useMemo(
    () =>
      !isTable && !large
        ? tokenize(text, langForExt(ext))
        : null,
    [isTable, text, ext, large]
  );

  const viewport = useScrollViewport(scrollRef, large ? text : null);

  if (large) {
    const range = visibleCodeLineRange(
      lineIndex.lineCount,
      viewport.scrollTop,
      viewport.height
    );
    const lang = langForExt(ext);
    const visibleLines: Array<{ index: number; value: string }> = [];
    for (let i = range.start; i < range.end; i++) {
      visibleLines.push({ index: i, value: codeLineAt(text, i, lineIndex) });
    }
    const header = isTable
      ? parseDelimited(codeLineAt(text, 0, lineIndex), delim)[0] ?? []
      : [];

    return (
      <div className="code-view">
        <div className="code-bar">
          <span className="code-lang">{isTable ? ext.toUpperCase() : lang}</span>
          <span className="code-meta">
            {isTable
              ? `${Math.max(0, lineCount - 1)} rows × ${header.length} cols`
              : `${lineCount} lines`}
          </span>
          <span className="code-meta">Windowed large-file view</span>
        </div>
        {isTable ? (
          <div className="code-table-wrap code-virtual-scroll" ref={scrollRef}>
            <div className="code-virtual-spacer" style={{ height: lineCount * CODE_ROW_HEIGHT }}>
              <table
                className="code-table code-virtual-table"
                style={{ transform: `translateY(${range.start * CODE_ROW_HEIGHT}px)` }}
              >
                <thead>
                  <tr>
                    <th className="code-rownum">#</th>
                    {header.map((h, i) => (
                      <th key={i}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleLines
                    .filter((line) => line.index > 0)
                    .map((line) => {
                      const parsed =
                        parseDelimited(line.value, delim)[0] ?? [];
                      return (
                        <tr key={line.index} style={{ height: CODE_ROW_HEIGHT }}>
                          <td className="code-rownum">{line.index}</td>
                          {header.map((_, ci) => (
                            <td key={ci}>{parsed[ci] ?? ""}</td>
                          ))}
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="code-scroll code-virtual-scroll" ref={scrollRef}>
            <div className="code-virtual-spacer" style={{ height: lineCount * CODE_ROW_HEIGHT }}>
              {visibleLines.map((line) => (
                <div
                  className="code-line-row"
                  key={line.index}
                  style={{
                    top: line.index * CODE_ROW_HEIGHT,
                    height: CODE_ROW_HEIGHT,
                  }}
                >
                  <div className="code-gutter code-line-gutter" aria-hidden="true">
                    {line.index + 1}
                  </div>
                  <pre className="code-pre code-line-pre">
                    <code>
                      {tokenize(line.value, lang).map((t, i) =>
                        t.type === "plain" ? (
                          t.value
                        ) : (
                          <span key={i} className={TYPE_CLASS[t.type]}>
                            {t.value}
                          </span>
                        )
                      )}
                    </code>
                  </pre>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (rows) {
    const head = rows[0] ?? [];
    const body = rows.slice(1);
    return (
      <div className="code-view">
        <div className="code-bar">
          <span className="code-lang">{ext.toUpperCase()}</span>
          <span className="code-meta">
            {body.length} rows × {head.length} cols
          </span>
        </div>
        <div className="code-table-wrap">
          <table className="code-table">
            <thead>
              <tr>
                <th className="code-rownum">#</th>
                {head.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  <td className="code-rownum">{ri + 1}</td>
                  {head.map((_, ci) => (
                    <td key={ci}>{r[ci] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="code-view">
      <div className="code-bar">
        <span className="code-lang">{langForExt(ext)}</span>
        <span className="code-meta">{lineCount} lines</span>
      </div>
      <div className="code-scroll">
        <div className="code-gutter" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <pre className="code-pre">
          <code>
            {tokens!.map((t, i) =>
              t.type === "plain" ? (
                t.value
              ) : (
                <span key={i} className={TYPE_CLASS[t.type]}>
                  {t.value}
                </span>
              )
            )}
          </code>
        </pre>
      </div>
    </div>
  );
}
