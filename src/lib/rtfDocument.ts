/**
 * RTF document model for the rich RTF editor.
 *
 * The parser never rebuilds a file. It records every visible character, line
 * break, paragraph break and embedded object ("atom") with the exact source
 * span that produced it. Everything else — header tables, unknown control
 * words, destinations, raw line breaks — is skeleton that an edit keeps
 * byte for byte (`rtfEdit.ts`). Constructs the model cannot keep apart from
 * text (tables, section/page breaks, undecodable code pages, raw 8-bit text)
 * make the document read-only with a stated reason.
 *
 * The source string is the file's bytes decoded one byte per character
 * (Latin-1), so string offsets are byte offsets.
 */
import { cp1252Char } from "./cp1252";

export interface RtfFormat {
  b: boolean;
  i: boolean;
  ul: boolean;
  strike: boolean;
  /** Half-points (RTF `\fs`). */
  fs: number;
  f: number;
  cf: number;
  cb: number;
  hl: number;
  va: "" | "super" | "sub";
}

export interface RtfParagraphStyle {
  align: "left" | "center" | "right" | "justify";
  /** Twips. */
  li: number;
  ri: number;
  fi: number;
  sb: number;
  sa: number;
}

interface UnitSpan {
  /** Source span; `start === end` only for units Mesa inserts. */
  start: number;
  end: number;
  /** Character state in force where the unit's token starts. */
  fmt: RtfFormat;
}
export type RtfUnit =
  | (UnitSpan & { kind: "char"; ch: string })
  | (UnitSpan & { kind: "par" })
  | (UnitSpan & { kind: "atom"; id: number; label: string; text: string });

export interface RtfFont {
  name: string;
  charset: number;
}

export interface RtfDocument {
  source: string;
  units: RtfUnit[];
  /** One style per paragraph: the paragraph count is par units + 1. */
  paragraphs: RtfParagraphStyle[];
  fonts: Map<number, RtfFont>;
  /** CSS colours by `\cf` index; null is "automatic". */
  colors: (string | null)[];
  /** Insertion point and state when there is no unit to anchor to. */
  endInsert: number;
  endFmt: RtfFormat;
  readOnlyReason: string | null;
}

/** Invisible destinations: kept as skeleton, never shown. */
const SKIP_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "themedata", "colorschememapping",
  "latentstyles", "datastore", "generator", "listtable", "listoverridetable",
  "rsidtbl", "header", "footer", "headerl", "headerr", "headerf", "footerl",
  "footerr", "footerf", "pgdsctbl", "xmlnstbl", "nonshppict", "fldinst",
  "filetbl", "revtbl", "mmathPr", "wgrffmtfilter", "pnseclvl", "author",
  "operator", "title", "subject", "keywords", "comment", "doccomm", "company",
  "expandedcolortbl", "listpicture", "bkmkstart", "bkmkend", "xe", "tc",
  "template", "protusertbl", "aftnsep", "ftnsep", "ftnsepc", "aftnsepc",
]);

/** Visible destinations shown as one non-editable object, kept verbatim. */
const ATOM_LABELS: Record<string, string> = {
  pict: "[picture]",
  shppict: "[picture]",
  shp: "[shape]",
  object: "[embedded object]",
  field: "",
  footnote: "[footnote]",
  annotation: "[comment]",
  listtext: "",
  pntext: "",
};
/** Atoms whose own text is shown (field results, list markers). */
const ATOM_SHOWS_TEXT = new Set(["field", "listtext", "pntext"]);

const READ_ONLY_WORDS: Record<string, string> = {
  trowd: "it contains a table",
  cell: "it contains a table",
  row: "it contains a table",
  intbl: "it contains a table",
  nestcell: "it contains a table",
  sect: "it contains section breaks",
  page: "it contains page breaks",
  column: "it contains column breaks",
  upr: "it uses dual ANSI/Unicode text groups",
};

