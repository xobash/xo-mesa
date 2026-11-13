// Linear CSS `url(…)` scanning and source-list splitting for saved HTML.

export interface CssUrlMatch {
  index: number;
  end: number;
  double?: string;
  single?: string;
  bare?: string;
}

const isCssSpace = (c: string) => /\s/.test(c);

/**
 * CSS `url(…)` tokens in one linear pass: `url("…")`, `url('…')` or a bare
 * value up to the first `)`, with surrounding whitespace outside the value.
 */
export function cssUrlMatches(css: string): CssUrlMatch[] {
  const out: CssUrlMatch[] = [];
  const next = new Map<string, number>();
  // indexOf(ch, from) memoized: a miss or a hit beyond `from` stays valid for later `from`.
  const find = (ch: string, from: number) => {
    const known = next.get(ch);
    if (known !== undefined && (known < 0 || known >= from)) return known;
    const at = css.indexOf(ch, from);
    next.set(ch, at);
    return at;
  };
  const opener = /url\(/gi;
  for (let m = opener.exec(css); m; m = opener.exec(css)) {
    let i = m.index + 4;
    while (i < css.length && isCssSpace(css[i])) i++;
    const c = css[i];
    if (c === undefined || c === ")") continue;
    let match: CssUrlMatch | null = null;
    if (c === '"' || c === "'") {
      const close = find(c, i + 1);
      if (close < 0) continue;
      let k = close + 1;
      while (k < css.length && isCssSpace(css[k])) k++;
      if (css[k] !== ")") continue;
      const value = css.slice(i + 1, close);
      match = c === '"' ? { index: m.index, end: k + 1, double: value } : { index: m.index, end: k + 1, single: value };
    } else {
      const close = find(")", i);
      if (close < 0) continue;
      match = { index: m.index, end: close + 1, bare: css.slice(i, close).trimEnd() };
    }
    out.push(match);
    opener.lastIndex = match.end;
  }
  return out;
}

/** Replace every CSS `url(…)` token; the replacer receives the quoted or bare value. */
export function replaceCssUrls(
  css: string,
  replacer: (full: string, doubleValue?: string, singleValue?: string, bareValue?: string) => string
): string {
  const matches = cssUrlMatches(css);
  if (!matches.length) return css;
  let out = "";
  let at = 0;
  for (const m of matches) {
    out += css.slice(at, m.index) + replacer(css.slice(m.index, m.end), m.double, m.single, m.bare);
    at = m.end;
  }
  return out + css.slice(at);
}

/** Split CSS source alternatives without splitting commas inside functions or strings. */
export function cssList(value: string): string[] {
  const items: string[] = [];
  let start = 0, depth = 0, quote = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\") { i++; continue; }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) { items.push(value.slice(start, i)); start = i + 1; }
  }
  items.push(value.slice(start));
  return items;
}
