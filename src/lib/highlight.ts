/**
 * Tiny, dependency-free syntax highlighter + delimited-data parser used by the
 * code/text viewer (`CodeView`). It is deliberately language-agnostic: a single
 * scanner recognises line/block comments, strings, numbers and keywords, driven
 * by a small per-language spec. Pure (no DOM) so it's unit-tested.
 */

export type TokType = "plain" | "comment" | "string" | "number" | "keyword";
export interface Token {
  type: TokType;
  value: string;
}

interface LangSpec {
  /** Line-comment markers. Alphabetic markers (e.g. `rem`) only match at line start. */
  line: string[];
  /** Block comment [open, close], if any. */
  block?: [string, string];
  /** Quote characters that open/close strings. */
  quotes: string[];
  keywords: Set<string>;
}

const kw = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const JS = kw(
  "const let var function return if else for while do switch case break continue " +
    "class extends new this super import export from default await async yield try " +
    "catch finally throw typeof instanceof in of void delete null undefined true false"
);
const PY = kw(
  "def class return if elif else for while import from as with try except finally " +
    "raise lambda yield await async pass break continue global nonlocal None True False and or not in is"
);
const SHELL = kw("if then else elif fi for in do done case esac function while until echo export local return true false");

const LANGS: Record<string, LangSpec> = {
  js: { line: ["//"], block: ["/*", "*/"], quotes: ['"', "'", "`"], keywords: JS },
  json: { line: [], quotes: ['"'], keywords: kw("true false null") },
  yaml: { line: ["#"], quotes: ['"', "'"], keywords: kw("true false null yes no on off") },
  toml: { line: ["#"], quotes: ['"', "'"], keywords: kw("true false") },
  ini: { line: ["#", ";"], quotes: ['"', "'"], keywords: kw("true false") },
  shell: { line: ["#"], quotes: ['"', "'"], keywords: SHELL },
  python: { line: ["#"], quotes: ['"', "'"], keywords: PY },
  powershell: { line: ["#"], block: ["<#", "#>"], quotes: ['"', "'"], keywords: kw("if else elseif function return param foreach while do switch try catch finally throw $true $false $null") },
  bat: { line: ["::", "rem"], quotes: ['"'], keywords: kw("echo set if else for goto call exit rem setlocal endlocal") },
  xml: { line: [], block: ["<!--", "-->"], quotes: ['"', "'"], keywords: new Set<string>() },
  css: { line: [], block: ["/*", "*/"], quotes: ['"', "'"], keywords: new Set<string>() },
  sql: { line: ["--"], block: ["/*", "*/"], quotes: ["'"], keywords: kw("select from where insert update delete create table drop alter join on group by order having limit null true false") },
  text: { line: [], quotes: [], keywords: new Set<string>() },
};

const EXT_LANG: Record<string, string> = {
  js: "js", jsx: "js", ts: "js", tsx: "js", mjs: "js", cjs: "js",
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  ini: "ini", conf: "ini", cfg: "ini", properties: "ini", env: "ini",
  sh: "shell", bash: "shell", zsh: "shell",
  py: "python",
  ps1: "powershell", psm1: "powershell",
  bat: "bat", cmd: "bat",
  xml: "xml", svg: "xml", html: "xml", htm: "xml",
  css: "css", scss: "css", less: "css",
  sql: "sql",
  log: "text", txt: "text", text: "text",
};

/** Map a file extension to a highlighter language key (defaults to "text"). */
export function langForExt(ext: string): string {
  return EXT_LANG[ext.toLowerCase()] ?? "text";
}

const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

/** Tokenise source into a flat list of typed tokens (newlines kept in values). */
export function tokenize(src: string, lang: string): Token[] {
  const spec = LANGS[lang] ?? LANGS.text;
  const out: Token[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      out.push({ type: "plain", value: plain });
      plain = "";
    }
  };
  let i = 0;
  let atLineStart = true; // only whitespace seen since the last newline
  const n = src.length;
  while (i < n) {
    const c = src[i];

    // block comment
    if (spec.block && src.startsWith(spec.block[0], i)) {
      flush();
      const end = src.indexOf(spec.block[1], i + spec.block[0].length);
      const stop = end < 0 ? n : end + spec.block[1].length;
      out.push({ type: "comment", value: src.slice(i, stop) });
      i = stop;
      atLineStart = false;
      continue;
    }

    // line comment
    let matchedLine = false;
    for (const m of spec.line) {
      const alpha = /[A-Za-z]/.test(m[0]);
      if (alpha && !atLineStart) continue;
      if (!src.slice(i, i + m.length).toLowerCase().startsWith(m.toLowerCase())) continue;
      // alphabetic markers need a word boundary after (so "rem" not "remix")
      if (alpha && isIdent(src[i + m.length] ?? " ")) continue;
      flush();
      let end = src.indexOf("\n", i);
      if (end < 0) end = n;
      out.push({ type: "comment", value: src.slice(i, end) });
      i = end;
      matchedLine = true;
      break;
    }
    if (matchedLine) continue;

    // string
    if (spec.quotes.includes(c)) {
      flush();
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j++;
          break;
        }
        if (src[j] === "\n" && c !== "`") {
          break; // unterminated single-line string
        }
        j++;
      }
      out.push({ type: "string", value: src.slice(i, j) });
      i = j;
      atLineStart = false;
      continue;
    }

    // number (not when part of an identifier)
    if (isDigit(c) && !(plain && isIdent(plain[plain.length - 1]))) {
      flush();
      let j = i;
      while (j < n && /[0-9._xXa-fA-F]/.test(src[j])) j++;
      out.push({ type: "number", value: src.slice(i, j) });
      i = j;
      atLineStart = false;
      continue;
    }

    // identifier / keyword
    if (isIdent(c) && /[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && isIdent(src[j])) j++;
      const word = src.slice(i, j);
      if (spec.keywords.has(word)) {
        flush();
        out.push({ type: "keyword", value: word });
      } else {
        plain += word;
      }
      i = j;
      atLineStart = false;
      continue;
    }

    // plain char
    plain += c;
    atLineStart = c === "\n" ? true : c === " " || c === "\t" ? atLineStart : false;
    i++;
  }
  flush();
  return out;
}

/**
 * Parse delimited data (CSV/TSV) into rows of fields, honouring quoted fields
 * with embedded delimiters/newlines and "" escaped quotes (RFC 4180-ish).
 */
export function parseDelimited(text: string, delim = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === delim) {
      pushField();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // trailing field/row (ignore a final empty line)
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}
