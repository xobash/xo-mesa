import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store";
import { langForExt, tokenize, parseDelimited } from "../lib/highlight";
import {
  CODE_ROW_HEIGHT,
  buildCodeLineIndex,
  codeLineAt,
  shouldWindowCode,
  visibleCodeLineRange,
} from "../lib/codeWindow";

const TYPE_CLASS: Record<string, string> = {
  plain: "",
  comment: "cv-com",
  string: "cv-str",
  number: "cv-num",
  keyword: "cv-kw",
};

/**
 * Read-only viewer for code/data files: CSV/TSV render as a table, everything
 * else is syntax-highlighted with a line-number gutter. Used for files that are
 * textual but not the editable note types (.md/.txt go to the editor).
 */
export function CodeView({ rel }: { rel: string }) {
  const fileFor = useAppStore((s) => s.fileFor);
  const ensureContent = useAppStore((s) => s.ensureContent);
  const file = fileFor(rel);
  const [text, setText] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 600 });

  useEffect(() => {
    let alive = true;
    setText(null);
    void ensureContent(rel).then((c) => {
      if (alive) setText(c);
    });
    return () => {
      alive = false;
    };
  }, [rel, ensureContent]);

  const ext = (file?.ext ?? "").toLowerCase();
  const isTable = ext === "csv" || ext === "tsv";
  const lineIndex = useMemo(
    () => (text != null ? buildCodeLineIndex(text) : null),
    [text]
  );
  const lineCount = lineIndex?.lineCount ?? 0;
  const large = text != null && shouldWindowCode(text.length, lineCount);

  const rows = useMemo(
    () =>
      isTable && text != null && !large
        ? parseDelimited(text, ext === "tsv" ? "\t" : ",")
        : null,
    [isTable, text, ext, large]
  );
  const tokens = useMemo(
    () =>
      !isTable && text != null && !large
        ? tokenize(text, langForExt(ext))
        : null,
    [isTable, text, ext, large]
  );

  useLayoutEffect(() => {
    if (!large) return;
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const next = { scrollTop: el.scrollTop, height: el.clientHeight };
      setViewport((prev) =>
        prev.scrollTop === next.scrollTop && prev.height === next.height
          ? prev
          : next
      );
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", schedule);
      ro?.disconnect();
    };
  }, [large, rel, text]);

  if (!file) return <div className="editor-empty">File not found.</div>;
  if (text == null) return <div className="editor-empty">Loading…</div>;

  if (large && lineIndex) {
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
      ? parseDelimited(codeLineAt(text, 0, lineIndex), ext === "tsv" ? "\t" : ",")[0] ?? []
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
                        parseDelimited(line.value, ext === "tsv" ? "\t" : ",")[0] ?? [];
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
