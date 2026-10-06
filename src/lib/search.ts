import { documentMayMatch } from "./documentWorkingSet";
import {
  buildRawMatcher,
  canScanRawFor,
  createIncrementalRawScan,
  type IncrementalRawScan,
} from "./searchMatch";

export interface ParsedQuery {
  term: string;
  ext: string | null;
  /** True when the term came from an explicitly quoted phrase. */
  quoted: boolean;
}

/** Extract ext:/type: filters and unquoted .ext tokens. Matching is substring-based;
 * quoted phrases preserve literal filter tokens. */
export function parseSearchQuery(q: string): ParsedQuery {
  const quotedMatch = /^\s*"([^"]*)"\s*$/.exec(q);
  if (quotedMatch) {
    return {
      term: quotedMatch[1].trim().replace(/\s+/g, " "),
      ext: null,
      quoted: true,
    };
  }
  let ext: string | null = null;
  let term = q.replace(/\b(?:ext|type):([A-Za-z0-9]+)/gi, (_m, e: string) => {
    ext = e.toLowerCase();
    return "";
  });
  // a lone ".ext" token also sets the filter
  term = term.replace(/(?:^|\s)\.([A-Za-z0-9]{1,8})(?=\s|$)/g, (_m, e: string) => {
    if (!ext) ext = e.toLowerCase();
    return " ";
  });
  // A quoted phrase alongside a filter: "ext:md \"exact phrase\"".
  const inner = /^\s*"([^"]*)"\s*$/.exec(term);
  if (inner) {
    return { term: inner[1].trim().replace(/\s+/g, " "), ext, quoted: true };
  }
  return { term: term.trim().replace(/\s+/g, " "), ext, quoted: false };
}

/** The subset of `VaultFile` vault search reads. */
export interface SearchFile {
  relPath: string;
  name: string;
  ext: string;
}

export interface SearchHit {
  rel: string;
  title: string;
  ext: string;
  snippet: string;
  count: number;
}

export interface SearchPass {
  /** Ranked, capped hits to render. */
  hits: SearchHit[];
  /**
   * Every file that matched, uncapped and in `files` order — the candidate set
   * a narrower term may be scanned against. `null` means this pass did not scan
   * (too-short term), so nothing may be narrowed from it.
   */
  candidates: SearchFile[] | null;
  /** Lowercased term this pass matched on. */
  term: string;
  /** Extension filter this pass applied. */
  ext: string | null;
}