const SYMBOL_WORDS: Record<string, string> = {
  emdash: "—", endash: "–", bullet: "•", lquote: "‘",
  rquote: "’", ldblquote: "“", rdblquote: "”", emspace: " ",
  enspace: " ", qmspace: " ", zwj: "‍", zwnj: "‌",
  ltrmark: "‎", rtlmark: "‏",
};

const DECODABLE_CHARSETS = new Set([0, 1]);

export function defaultFormat(deff = 0): RtfFormat {
  return { b: false, i: false, ul: false, strike: false, fs: 24, f: deff, cf: 0, cb: 0, hl: 0, va: "" };
}
function defaultParagraph(): RtfParagraphStyle {
  return { align: "left", li: 0, ri: 0, fi: 0, sb: 0, sa: 0 };
}
export function sameFormat(a: RtfFormat, b: RtfFormat): boolean {
  return a.b === b.b && a.i === b.i && a.ul === b.ul && a.strike === b.strike && a.fs === b.fs &&
    a.f === b.f && a.cf === b.cf && a.cb === b.cb && a.hl === b.hl && a.va === b.va;
}

type Dest = "body" | "skip" | "atom" | "fonttbl" | "colortbl";
interface Frame {
  fmt: RtfFormat;
  para: RtfParagraphStyle;
  uc: number;
  dest: Dest;
  /** True until the group's first control or text token is seen. */
  fresh: boolean;
  /** Set when this frame opened an atom. */
  atom: { start: number; fmt: RtfFormat; word: string; text: string } | null;
}

interface Tok {
  kind: "open" | "close" | "word" | "sym" | "hex" | "text" | "raw";
  start: number;
  end: number;
  word?: string;
  param?: number;
  ch?: string;
}

const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number) => c >= 48 && c <= 57;

/** Read one token at `i`. Linear: every token consumes at least one byte. */
function readToken(src: string, i: number): Tok {
  const c = src.charCodeAt(i);
  if (c === 123) return { kind: "open", start: i, end: i + 1 };
  if (c === 125) return { kind: "close", start: i, end: i + 1 };
  if (c === 13 || c === 10) return { kind: "raw", start: i, end: i + 1 };
  if (c !== 92) return { kind: "text", start: i, end: i + 1, ch: src[i] };
  const n = src.charCodeAt(i + 1);
  if (Number.isNaN(n)) return { kind: "raw", start: i, end: i + 1 };
  if (n === 39) {
    const code = parseInt(src.substr(i + 2, 2), 16);
    return { kind: "hex", start: i, end: Math.min(src.length, i + 4), param: Number.isNaN(code) ? -1 : code };
  }
  if (!isLetter(n)) return { kind: "sym", start: i, end: i + 2, ch: src[i + 1] };
  let j = i + 1;
  while (j < src.length && j - i <= 33 && isLetter(src.charCodeAt(j))) j++;
  const word = src.slice(i + 1, j);
  let k = j;
  if (src[k] === "-") k++;
  while (k < src.length && k - j <= 11 && isDigit(src.charCodeAt(k))) k++;
  const hasParam = k > j && src.slice(j, k) !== "-";
  const param = hasParam ? parseInt(src.slice(j, k), 10) : undefined;
  if (!hasParam) k = j;
  if (src[k] === " ") k++;
  return { kind: "word", start: i, end: k, word, param };
}

class Parser {
  readonly units: RtfUnit[] = [];
  readonly paragraphs: RtfParagraphStyle[] = [];
  readonly fonts = new Map<number, RtfFont>();
  readonly colors: (string | null)[] = [];
  readonly stack: Frame[] = [];
  reason: string | null = null;
  deff = 0;
  codepage = 1252;
  fontName = "";
  fontId = 0;
  fontCharset = 0;
  rgb: [number, number, number] | null = null;
  pendingStar = false;
  endInsert = -1;
  endFmt = defaultFormat();
  atomId = 0;
  frame: Frame = { fmt: defaultFormat(), para: defaultParagraph(), uc: 1, dest: "body", fresh: false, atom: null };

  constructor(readonly src: string) {}

