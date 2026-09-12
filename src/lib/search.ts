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

/**
 * Parse a search query, extracting an `ext:`/`type:` filter (and a bare
 * `.pdf` token) from the free-text term.
 *   "ext:pdf budget"    -> { term: "budget", ext: "pdf" }
 *   "type:md alpha"      -> { term: "alpha", ext: "md" }
 *   ".png"               -> { term: "", ext: "png" }
 *   '"exact phrase"'     -> { term: "exact phrase", quoted: true }
 *
 * Matching has always been plain substring matching, so a multi-word query is
 * already a phrase search. Quotes are accepted so that typing the phrase the
 * way people expect — with quotes around it — searches for the phrase rather
 * than for a term that literally contains quote characters. Inside quotes the
 * `ext:` and `.ext` tokens are NOT stripped, so a phrase may contain them.
 */
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

export function readableSearchSnippet(raw: string): string {
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

/**
 * Full-text vault search over the store's content cache.
 *
 * Matching is case-insensitive: the note text and the query are both lowered.
 * (Lowering only the text made every capitalised query — `Budget` against a
 * note literally containing "Budget" — return nothing at all.)
 *
 * `previous` enables incremental narrowing. Substring matching is monotone
 * under prefix extension: if `term` starts with `previous.term`, any file
 * containing `term` also contains `previous.term`, so `matches(term)` is a
 * subset of `previous.candidates` and the rest of the vault cannot match. That
 * makes every keystroke after the first scan only the surviving notes instead
 * of lowercasing the whole vault again. `candidates` is deliberately uncapped
 * so narrowing can never drop a note the display cap hid.
 *
 * The caller MUST discard `previous` whenever `files` or the content cache
 * changes identity — an edited note could newly match a term that had already
 * excluded it. Any other mismatch (backspace, paste, a changed `ext:` filter)
 * falls back to a full scan on its own.
 */
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

/**
 * A search pass that can be run in slices.
 *
 * A full pass over this corpus is 42–80 ms warm and several hundred under
 * memory pressure, and it ran synchronously inside a `useMemo` — so every
 * keystroke that cannot be narrowed from the previous pass froze the main
 * thread for that long, including the caret. `useDeferredValue` cannot help:
 * React can deprioritize the render, but it cannot interrupt a synchronous
 * loop once it starts.
 *
 * The work is unchanged and the result is byte-for-byte the same pass — only
 * the loop is resumable, so the caller can yield between slices. Ranking is
 * applied once at the end, so a partial scan is never displayed in the wrong
 * order; the caller keeps showing the previous completed pass until this one
 * finishes, exactly as the synchronous version did.
 */
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

/**
 * Files scanned between wall-clock checks.
 *
 * One, because a real corpus is not uniform: a single file here is 3.9 M
 * characters, and batching 32 of those before looking at the clock produced
 * 58–68 ms slices against an 8 ms budget. Checking every file costs about
 * 0.1 ms across the whole vault — far less than the overshoot it prevents.
 *
 * Eligible raw text also yields inside a large file. The Unicode fallback is
 * still atomic because lowercasing can change string length and raw offsets.
 */
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

    let idx = -1;
    let count = 0;
    if (term) {
      // U+0130 lowercases to `i` plus a combining dot. It can only contribute
      // to the one-character ASCII query "i"; a longer ASCII literal cannot
      // cross that non-ASCII combining mark. Every other ASCII matcher can
      // scan raw text safely without first making `canScanRawFor` walk a
      // 3.9 M-char file atomically merely to find U+0130. Raw offsets also fix
      // the old lowered-index/raw-snippet mismatch described in searchMatch.
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
