/**
 * Minimal RTF → plain-text converter (no native deps). Handles the common
 * output of TextEdit/Word: groups, ignored destinations (fonttbl, colortbl,
 * stylesheet, pictures, …), \par/\line/\sect → newline, \tab, \'xx hex escapes,
 * and \uN unicode. Good enough to *read* an .rtf inside Mesa; it doesn't
 * preserve styling.
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

  while (i < n) {
    const c = rtf[i];

    if (c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      if (ignoring() && depth === ignoreAtDepth) ignoreAtDepth = -1;
      depth--;
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      i++; // raw line breaks in the source aren't content
      continue;
    }
    if (c !== "\\") {
      if (!ignoring()) out += c;
      i++;
      continue;
    }

    // c === "\\" — a control word, symbol, or escape
    const next = rtf[i + 1];
    if (next === "\\" || next === "{" || next === "}") {
      if (!ignoring()) out += next;
      i += 2;
      continue;
    }
    if (next === "'") {
      const code = parseInt(rtf.substr(i + 2, 2), 16);
      if (!ignoring() && !isNaN(code)) out += String.fromCharCode(code);
      i += 4;
      continue;
    }
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
          if (j < n && rtf[j] !== "\\" && rtf[j] !== "{" && rtf[j] !== "}") j++;
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

  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
