import { cp1252Char } from "../cp1252";
import { LegacyOfficeError, malformed, type CompoundFile } from "./cfb";

// Main-document text of a Word 97-2003 binary file ([MS-DOC]): FIB → CLX
// piece table → text. Paragraph table flags (`sprmPFInTable`, `sprmPFTtp`)
// come from the PAPX FKPs, so tables become rows of cells; without them,
// two cell marks in a row end a row. Field codes are dropped and field
// results kept. Headers, footnotes, comments and text boxes live after the
// main text and are not read. Every loop is bounded by the stream sizes.

export interface LegacyParagraph {
  readonly kind: "paragraph";
  /** Text; `\t` tab, `\n` manual line break. */
  readonly text: string;
  readonly pageBreakBefore: boolean;
}

export interface LegacyTable {
  readonly kind: "table";
  readonly rows: readonly (readonly string[])[];
}

export type LegacyBlock = LegacyParagraph | LegacyTable;

export interface LegacyWordDocument {
  readonly blocks: readonly LegacyBlock[];
}

/** Most main-document characters Mesa reads (Word's own limit is far lower in practice). */
export const MAX_WORD_CHARS = 16 * 1024 * 1024;
const WORD97_NFIB = 0x00c0;
const FIELD_DEPTH_LIMIT = 32;
const FKP_SIZE = 512;
const SPRM_P_IN_TABLE = 0x2416;
const SPRM_P_TTP = 0x2417;

function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

function need(b: Uint8Array, at: number, len: number, what: string): void {
  if (at < 0 || len < 0 || at + len > b.length) malformed(`${what} lies outside its stream.`);
}

interface Fib {
  readonly tableName: "0Table" | "1Table";
  readonly ccpText: number;
  readonly fcClx: number;
  readonly lcbClx: number;
  readonly fcPlcfBtePapx: number;
  readonly lcbPlcfBtePapx: number;
}

function readFib(ws: Uint8Array): Fib {
  need(ws, 0, 34, "the file information block");
  if (u16(ws, 0) !== 0xa5ec) malformed("its Word header is missing.");
  if (u16(ws, 2) < WORD97_NFIB) {
    throw new LegacyOfficeError("unsupported", "This is a Word 6 or Word 95 file. Mesa reads Word 97-2003 (.doc) files only; save it as .docx in Word or LibreOffice.");
  }
  const flags = u16(ws, 0x0a);
  if (flags & 0x0100 || flags & 0x8000) {
    throw new LegacyOfficeError("encrypted", "This Word file is password-protected. Mesa cannot read encrypted documents; remove the password in Word, then open it again.");
  }
  const csw = u16(ws, 32);
  const lwAt = 34 + csw * 2;
  need(ws, lwAt, 2, "the file information block");
  const cslw = u16(ws, lwAt);
  const rgLw = lwAt + 2;
  need(ws, rgLw, cslw * 4 + 2, "the file information block");
  if (cslw < 4) malformed("its file information block is too short.");
  const ccpText = u32(ws, rgLw + 12);
  const fcAt = rgLw + cslw * 4;
  const cbRgFcLcb = u16(ws, fcAt);
  const blob = fcAt + 2;
  if (cbRgFcLcb < 34) malformed("its file information block is too short.");
  need(ws, blob, cbRgFcLcb * 8, "the file information block");
  if (ccpText > MAX_WORD_CHARS) {
    throw new LegacyOfficeError("tooLarge", "This document has more text than Mesa reads from an older Word file (16 million characters).");
  }
  return {
    tableName: flags & 0x0200 ? "1Table" : "0Table",
    ccpText,
    fcClx: u32(ws, blob + 33 * 8), lcbClx: u32(ws, blob + 33 * 8 + 4),
    fcPlcfBtePapx: u32(ws, blob + 13 * 8), lcbPlcfBtePapx: u32(ws, blob + 13 * 8 + 4),
  };
}

interface Piece {
  readonly cpStart: number;
  readonly cpEnd: number;
  readonly fc: number;
  readonly compressed: boolean;
}

