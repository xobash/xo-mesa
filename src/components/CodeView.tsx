import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../store";
import { langForExt, tokenize, parseDelimited } from "../lib/highlight";

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

  const rows = useMemo(
    () => (isTable && text != null ? parseDelimited(text, ext === "tsv" ? "\t" : ",") : null),
    [isTable, text, ext]
  );
  const tokens = useMemo(
    () => (!isTable && text != null ? tokenize(text, langForExt(ext)) : null),
    [isTable, text, ext]
  );
  const lineCount = useMemo(() => (text != null ? text.split("\n").length : 0), [text]);

  if (!file) return <div className="editor-empty">File not found.</div>;
  if (text == null) return <div className="editor-empty">Loading…</div>;

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
