/**
 * Minimal RTF → plain-text converter (no native deps). Handles the common
 * output of TextEdit/Word: groups, ignored destinations (fonttbl, colortbl,
 * stylesheet, pictures, …), \par/\line/\sect → newline, \tab, \'xx hex escapes
 * (Windows-1252), and \uN unicode with its \ucN-counted fallback skipped.
 * Good enough to *read* an .rtf inside Mesa; it doesn't preserve styling.
 */
const DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "pict",
  "object",
  "themedata",
  "colorschememapping",
  "latentstyles",
  "datastore",
  "generator",
  "listtable",
  "listoverridetable",
  "rsidtbl",
  "header",
  "footer",
  "headerl",
  "headerr",
  "footerl",
  "footerr",
  "pgdsctbl",
  "fldinst",
  "xmlnstbl",
]);

/** Windows-1252 characters for bytes 0x80-0x9F; undefined bytes keep their code. */
const CP1252_80_9F = "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f" +
  "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";

function ansiChar(code: number): string {
  return code >= 0x80 && code <= 0x9f ? CP1252_80_9F[code - 0x80] : String.fromCharCode(code);
}

export function rtfToText(rtf: string): string {
  if (typeof rtf !== "string") return "";
  if (!/\\rtf\d/.test(rtf)) return rtf; // not actually RTF — leave untouched

  let out = "";
  let i = 0;
  const n = rtf.length;
  let depth = 0;
  let ignoreAtDepth = -1; // when ≥0, skip output until this group depth closes
  let nextGroupIgnorable = false; // set by \*
  const ignoring = () => ignoreAtDepth !== -1;
  // \ucN: fallback units after each \uN, scoped to the group (default 1).
  const ucStack: number[] = [];
  let uc = 1;
  let skipFallback = 0;

  while (i < n) {
    const c = rtf[i];

    if (c === "{") {
      depth++;
      ucStack.push(uc);
      skipFallback = 0;
      i++;
      continue;
    }
    if (c === "}") {
      if (ignoring() && depth === ignoreAtDepth) ignoreAtDepth = -1;
      depth--;
      uc = ucStack.pop() ?? 1;
      skipFallback = 0;
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      i++; // raw line breaks in the source aren't content
      continue;
    }
    if (c !== "\\") {
      if (skipFallback > 0) skipFallback--;
      else if (!ignoring()) out += c;
      i++;
      continue;
    }

    // c === "\\" — a control word, symbol, or escape
    const next = rtf[i + 1];
    if (next === "\\" || next === "{" || next === "}") {
      if (skipFallback > 0) skipFallback--;
      else if (!ignoring()) out += next;
      i += 2;
      continue;
    }
    if (next === "'") {
      const code = parseInt(rtf.substr(i + 2, 2), 16);
      if (skipFallback > 0) skipFallback--;
      else if (!ignoring() && !isNaN(code)) out += ansiChar(code);
      i += 4;
      continue;
    }
    // Any other control ends an unfinished fallback.
    skipFallback = 0;
    if (next === "*") {
      nextGroupIgnorable = true;
      i += 2;
      continue;
    }
    if (next === "~") {
      if (!ignoring()) out += " ";
      i += 2;
      continue;
    }
    if (next === "\n" || next === "\r") {
      if (!ignoring()) out += "\n";
      i += 2;
      continue;
    }

    // control word: letters, optional signed number, optional one trailing space
    let j = i + 1;
    let word = "";
    while (j < n && /[A-Za-z]/.test(rtf[j])) {
      word += rtf[j];
      j++;
    }
    let num = "";
    if (rtf[j] === "-") {
      num = "-";
      j++;
    }
    while (j < n && rtf[j] >= "0" && rtf[j] <= "9") {
      num += rtf[j];
      j++;
    }
    if (rtf[j] === " ") j++;

    if (!ignoring()) {
      switch (word) {
        case "par":
        case "line":
        case "sect":
          out += "\n";
          break;
        case "tab":
          out += "\t";
          break;
        case "u": {
          const code = parseInt(num, 10);
          if (!isNaN(code)) out += String.fromCharCode(code < 0 ? code + 0x10000 : code);
          skipFallback = uc;
          break;
        }
        case "uc": {
          const count = parseInt(num, 10);
          uc = Number.isFinite(count) && count >= 0 ? count : 1;
          break;
        }
        default:
          if (DESTINATIONS.has(word)) ignoreAtDepth = depth;
      }
    }
    if (nextGroupIgnorable) {
      ignoreAtDepth = depth;
      nextGroupIgnorable = false;
    }
    i = j;
  }

  // Consume each whitespace run once. A trailing-newline requirement would
  // retry the same run at every space when the next character is not a newline.
  return out.replace(/[ \t]+/g, (spaces, at: number) =>
    out[at + spaces.length] === "\n" ? "" : spaces
  ).replace(/\n{3,}/g, "\n\n").trim();
}