function readPieces(table: Uint8Array, fib: Fib): Piece[] {
  need(table, fib.fcClx, fib.lcbClx, "the piece table");
  const end = fib.fcClx + fib.lcbClx;
  let at = fib.fcClx;
  // Prc entries (clxt 1) come first; each advances at least 3 bytes.
  for (let guard = 0; at < end && guard <= fib.lcbClx; guard++) {
    const clxt = table[at];
    if (clxt === 1) {
      need(table, at + 1, 2, "the piece table");
      const cb = u16(table, at + 1);
      at += 3 + (cb > 0x7fff ? 0 : cb);
      continue;
    }
    if (clxt !== 2) malformed("its piece table has an unknown entry.");
    need(table, at + 1, 4, "the piece table");
    const lcb = u32(table, at + 1);
    const plc = at + 5;
    need(table, plc, lcb, "the piece table");
    if (lcb < 16 || (lcb - 4) % 12 !== 0) malformed("its piece table has an impossible size.");
    const n = (lcb - 4) / 12;
    const pieces: Piece[] = [];
    for (let i = 0; i < n; i++) {
      const cpStart = u32(table, plc + i * 4);
      const cpEnd = u32(table, plc + (i + 1) * 4);
      if (cpEnd < cpStart) malformed("its piece table is out of order.");
      const raw = u32(table, plc + (n + 1) * 4 + i * 8 + 2);
      const compressed = (raw & 0x40000000) !== 0;
      const fc = raw & 0x3fffffff;
      pieces.push({ cpStart, cpEnd, fc: compressed ? fc / 2 : fc, compressed });
    }
    return pieces;
  }
  return malformed("its piece table is missing.");
}

const utf16 = new TextDecoder("utf-16le");

function decodePieces(ws: Uint8Array, pieces: readonly Piece[], ccpText: number): string {
  const parts: string[] = [];
  let total = 0;
  for (const p of pieces) {
    if (p.cpStart >= ccpText) break;
    const count = Math.min(p.cpEnd, ccpText) - p.cpStart;
    if (count <= 0) continue;
    total += count;
    if (total > MAX_WORD_CHARS) throw new LegacyOfficeError("tooLarge", "This document has more text than Mesa reads from an older Word file.");
    if (p.compressed) {
      need(ws, p.fc, count, "a text piece");
      const chars: string[] = new Array<string>(count);
      for (let i = 0; i < count; i++) chars[i] = cp1252Char(ws[p.fc + i]);
      parts.push(chars.join(""));
    } else {
      need(ws, p.fc, count * 2, "a text piece");
      parts.push(utf16.decode(ws.subarray(p.fc, p.fc + count * 2)));
    }
  }
  return parts.join("");
}

/** File positions of paragraph runs with their table flags, sorted by `start`. */
interface ParaRun { readonly start: number; readonly end: number; readonly inTable: boolean; readonly rowEnd: boolean }

function sprmOperandSize(sprm: number, grpprl: Uint8Array, at: number): number {
  switch (sprm >> 13) {
    case 0: case 1: return 1;
    case 2: case 4: case 5: return 2;
    case 3: return 4;
    case 7: return 3;
    default:
      if (sprm === 0xd608 || sprm === 0xd606) return at + 1 < grpprl.length ? u16(grpprl, at) + 1 : grpprl.length;
      return at < grpprl.length ? grpprl[at] + 1 : grpprl.length;
  }
}

function tableFlags(grpprl: Uint8Array): { inTable: boolean; rowEnd: boolean } {
  let inTable = false;
  let rowEnd = false;
  let at = 0;
  for (let guard = 0; at + 2 <= grpprl.length && guard < grpprl.length; guard++) {
    const sprm = u16(grpprl, at);
    at += 2;
    if (sprm === SPRM_P_IN_TABLE && at < grpprl.length) inTable = grpprl[at] !== 0;
    if (sprm === SPRM_P_TTP && at < grpprl.length) rowEnd = grpprl[at] !== 0;
    at += sprmOperandSize(sprm, grpprl, at);
  }
  return { inTable, rowEnd };
}

function readParagraphRuns(ws: Uint8Array, table: Uint8Array, fib: Fib): ParaRun[] | null {
  const { fcPlcfBtePapx: at, lcbPlcfBtePapx: lcb } = fib;
  if (lcb < 12 || (lcb - 4) % 8 !== 0 || at + lcb > table.length) return null;
  const n = (lcb - 4) / 8;
  const runs: ParaRun[] = [];
  for (let i = 0; i < n; i++) {
    const page = (u32(table, at + (n + 1) * 4 + i * 4) & 0x3fffff) * FKP_SIZE;
    if (page + FKP_SIZE > ws.length) return null;
    const crun = ws[page + FKP_SIZE - 1];
    if (crun === 0 || (crun + 1) * 4 + crun * 13 > FKP_SIZE - 1) return null;
    for (let r = 0; r < crun; r++) {
      const bOffset = ws[page + (crun + 1) * 4 + r * 13] * 2;
      let flags = { inTable: false, rowEnd: false };
      if (bOffset > 0) {
        let cb = ws[page + bOffset];
        let from = page + bOffset + 1;
        if (cb === 0) { cb = ws[from] * 2; from += 1; } else cb = cb * 2 - 1;
        const to = Math.min(from + cb, page + FKP_SIZE - 1);
        if (from + 2 <= to) flags = tableFlags(ws.subarray(from + 2, to));
      }
      runs.push({ start: u32(ws, page + r * 4), end: u32(ws, page + (r + 1) * 4), ...flags });
    }
  }
  runs.sort((a, b) => a.start - b.start);
  return runs;
}