  refuse(reason: string): void {
    if (!this.reason) this.reason = reason;
  }

  run(): void {
    const src = this.src;
    if (!/^\s*\{\\rtf/.test(src.slice(0, 64))) {
      this.refuse("it is not an RTF document");
      return;
    }
    let i = 0;
    let closedTop = false;
    while (i < src.length) {
      const tok = readToken(src, i);
      i = tok.end;
      if (closedTop) {
        if (tok.kind !== "raw" && !(tok.kind === "text" && /\s|\0/.test(tok.ch ?? ""))) {
          this.refuse("it has content after the end of the document");
        }
        continue;
      }
      if (tok.kind === "close" && this.stack.length === 1) {
        this.endInsert = tok.start;
        this.endFmt = this.frame.fmt;
        this.paragraphs.push({ ...this.frame.para });
        closedTop = true;
      }
      i = this.token(tok, i);
    }
    if (!closedTop) {
      this.refuse("its groups are not balanced");
      this.paragraphs.push({ ...this.frame.para });
    }
  }

  /** Apply one token; returns the next read offset (`\u` fallbacks and `\bin` move it). */
  token(tok: Tok, next: number): number {
    switch (tok.kind) {
      case "open": this.open(); return next;
      case "close": this.close(tok); return next;
      case "raw": return next;
      case "text": this.text(tok, tok.ch!); return next;
      case "hex": this.hex(tok); return next;
      case "sym": this.symbol(tok); return next;
      default: return this.word(tok, next);
    }
  }

  open(): void {
    this.stack.push(this.frame);
    const parent = this.frame;
    this.frame = { fmt: { ...parent.fmt }, para: { ...parent.para }, uc: parent.uc, dest: parent.dest, fresh: true, atom: null };
  }

  close(tok: Tok): void {
    const done = this.frame;
    const parent = this.stack.pop();
    if (!parent) {
      this.refuse("its groups are not balanced");
      return;
    }
    if (done.dest === "fonttbl" && this.fontName) this.finishFont();
    this.frame = parent;
    this.pendingStar = false;
    if (done.atom) {
      const a = done.atom;
      this.units.push({ kind: "atom", id: this.atomId++, label: ATOM_LABELS[a.word] ?? "[object]",
        text: ATOM_SHOWS_TEXT.has(a.word) ? a.text : "", start: a.start, end: tok.end, fmt: a.fmt });
    }
    // Paragraph properties are group-scoped, but a paragraph ended inside a
    // group keeps the style it had at its \par.
  }

  /** Emit visible text according to the current destination. */
  emit(tok: Tok, ch: string): void {
    const f = this.frame;
    f.fresh = false;
    if (f.dest === "body") this.units.push({ kind: "char", ch, start: tok.start, end: tok.end, fmt: f.fmt });
    else if (f.dest === "atom") {
      const atom = this.atomFrame()!;
      if (ATOM_SHOWS_TEXT.has(atom.word)) atom.text += ch;
    }
    else if (f.dest === "fonttbl") this.fontText(ch);
  }

  atomFrame(): Frame["atom"] {
    if (this.frame.atom) return this.frame.atom;
    for (let k = this.stack.length - 1; k >= 0; k--) if (this.stack[k].atom) return this.stack[k].atom;
    return null;
  }

  text(tok: Tok, ch: string): void {
    const code = ch.charCodeAt(0);
    if (this.frame.dest === "colortbl") {
      if (ch === ";") this.finishColor();
      return;
    }
    if (code >= 0x80 && (this.frame.dest === "body" || this.frame.dest === "atom")) {
      this.refuse("it contains raw 8-bit characters whose encoding is unknown");
    }
    if (code === 0) return;
    this.emit(tok, ch);
  }

  hex(tok: Tok): void {
    const code = tok.param ?? -1;
    if (code < 0) {
      this.refuse("it contains a malformed \\' escape");
      return;
    }
    const dest = this.frame.dest;
    if (code >= 0x80 && (dest === "body" || dest === "atom")) {
      const charset = this.fonts.get(this.frame.fmt.f)?.charset ?? 0;
      if (this.codepage !== 1252 || !DECODABLE_CHARSETS.has(charset)) {
        this.refuse(`it uses a character set Mesa cannot decode (code page ${this.codepage}, charset ${charset})`);
      }
    }
    const ch = cp1252Char(code);
    this.emit(tok, ch);
  }

  symbol(tok: Tok): void {
    const s = tok.ch!;
    if (s === "*") {
      this.pendingStar = true;
      return;
    }
    if (s === "\\" || s === "{" || s === "}") return this.emit(tok, s);
    if (s === "~") return this.emit(tok, " ");
    if (s === "_") return this.emit(tok, "‑");
    if (s === "\n" || s === "\r") return this.paragraph(tok);
    this.frame.fresh = false;
  }

  paragraph(tok: Tok): void {
    const f = this.frame;
    f.fresh = false;
    if (f.dest === "body") {
      this.units.push({ kind: "par", start: tok.start, end: tok.end, fmt: f.fmt });
      this.paragraphs.push({ ...f.para });
    } else if (f.dest === "atom") this.emit(tok, " ");
  }

  word(tok: Tok, next: number): number {
    const word = tok.word!;
    const f = this.frame;
    const star = this.pendingStar;
    this.pendingStar = false;
    if (f.fresh) {
      f.fresh = false;
      if (this.destination(tok, word, star)) return next;
    }
    if (word === "bin") return this.binary(tok, next);
    if (f.dest === "skip") return next;
    if (f.dest === "fonttbl") return this.fontWord(word, tok.param), next;
    if (f.dest === "colortbl") return this.colorWord(word, tok.param), next;
    const readOnly = READ_ONLY_WORDS[word];
    if (readOnly && f.dest === "body") this.refuse(readOnly);
    if (word === "u") return this.unicode(tok, next);
    if (word === "par") return this.paragraph(tok), next;
    if (word === "line") return this.emit(tok, "\n"), next;
    if (word === "tab") return this.emit(tok, "\t"), next;
    const symbol = SYMBOL_WORDS[word];
    if (symbol) return this.emit(tok, symbol), next;
    this.header(word, tok.param);
    this.formatWord(word, tok.param);
    return next;
  }

  /** The first control word of a group can make it a destination. */
  destination(tok: Tok, word: string, star: boolean): boolean {
    const f = this.frame;
    const groupStart = this.groupStart(tok.start);
    if (word === "fonttbl") return (f.dest = "fonttbl"), true;
    if (word === "colortbl") return (f.dest = "colortbl"), true;
    if (f.dest === "body" && word in ATOM_LABELS) {
      const parent = this.stack[this.stack.length - 1];
      f.dest = "atom";
      f.atom = { start: groupStart, fmt: parent.fmt, word, text: "" };
      return true;
    }
    if (f.dest === "atom" && word === "fldrslt") return true;
    if (star || SKIP_DESTINATIONS.has(word)) return (f.dest = "skip"), true;
    return false;
  }

  /** Offset of the `{` that opened the current group (skipping `\*`). */
  groupStart(at: number): number {
    let k = at - 1;
    while (k >= 0 && this.src[k] !== "{") k--;
    return Math.max(0, k);
  }

  binary(tok: Tok, next: number): number {
    if (this.frame.dest === "body") this.refuse("it contains raw binary data");
    return Math.min(this.src.length, next + Math.max(0, tok.param ?? 0));
  }

  /** `\uN` plus its `\ucN` fallback units form one character. */
  unicode(tok: Tok, next: number): number {
    let end = next;
    for (let n = 0; n < this.frame.uc && end < this.src.length; n++) {
      const c = this.src[end];
      if (c === "{" || c === "}" || c === "\r" || c === "\n") break;
      if (c === "\\") {
        if (this.src[end + 1] !== "'") break;
        end += 4;
      } else end += 1;
    }
    const code = tok.param ?? 63;
    this.emit({ ...tok, end }, String.fromCharCode(code < 0 ? code + 0x10000 : code));
    return end;
  }

  header(word: string, param: number | undefined): void {
    if (word === "deff" && param !== undefined) this.deff = param;
    else if (word === "ansicpg" && param !== undefined) this.codepage = param;
    else if (word === "mac") this.codepage = 10000;
    else if (word === "pc") this.codepage = 437;
    else if (word === "pca") this.codepage = 850;
    else if (word === "uc") this.frame.uc = param !== undefined && param >= 0 ? param : 1;
  }

  formatWord(word: string, param: number | undefined): void {
    const f = this.frame;
    const on = param === undefined || param !== 0;
    const fmt = { ...f.fmt };
    const para = f.para;
    switch (word) {
      case "plain": Object.assign(fmt, defaultFormat(this.deff)); break;
      case "b": fmt.b = on; break;
      case "i": fmt.i = on; break;
      case "strike": fmt.strike = on; break;
      case "ul": case "uld": case "uldb": case "ulw": case "ulwave": case "uldash": case "ulth": fmt.ul = on; break;
      case "ulnone": fmt.ul = false; break;
      case "fs": fmt.fs = param ?? 24; break;
      case "f": fmt.f = param ?? this.deff; break;
      case "cf": fmt.cf = param ?? 0; break;
      case "cb": case "chcbpat": fmt.cb = param ?? 0; break;
      case "highlight": fmt.hl = param ?? 0; break;
      case "super": fmt.va = "super"; break;
      case "sub": fmt.va = "sub"; break;
      case "nosupersub": fmt.va = ""; break;
      case "pard": Object.assign(para, defaultParagraph()); return;
      case "ql": para.align = "left"; return;
      case "qc": para.align = "center"; return;
      case "qr": para.align = "right"; return;
      case "qj": para.align = "justify"; return;
      case "li": case "ri": case "fi": case "sb": case "sa": para[word] = param ?? 0; return;
      default: return;
    }
    f.fmt = fmt;
  }

  fontWord(word: string, param: number | undefined): void {
    if (word === "f" && param !== undefined) {
      if (this.fontName) this.finishFont();
      this.fontId = param;
      this.fontCharset = 0;
    } else if (word === "fcharset" && param !== undefined) this.fontCharset = param;
  }

  fontText(ch: string): void {
    if (ch === ";") this.finishFont();
    else this.fontName += ch;
  }

  finishFont(): void {
    this.fonts.set(this.fontId, { name: this.fontName.trim(), charset: this.fontCharset });
    this.fontName = "";
  }

  colorWord(word: string, param: number | undefined): void {
    const value = Math.max(0, Math.min(255, param ?? 0));
    const rgb = this.rgb ?? [0, 0, 0];
    if (word === "red") rgb[0] = value;
    else if (word === "green") rgb[1] = value;
    else if (word === "blue") rgb[2] = value;
    else return;
    this.rgb = rgb;
  }

  finishColor(): void {
    this.colors.push(this.rgb ? `rgb(${this.rgb[0]}, ${this.rgb[1]}, ${this.rgb[2]})` : null);
    this.rgb = null;
  }
}

/** Decode file bytes one byte per character so offsets stay byte offsets. */
export function rtfSourceFromBytes(bytes: Uint8Array): string {
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + step)));
  }
  return out;
}

/** Encode an RTF source string back to bytes; refuses any non-byte character. */
export function rtfBytesFromSource(source: string): Uint8Array {
  const out = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c > 0xff) throw new Error("RTF output contains a character outside one byte.");
    out[i] = c;
  }
  return out;
}

export function parseRtfDocument(source: string): RtfDocument {
  const p = new Parser(source);
  p.run();
  const endInsert = p.endInsert >= 0 ? p.endInsert : source.length;
  return {
    source,
    units: p.units,
    paragraphs: p.paragraphs,
    fonts: p.fonts,
    colors: p.colors,
    endInsert,
    endFmt: p.endFmt,
    readOnlyReason: p.reason,
  };
}