export const SEARCH_RESULT_LIMIT = 100;

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const HTML_ENTITY: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function readableSearchSnippet(raw: string): string {
  return raw
    .replace(/!\[\[([^\]\n]+?)\]\]/g, (_m, target: string) => readableWikiTarget(target))
    .replace(/\[\[([^\]\n]+?)\]\]/g, (_m, target: string) => readableWikiTarget(target))
    .replace(/!\[[^\]\n]*\]\([^)]+?\)/g, "")
    .replace(/\[([^\]\n]+?)\]\([^)]+?\)/g, "$1")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/&([a-z]+);/gi, (_m, entity: string) => HTML_ENTITY[entity.toLowerCase()] ?? " ")
    .replace(/&#(\d+);/g, (_m, code: string) => safeEntity(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => safeEntity(Number.parseInt(code, 16)))
    .replace(/[`*_~>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readableWikiTarget(target: string): string {
  const [pathAndHeading, alias] = target.split("|");
  if (alias?.trim()) return alias.trim();
  const withoutHeading = (pathAndHeading ?? "").split("#")[0] ?? "";
  const base = withoutHeading.split("/").pop() || withoutHeading;
  return base.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim();
}

function safeEntity(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return " ";
  try {
    return String.fromCodePoint(code);
  } catch {
    return " ";
  }
}

/** Case-insensitive substring search with optional prefix narrowing over uncapped candidates.
 * Discard previous results when files or content identity changes. */
export function searchVault(
  files: readonly SearchFile[],
  cache: Record<string, string>,
  query: string,
  previous?: SearchPass | null
): SearchPass {
  const scan = createSearchScan(files, cache, query, previous);
  while (!scan.advance(Infinity)) {
    /* one unbounded slice */
  }
  return scan.result();
}

/** Resumable search pass. Callers yield between slices and publish only the
 * completed result, since ranking is applied after scanning. */
export interface SearchScan {
  /**
   * Scan for up to `budgetMs` of wall time (at least one file per call, so
   * progress is guaranteed). Returns true when the pass is complete.
   */
  advance(budgetMs: number): boolean;
  /** The finished pass. Only meaningful once `advance` has returned true. */
  result(): SearchPass;
  /** Files not yet scanned — 0 once complete. */
  readonly remaining: number;
}

/** Check the time budget after each file; file sizes vary.
 * Large-file matching also yields within a file. */
const SCAN_CHECK_INTERVAL = 1;

export function createSearchScan(
  files: readonly SearchFile[],
  cache: Record<string, string>,
  query: string,
  previous?: SearchPass | null
): SearchScan {
  const parsed = parseSearchQuery(query);
  const ext = parsed.ext;
  const term = parsed.term.toLowerCase();

  if (term.length < 2 && !ext) {
    const empty: SearchPass = { hits: [], candidates: null, term, ext };
    return { advance: () => true, result: () => empty, remaining: 0 };
  }

  const reusable =
    previous != null &&
    previous.candidates !== null &&
    previous.ext === ext &&
    term.startsWith(previous.term);
  const scanned: readonly SearchFile[] = reusable
    ? (previous as SearchPass).candidates!
    : files;

  // Counting is what ranks the list; a 1-char term (only reachable alongside an
  // `ext:` filter) stays unranked, exactly as before.
  const counter =
    term.length >= 2
      ? new RegExp(term.replace(REGEX_SPECIAL, "\\$&"), "g")
      : null;
  // One reusable matcher for the whole pass. It runs against RAW text, so no
  // per-file lowercased copy is allocated — the cost that made searching a
  // vault whose text is fully cached unaffordable. `null` (non-ASCII term) and
  // a one-character `i` query against text containing U+0130 fall back to the
  // exact lowercase path; see `searchMatch.ts` for why the paths are equivalent.
  const rawMatcher = term ? buildRawMatcher(term) : null;

  const hits: SearchHit[] = [];
  const candidates: SearchFile[] = [];
  let next = 0;
  let active: {
    file: SearchFile;
    raw: string;
    nameHit: boolean;
    scan: IncrementalRawScan;
    countMatches: boolean;
  } | null = null;
  let finished: SearchPass | null = null;

  return {
    get remaining() {
      return scanned.length - next + (active ? 1 : 0);
    },
    advance(budgetMs: number): boolean {
      if (finished) return true;
      const start = budgetMs === Infinity ? 0 : performance.now();
      while (active || next < scanned.length) {
        if (active) {
          if (active.scan.advance()) {
            const { first, count } = active.scan.result();
            finishOne(
              active.file,
              active.raw,
              active.nameHit,
              first,
              active.countMatches ? count : 0
            );
            active = null;
          }
        } else {
          const f = scanned[next++];
          beginOne(f);
        }
        if (
          budgetMs !== Infinity &&
          (active !== null || next % SCAN_CHECK_INTERVAL === 0) &&
          performance.now() - start >= budgetMs
        ) {
          return false;
        }
      }
      hits.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
      finished = {
        hits: hits.slice(0, SEARCH_RESULT_LIMIT),
        candidates,
        term,
        ext,
      };
      return true;
    },
    result(): SearchPass {
      // Callers are expected to drive `advance` to completion first; finishing
      // here keeps a misuse from silently returning a partial pass.
      if (!finished) {
        while (!this.advance(Infinity)) {
          /* drain */
        }
      }
      return finished!;
    },
  };

  function beginOne(f: SearchFile): void {
    if (ext && f.ext.toLowerCase() !== ext) return;
    const nameHit = term ? f.name.toLowerCase().includes(term) : true;
    if (!nameHit && !documentMayMatch(cache, f.relPath, term)) return;
    const raw = cache[f.relPath] ?? "";

    const idx = -1;
    const count = 0;
    if (term) {
      // U+0130 lowercases to i plus a combining dot, so only the single-character
      // ASCII query i needs special handling. Snippets must index raw text.
      const canUseRaw =
        rawMatcher && (term !== "i" || canScanRawFor(f.relPath, raw));
      if (canUseRaw) {
        active = {
          file: f,
          raw,
          nameHit,
          scan: createIncrementalRawScan(raw, rawMatcher, term.length),
          countMatches: counter !== null,
        };
        return;
      } else {
        const text = raw.toLowerCase();
        const exactMatcher = new RegExp(term.replace(REGEX_SPECIAL, "\\$&"), "g");
        active = {
          file: f,
          raw,
          nameHit,
          scan: createIncrementalRawScan(text, exactMatcher, term.length),
          countMatches: counter !== null,
        };
        return;
      }
    }
    finishOne(f, raw, nameHit, idx, count);
  }

  function finishOne(
    f: SearchFile,
    raw: string,
    nameHit: boolean,
    idx: number,
    count: number
  ): void {
    if (term && idx < 0 && !nameHit) return;
    candidates.push(f);

    let snippet = "";
    if (idx >= 0) {
      const start = Math.max(0, idx - 32);
      snippet =
        (start > 0 ? "..." : "") +
        readableSearchSnippet(raw.slice(start, idx + term.length + 60)) +
        "...";
    } else if (!term) {
      snippet = f.relPath;
    }
    hits.push({ rel: f.relPath, title: f.name, ext: f.ext, snippet, count });
  }
}
