import { buildRawMatcher, canScanRawFor, scanRaw } from "./searchMatch";

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
  const parsed = parseSearchQuery(query);
  const ext = parsed.ext;
  const term = parsed.term.toLowerCase();

  if (term.length < 2 && !ext) {
    return { hits: [], candidates: null, term, ext };
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
  // text containing U+0130 fall back to the exact lowercase path; see
  // `searchMatch.ts` for why the two are equivalent.
  const rawMatcher = term ? buildRawMatcher(term) : null;

  const hits: SearchHit[] = [];
  const candidates: SearchFile[] = [];

  for (const f of scanned) {
    if (ext && f.ext.toLowerCase() !== ext) continue;
    const nameHit = term ? f.name.toLowerCase().includes(term) : true;
    const raw = cache[f.relPath] ?? "";

    let idx = -1;
    let count = 0;
    if (term) {
      if (rawMatcher && canScanRawFor(f.relPath, raw)) {
        const scan = scanRaw(raw, rawMatcher, term.length);
        idx = scan.first;
        count = counter ? scan.count : 0;
      } else {
        const text = raw.toLowerCase();
        idx = text.indexOf(term);
        count = counter ? (text.match(counter) || []).length : 0;
      }
    }
    if (term && idx < 0 && !nameHit) continue;
    candidates.push(f);

    let snippet = "";
    if (idx >= 0) {
      const start = Math.max(0, idx - 32);
      snippet =
        (start > 0 ? "..." : "") +
        raw.slice(start, idx + term.length + 60).replace(/\s+/g, " ") +
        "...";
    } else if (!term) {
      snippet = f.relPath;
    }
    hits.push({ rel: f.relPath, title: f.name, ext: f.ext, snippet, count });
  }

  hits.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
  return {
    hits: hits.slice(0, SEARCH_RESULT_LIMIT),
    candidates,
    term,
    ext,
  };
}
