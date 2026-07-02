import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store";
import { parseSearchQuery } from "../lib/search";
import { PreviewCard } from "./PreviewCard";

interface Hit {
  rel: string;
  title: string;
  ext: string;
  snippet: string;
  count: number;
}

export function SearchSurface({
  initialQuery = "",
  onClose,
  onAgent,
  showAgentButton = true,
}: {
  initialQuery?: string;
  onClose?: () => void;
  onAgent?: () => void;
  showAgentButton?: boolean;
}) {
  const files = useAppStore((s) => s.files);
  const cache = useAppStore((s) => s.contentCache);
  const openFile = useAppStore((s) => s.openFile);
  const setPiOverlayOpen = useAppStore((s) => s.setPiOverlayOpen);
  const [q, setQ] = useState(initialQuery);
  const [sel, setSel] = useState(0);
  const dq = useDeferredValue(q);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setQ(initialQuery);
    setSel(0);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [initialQuery]);

  const results = useMemo<Hit[]>(() => {
    const { term, ext } = parseSearchQuery(dq);
    if (term.length < 2 && !ext) return [];
    const re =
      term.length >= 2
        ? new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
        : null;
    const out: Hit[] = [];
    for (const f of files) {
      if (ext && f.ext.toLowerCase() !== ext) continue;
      const nameHit = term ? f.name.toLowerCase().includes(term) : true;
      const text = (cache[f.relPath] ?? "").toLowerCase();
      const idx = term ? text.indexOf(term) : -1;
      if (term && idx < 0 && !nameHit) continue;
      let snippet = "";
      if (idx >= 0) {
        const start = Math.max(0, idx - 32);
        const raw = cache[f.relPath] ?? "";
        snippet =
          (start > 0 ? "..." : "") +
          raw.slice(start, idx + term.length + 60).replace(/\s+/g, " ") +
          "...";
      } else if (!term) {
        snippet = f.relPath;
      }
      const count = re ? (text.match(re) || []).length : 0;
      out.push({ rel: f.relPath, title: f.name, ext: f.ext, snippet, count });
    }
    return out
      .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
      .slice(0, 100);
  }, [dq, files, cache]);

  const { term, ext } = parseSearchQuery(q);
  const selClamped = Math.min(sel, Math.max(0, results.length - 1));
  const active = results[selClamped];

  const openActive = (rel: string) => {
    onClose?.();
    void openFile(rel);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (results.length === 0) return;
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      setSel((s) => Math.min(results.length - 1, s + 1));
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter" && active) {
      e.preventDefault();
      openActive(active.rel);
    }
  };

  return (
    <div className="search-surface">
      <div className="search-input-row">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search all notes & files...  (try ext:pdf, type:md, .png)"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
        />
        {showAgentButton && (
          <button
            className="btn search-agent-btn"
            onClick={() => {
              if (onAgent) {
                onAgent();
              } else {
                onClose?.();
                setPiOverlayOpen(true);
              }
            }}
            aria-label="Ask Pi"
            title="Ask Pi"
          >
            π
          </button>
        )}
      </div>
      <div className="search-body">
        <div className="palette-list search-results">
          {results.map((r, i) => (
            <button
              key={r.rel}
              className={"search-item" + (i === selClamped ? " sel" : "")}
              onMouseEnter={() => setSel(i)}
              onClick={() => openActive(r.rel)}
            >
              <div className="search-item-title">
                {r.title}
                {r.ext && r.ext !== "md" && (
                  <span className="tree-ext">{r.ext}</span>
                )}
                {r.count > 0 && <span className="search-count">{r.count}</span>}
              </div>
              {r.snippet && <div className="search-snippet">{r.snippet}</div>}
            </button>
          ))}
          {term.length < 2 && !ext && (
            <div className="palette-empty">
              Type at least 2 characters, or filter by <code>ext:pdf</code>.
            </div>
          )}
          {(term.length >= 2 || ext) && results.length === 0 && (
            <div className="palette-empty">No matches</div>
          )}
        </div>
        {active && (
          <div className="search-preview">
            <PreviewCard
              target={{ kind: "note", id: active.rel }}
              x={0}
              y={0}
              fixed
            />
          </div>
        )}
      </div>
    </div>
  );
}