function runAt(runs: readonly ParaRun[], fc: number): ParaRun | null {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const run = runs[mid];
    if (fc < run.start) hi = mid - 1;
    else if (fc >= run.end) lo = mid + 1;
    else return run;
  }
  return null;
}

/** Maps a character position to its file position through the piece table. */
function fcOf(pieces: readonly Piece[], cp: number): number {
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const p = pieces[mid];
    if (cp < p.cpStart) hi = mid - 1;
    else if (cp >= p.cpEnd) lo = mid + 1;
    else return p.fc + (cp - p.cpStart) * (p.compressed ? 1 : 2);
  }
  return -1;
}

type MarkKind = "paragraph" | "cellParagraph" | "cell" | "row";

/** Builds blocks from main text; `mark` says what a paragraph or cell mark ends. */
function buildBlocks(text: string, mark: (cp: number, ch: string, previousWasCell: boolean) => MarkKind): LegacyBlock[] {
  const blocks: LegacyBlock[] = [];
  let para = "";
  let cells: string[] = [];
  let rows: string[][] = [];
  let pageBreak = false;
  let previousWasCell = false;
  const fields: boolean[] = []; // true while inside a field's code
  let hiddenDepth = 0;
  const flushTable = () => {
    if (cells.length > 0) { rows.push(cells); cells = []; }
    if (rows.length > 0) blocks.push({ kind: "table", rows });
    rows = [];
  };
  for (let cp = 0; cp < text.length; cp++) {
    const ch = text[cp];
    const code = ch.charCodeAt(0);
    if (code === 0x13) { fields.push(true); hiddenDepth++; continue; }
    if (code === 0x14) { if (fields.length && fields[fields.length - 1]) { fields[fields.length - 1] = false; hiddenDepth--; } continue; }
    if (code === 0x15) { if (fields.length && fields.pop()) hiddenDepth--; continue; }
    if (fields.length > FIELD_DEPTH_LIMIT) malformed("its fields are nested too deeply.");
    if (code === 0x0d || code === 0x07) {
      const kind = mark(cp, ch, previousWasCell);
      previousWasCell = code === 0x07;
      if (kind === "cellParagraph") { para += "\n"; continue; }
      if (kind === "cell") { cells.push(para); para = ""; continue; }
      if (kind === "row") {
        if (para) cells.push(para);
        para = "";
        rows.push(cells);
        cells = [];
        continue;
      }
      flushTable();
      blocks.push({ kind: "paragraph", text: para, pageBreakBefore: pageBreak });
      para = "";
      pageBreak = false;
      continue;
    }
    previousWasCell = false;
    if (hiddenDepth > 0) continue;
    if (code === 0x0c) {
      flushTable();
      if (para) blocks.push({ kind: "paragraph", text: para, pageBreakBefore: pageBreak });
      para = "";
      pageBreak = true;
      continue;
    }
    if (code === 0x0b) { para += "\n"; continue; }
    if (code === 0x1e) { para += "‑"; continue; }
    if (code === 0x09 || code >= 0x20) para += ch;
  }
  flushTable();
  if (para) blocks.push({ kind: "paragraph", text: para, pageBreakBefore: pageBreak });
  return blocks;
}

/** Reads the main text of a Word 97-2003 document. Throws `LegacyOfficeError`. */
export function readWordBinary(cfb: CompoundFile): LegacyWordDocument {
  const ws = cfb.stream("WordDocument");
  if (!ws) malformed("it has no WordDocument stream.");
  const fib = readFib(ws);
  const table = cfb.stream(fib.tableName);
  if (!table) malformed(`its ${fib.tableName} stream is missing.`);
  const pieces = readPieces(table, fib);
  const text = decodePieces(ws, pieces, fib.ccpText);
  const runs = readParagraphRuns(ws, table, fib);
  const mark = (cp: number, ch: string, previousWasCell: boolean): MarkKind => {
    const run = runs ? runAt(runs, fcOf(pieces, cp)) : null;
    if (run) {
      if (ch === "\x07") return run.rowEnd ? "row" : "cell";
      return run.inTable ? "cellParagraph" : "paragraph";
    }
    if (ch === "\x07") return previousWasCell ? "row" : "cell";
    return "paragraph";
  };
  return { blocks: buildBlocks(text, mark) };
}
