import { acquireSharedIndexSearch } from "../lib/indexSearch";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../store";
import {
  createSearchScan,
  parseSearchQuery,
  type SearchHit,
  type SearchPass,
} from "../lib/search";
import { markMesaPerf } from "../lib/mesaPerf";
import { PreviewCard } from "./PreviewCard";

/** Wall time one scan slice may take. Comfortably inside a frame, so typing and
 *  scrolling keep their budget while the pass runs. */
const SEARCH_SLICE_MS = 8;
const SAVED_SEARCHES_KEY = "mesa:savedSearches:v1";
const MAX_SAVED_SEARCHES = 8;
const SEARCH_FILTERS = [
  { label: "Notes", ext: "md" },
  { label: "PDFs", ext: "pdf" },
  { label: "Images", ext: "png" },
  { label: "Web pages", ext: "html" },
] as const;

function focusOpenedDocument(): void {
  if (typeof document === "undefined") return;
  const focus = () => {
    const target = document.querySelector<HTMLElement>(
      ".editor-host .cm-content, [data-testid='pdf-editor'], .code-view"
    );
    target?.focus();
  };
  requestAnimationFrame(() => requestAnimationFrame(focus));
}

function readSavedSearches(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_SEARCHES_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, MAX_SAVED_SEARCHES)
      : [];
  } catch {
    return [];
  }
}

function writeSavedSearches(searches: string[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(searches.slice(0, MAX_SAVED_SEARCHES)));
}

/**
 * Yield to the browser between slices.
 *
 * `setTimeout(0)` is clamped to ~4 ms once nested, which would more than double
 * the wall time of a long pass; a MessageChannel port delivers on the next
 * macrotask with no clamp, and — unlike `requestAnimationFrame` — keeps running
 * when the window is not painting.
 */
const yieldToBrowser: (run: () => void) => void =
  typeof MessageChannel === "undefined"
    ? (run) => setTimeout(run, 0)
    : (() => {
        const channel = new MessageChannel();
        const queue: Array<() => void> = [];
        channel.port1.onmessage = () => queue.shift()?.();
        return (run: () => void) => {
          queue.push(run);
          channel.port2.postMessage(null);
        };
      })();

const SearchResultItem = memo(function SearchResultItem({
  result,
  index,
  selected,
  interactive,
  term,
  onSelect,
  onOpen,
}: {
  result: SearchHit;
  index: number;
  selected: boolean;
  /** False while this row belongs to an older query/data generation. */
  interactive: boolean;
  term: string;
  onSelect: (index: number) => void;
  onOpen: (rel: string) => void;
}) {
  return (
    <button
      className={"search-item" + (selected ? " sel" : "")}
      onMouseEnter={() => onSelect(index)}
      onClick={() => {
        if (interactive) onOpen(result.rel);
      }}
      aria-disabled={!interactive}
    >
      <div className="search-item-title">
        {result.title}
        {result.ext && result.ext !== "md" && (
          <span className="tree-ext">{result.ext}</span>
        )}
        {result.count > 0 && (
          <span className="search-count">{result.count}</span>
        )}
      </div>
      {result.snippet && (
        <div className="search-snippet">
          <HighlightedSnippet text={result.snippet} term={term} />
        </div>
      )}
    </button>
  );
});

