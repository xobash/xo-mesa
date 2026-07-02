export interface ParsedQuery {
  term: string;
  ext: string | null;
}

/**
 * Parse a search query, extracting an `ext:`/`type:` filter (and a bare
 * `.pdf` token) from the free-text term.
 *   "ext:pdf budget"  -> { term: "budget", ext: "pdf" }
 *   "type:md alpha"    -> { term: "alpha", ext: "md" }
 *   ".png"             -> { term: "", ext: "png" }
 */
export function parseSearchQuery(q: string): ParsedQuery {
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
  return { term: term.trim().replace(/\s+/g, " "), ext };
}