function HighlightedSnippet({ text, term }: { text: string; term: string }) {
  const needle = term.trim();
  if (needle.length < 2) return <>{text}</>;
  const lower = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = lower.indexOf(lowerNeedle, cursor);
    if (index < 0) break;
    if (index > cursor) parts.push({ text: text.slice(cursor, index), hit: false });
    parts.push({ text: text.slice(index, index + needle.length), hit: true });
    cursor = index + needle.length;
  }
  if (parts.length === 0) return <>{text}</>;
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>
      )}
    </>
  );
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
  const vaultPath = useAppStore((s) => s.vaultPath);
  // Search reads only relPath/name/ext. The deferred startup metadata pass
  // republishes the same file objects with size/mtime filled in; shallow
  // element equality prevents that irrelevant publication from cancelling a
  // live sliced scan and restarting it from file zero.
  const files = useAppStore(useShallow((s) => s.files));
  const cache = useAppStore((s) => s.contentCache);
  const openFile = useAppStore((s) => s.openFile);
  const setPiOverlayOpen = useAppStore((s) => s.setPiOverlayOpen);
  const unindexedTextFiles = useAppStore((s) => s.unindexedTextFiles);
  const indexingTextFiles = useAppStore((s) => s.indexingTextFiles);
  const setSearchSeed = useAppStore((s) => s.setSearchSeed);
  const [q, setQ] = useState(initialQuery);
  const [sel, setSel] = useState(0);
  const [savedSearches, setSavedSearches] = useState<string[]>(() => readSavedSearches());
  const dq = useDeferredValue(q);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setQ(initialQuery);
    setSel(0);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [initialQuery]);

  // Previous pass, reused to narrow the next keystroke instead of rescanning the
  // whole vault (see `searchVault`). Dropped whenever the file list or content
  // cache changes identity, since an edited note may newly match a term that
  // already excluded it.
  const passRef = useRef<SearchPass | null>(null);
  const scannedRef = useRef<{ files: unknown; cache: unknown } | null>(null);
  const scanGenerationRef = useRef(0);
  const [activeScanGeneration, setActiveScanGeneration] = useState<number | null>(
    null
  );
  const indexedSearch = useRef<ReturnType<typeof acquireSharedIndexSearch>>(null);
  useEffect(() => () => { indexedSearch.current?.release(); indexedSearch.current = null; }, []);
  const [resultSet, setResultSet] = useState<{
    query: string;
    files: unknown;
    cache: unknown;
    hits: SearchHit[];
  }>({ query: "", files: null, cache: null, hits: [] });

  // The scan runs in slices with a yield between them. A full pass over a real
  // vault is 42–80 ms warm (hundreds under memory pressure), and running it
  // synchronously froze the caret for that long on every keystroke that could
  // not be narrowed from the previous pass. `useDeferredValue` cannot fix that
  // on its own: React can deprioritise the render but cannot interrupt a
  // synchronous loop.
  //
  // Results are committed only when the pass completes, so the list never shows
  // a partially-ranked order — the previous results stay up meanwhile, exactly
  // as they did while the synchronous version blocked. Those retained rows are
  // display-only: query/data generation checks below prevent a click, Enter, or
  // preview from acting on an old result while its replacement scan is active.
  useEffect(() => {
    if (
      scannedRef.current?.files !== files ||
      scannedRef.current?.cache !== cache
    ) {
      scannedRef.current = { files, cache };
      passRef.current = null;
    }
    const scan = createSearchScan(files, cache, dq, passRef.current);
    markMesaPerf("search-start", { queryLength: dq.length, files: files.length });
    const generation = ++scanGenerationRef.current;
    setActiveScanGeneration(generation);
    let cancelled = false;
    const step = () => {
      if (cancelled) return;
      if (scan.advance(SEARCH_SLICE_MS)) {
        passRef.current = scan.result();
        setResultSet({ query: dq, files, cache, hits: passRef.current.hits });
        markMesaPerf("search-complete", {
          queryLength: dq.length,
          hits: passRef.current.hits.length,
          files: files.length,
        });
        setActiveScanGeneration((current) =>
          current === generation ? null : current
        );
        return;
      }
      yieldToBrowser(step);
    };
    if (!indexedSearch.current) indexedSearch.current = acquireSharedIndexSearch(cache, vaultPath ?? "demo");
    const executor = indexedSearch.current;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    if (executor?.accepts(cache)) {
      const fallBackToMainThread = () => {
        if (cancelled) return;
        executor.cancel();
        executor.release();
        indexedSearch.current = null;
        step();
      };
      // A worker is an optimization, not a correctness boundary. Native
      // webviews can keep a worker alive without delivering its reply (for
      // example during startup or after a renderer interruption). Keep the
      // honest "Searching..." state bounded, then continue with the same
      // yielding scan used when workers are unavailable.
      fallbackTimer = setTimeout(fallBackToMainThread, 2500);
      void executor.run(files, cache, dq).then(pass => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (cancelled) return;
        passRef.current = pass;
        setResultSet({ query: dq, files, cache, hits: pass.hits });
        markMesaPerf("search-complete", { queryLength: dq.length, hits: pass.hits.length, files: files.length, worker: true });
        setActiveScanGeneration(current => current === generation ? null : current);
      }).catch(() => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (!cancelled) { executor.release(); indexedSearch.current = null; step(); }
      });
    } else step();
    return () => {
      cancelled = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      executor?.cancel();
    };
  }, [dq, files, cache, vaultPath]);

  const { term, ext } = parseSearchQuery(q);
  const results = resultSet.hits;
  const resultsCurrent =
    activeScanGeneration === null &&
    dq === q &&
    resultSet.query === q &&
    resultSet.files === files &&
    resultSet.cache === cache;
  const selClamped = Math.min(sel, Math.max(0, results.length - 1));
  const active = resultsCurrent ? results[selClamped] : undefined;

  const openActive = useCallback(
    (rel: string) => {
      onClose?.();
      void openFile(rel).then(focusOpenedDocument);
    },
    [onClose, openFile]
  );
  const selectResult = useCallback((index: number) => setSel(index), []);
  const updateQuery = useCallback((next: string) => {
    setQ(next);
    setSearchSeed(next);
    setSel(0);
  }, [setSearchSeed]);
  const applyFilter = useCallback((nextExt: string) => {
    const parsed = parseSearchQuery(q);
    const next = `${parsed.term ? `${parsed.term} ` : ""}ext:${nextExt}`;
    updateQuery(next);
  }, [q, updateQuery]);
  const saveCurrentSearch = useCallback(() => {
    const trimmed = q.trim();
    if (trimmed.length < 2 && !parseSearchQuery(trimmed).ext) return;
    setSavedSearches((current) => {
      const next = [trimmed, ...current.filter((item) => item !== trimmed)].slice(0, MAX_SAVED_SEARCHES);
      writeSavedSearches(next);
      return next;
    });
  }, [q]);
  const removeSavedSearch = useCallback((query: string) => {
    setSavedSearches((current) => {
      const next = current.filter((item) => item !== query);
      writeSavedSearches(next);
      return next;
    });
  }, []);
  const previewTarget = useMemo(
    () => (active ? ({ kind: "note", id: active.rel } as const) : null),
    [active?.rel]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (results.length === 0) return;
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      setSel((s) => Math.min(results.length - 1, s + 1));
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active) openActive(active.rel);
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
            updateQuery(e.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <button
          className="btn search-save-btn"
          disabled={(term.length < 2 && !ext) || savedSearches[0] === q.trim()}
          onClick={saveCurrentSearch}
          title="Save this search"
          aria-label="Save this search"
        >
          Save
        </button>
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
      {savedSearches.length > 0 && (
        <div className="saved-searches" aria-label="Saved searches">
          {savedSearches.map((query) => (
            <span className="saved-search" key={query}>
              <button className="saved-search-run" onClick={() => updateQuery(query)}>
                {query}
              </button>
              <button
                className="saved-search-remove"
                aria-label={`Remove saved search ${query}`}
                onClick={() => removeSavedSearch(query)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="search-filters" aria-label="Search filters">
        {SEARCH_FILTERS.map((filter) => (
          <button
            key={filter.ext}
            className={"search-filter" + (ext === filter.ext ? " active" : "")}
            onClick={() => applyFilter(filter.ext)}
            aria-pressed={ext === filter.ext}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <div className="search-body">
        <div
          className="palette-list search-results"
          aria-busy={!resultsCurrent}
        >
          {results.map((result, index) => (
            <SearchResultItem
              key={result.rel}
              result={result}
              index={index}
              selected={index === selClamped}
              interactive={resultsCurrent}
              term={term}
              onSelect={selectResult}
              onOpen={openActive}
            />
          ))}
          {term.length < 2 && !ext && (
            <div className="palette-empty">
              Type at least 2 characters, or filter by <code>ext:pdf</code>.
            </div>
          )}
          {!resultsCurrent && (term.length >= 2 || ext) && (
            <div className="palette-empty" role="status">
              Searching…
            </div>
          )}
          {resultsCurrent && (term.length >= 2 || ext) && results.length === 0 && (
            <div className="palette-empty">
              No matches. Try a shorter word or switch the filter above.
            </div>
          )}
          {/* Incomplete full-text coverage must never be silent — in either of
              its two forms. This one is transient: markdown is read before the
              first paint, and the search-only text streams in behind it, so a
              search run in the first moments after opening a large vault has
              not seen every file yet. */}
          {indexingTextFiles > 0 && (term.length >= 2 || ext) && (
            <div className="palette-empty" role="status">
              Search is ready. Results may grow while Mesa indexes{" "}
              {indexingTextFiles.toLocaleString()} more text{" "}
              {indexingTextFiles === 1 ? "file" : "files"}.
            </div>
          )}
          {/* This one is permanent: the vault's text exceeded the open-time
              cache budget, so those files can only ever match by name. Zero on
              normal vaults. */}
          {unindexedTextFiles > 0 && (term.length >= 2 || ext) && (
            <div className="palette-empty" role="status">
              Search covers file names now. {unindexedTextFiles.toLocaleString()} large text{" "}
              {unindexedTextFiles === 1 ? "file is" : "files are"} matched by
              name only because the full-text cache budget is limited.
            </div>
          )}
        </div>
        {previewTarget && (
          <div className="search-preview">
            <PreviewCard target={previewTarget} x={0} y={0} fixed />
          </div>
        )}
      </div>
    </div>
  );
}
