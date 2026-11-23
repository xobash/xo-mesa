import { BUILTIN_NUMBER_FORMATS, compileNumberFormat, formatGeneral, formatNumber, type CompiledNumberFormat } from "../ooxml/xlsxNumberFormat";
import { LegacyOfficeError, malformed, type CompoundFile } from "./cfb";

// Cell values of an Excel 97-2003 workbook ([MS-XLS], BIFF8 `Workbook`
// stream). Reads the sheet list (BOUNDSHEET), shared strings (SST with
// CONTINUE), number formats (FORMAT, XF), the date system and the cells:
// LABELSST, LABEL, NUMBER, RK, MULRK, BOOLERR and FORMULA cached results
// (with the STRING record that follows a text result). Formulas themselves,
// styles, charts and macros are not read. FILEPASS means encrypted.

export type LegacyCellValue =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "error"; readonly value: string };

export interface LegacyCell {
  readonly row: number;
  readonly col: number;
  readonly value: LegacyCellValue;
  /** Number format code for numbers ("General" when none). */
  readonly format: string;
  readonly formula: boolean;
}

export interface LegacySheet {
  readonly name: string;
  readonly hidden: boolean;
  readonly cells: readonly LegacyCell[];
  readonly rowCount: number;
  readonly columnCount: number;
}

export interface LegacyWorkbook {
  readonly sheets: readonly LegacySheet[];
  /** Chart, macro and module sheets the copy leaves out, by name. */
  readonly skippedSheets: readonly string[];
  readonly date1904: boolean;
  /** Cells holding formulas (shown and copied as their cached values). */
  readonly formulaCells: number;
}

/** Most cells Mesa reads from one legacy workbook. */
export const MAX_XLS_CELLS = 1_000_000;
const MAX_SHEETS = 4096;
const BOF = 0x0809;
const EOF = 0x000a;
const CONTINUE = 0x003c;
const ERROR_TEXT: Readonly<Record<number, string>> = {
  0x00: "#NULL!", 0x07: "#DIV/0!", 0x0f: "#VALUE!", 0x17: "#REF!", 0x1d: "#NAME?", 0x24: "#NUM!", 0x2a: "#N/A", 0x2b: "#GETTING_DATA",
};

interface Rec { readonly type: number; readonly data: Uint8Array; readonly next: number }

function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

function f64(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset + at, 8).getFloat64(0, true);
}

function recordAt(stream: Uint8Array, at: number): Rec {
  if (at + 4 > stream.length) malformed("a workbook record is cut off.");
  const len = u16(stream, at + 2);
  if (at + 4 + len > stream.length) malformed("a workbook record is cut off.");
  return { type: u16(stream, at), data: stream.subarray(at + 4, at + 4 + len), next: at + 4 + len };
}

function need(data: Uint8Array, len: number): void {
  if (data.length < len) malformed("a workbook record is too short.");
}

/** Decodes an RkNumber (MS-XLS 2.5.217). */
export function decodeRk(rk: number): number {
  let value: number;
  if (rk & 0x02) value = (rk | 0) >> 2;
  else {
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(4, rk & 0xfffffffc, true);
    value = view.getFloat64(0, true);
  }
  return rk & 0x01 ? value / 100 : value;
}

/** Reads bytes across a record and its CONTINUE records; a split character array restarts with a flags byte. */
class SegmentReader {
  private seg = 0;
  private at = 0;
  constructor(private readonly segments: readonly Uint8Array[]) {}

  private ensure(): void {
    for (let guard = 0; guard < this.segments.length && this.seg < this.segments.length && this.at >= this.segments[this.seg].length; guard++) {
      this.seg++;
      this.at = 0;
    }
    if (this.seg >= this.segments.length) malformed("the shared string table is cut off.");
  }

  byte(): number {
    this.ensure();
    return this.segments[this.seg][this.at++];
  }

  u16(): number { return this.byte() | (this.byte() << 8); }
  u32(): number { return (this.u16() | (this.u16() << 16)) >>> 0; }

  skip(n: number): void {
    let left = n;
    for (let guard = 0; left > 0 && guard <= this.segments.length; guard++) {
      this.ensure();
      const take = Math.min(left, this.segments[this.seg].length - this.at);
      this.at += take;
      left -= take;
    }
    if (left > 0) malformed("the shared string table is cut off.");
  }

  chars(count: number, highByte: boolean): string {
    const out: string[] = [];
    let wide = highByte;
    for (let i = 0; i < count; i++) {
      if (this.seg < this.segments.length && this.at >= this.segments[this.seg].length) {
        this.ensure();
        wide = (this.byte() & 0x01) !== 0;
      }
      out.push(String.fromCharCode(wide ? this.u16() : this.byte()));
    }
    return out.join("");
  }
}

/** XLUnicodeRichExtendedString (MS-XLS 2.5.293). */
function readRichString(r: SegmentReader): string {
  const cch = r.u16();
  const flags = r.byte();
  const runs = flags & 0x08 ? r.u16() : 0;
  const ext = flags & 0x04 ? r.u32() : 0;
  const text = r.chars(cch, (flags & 0x01) !== 0);
  r.skip(runs * 4 + ext);
  return text;
}

function readSst(data: Uint8Array, continues: readonly Uint8Array[]): string[] {
  need(data, 8);
  const unique = u32(data, 4);
  const segments = [data.subarray(8), ...continues];
  let available = 0;
  for (const s of segments) available += s.length;
  if (unique > available / 3) malformed("the shared string table count is impossible.");
  const reader = new SegmentReader(segments);
  const out: string[] = [];
  for (let i = 0; i < unique; i++) out.push(readRichString(reader));
  return out;
}

/** XLUnicodeString (cch u16, flags, chars) or ShortXLUnicodeString (cch u8) at `at`. */
function readPlainString(data: Uint8Array, at: number, shortCount: boolean): string {
  const cch = shortCount ? data[at] : u16(data, at);
  const flagsAt = at + (shortCount ? 1 : 2);
  if (flagsAt >= data.length) malformed("a workbook string is cut off.");
  const wide = (data[flagsAt] & 0x01) !== 0;
  const from = flagsAt + 1;
  if (from + cch * (wide ? 2 : 1) > data.length) malformed("a workbook string is cut off.");
  const chars: string[] = [];
  for (let i = 0; i < cch; i++) chars.push(String.fromCharCode(wide ? u16(data, from + i * 2) : data[from + i]));
  return chars.join("");
}

interface Globals {
  readonly sheets: { name: string; offset: number; hidden: boolean; type: number }[];
  readonly strings: string[];
  readonly xfFormats: number[];
  readonly formats: Map<number, string>;
  readonly date1904: boolean;
}

function readGlobals(stream: Uint8Array): Globals {
  const first = recordAt(stream, 0);
  if (first.type !== BOF || first.data.length < 4) malformed("its workbook stream does not start with a BOF record.");
  const version = u16(first.data, 0);
  if (version !== 0x0600) {
    throw new LegacyOfficeError("unsupported", "This is an Excel 5 or Excel 95 workbook. Mesa reads Excel 97-2003 (.xls) files only; save it as .xlsx in Excel or LibreOffice.");
  }
  const g: Globals = { sheets: [], strings: [], xfFormats: [], formats: new Map(), date1904: false };
  let date1904 = false;
  let at = first.next;
  for (let guard = 0; at < stream.length && guard < stream.length; guard++) {
    const rec = recordAt(stream, at);
    at = rec.next;
    const d = rec.data;
    if (rec.type === EOF) return { ...g, date1904 };
    if (rec.type === 0x002f) {
      throw new LegacyOfficeError("encrypted", "This workbook is password-protected. Mesa cannot read encrypted workbooks; remove the password in Excel, then open it again.");
    }
    if (rec.type === 0x0085) {
      need(d, 8);
      if (g.sheets.length >= MAX_SHEETS) malformed("it lists too many sheets.");
      g.sheets.push({ offset: u32(d, 0), hidden: (d[4] & 0x03) !== 0, type: d[5], name: readPlainString(d, 6, true) });
    } else if (rec.type === 0x00fc) {
      const continues: Uint8Array[] = [];
      for (let c = 0; at < stream.length && c < stream.length; c++) {
        const next = recordAt(stream, at);
        if (next.type !== CONTINUE) break;
        continues.push(next.data);
        at = next.next;
      }
      // A loop, not a spread: a spread of 125k+ strings overflows the stack.
      for (const text of readSst(d, continues)) g.strings.push(text);
    } else if (rec.type === 0x00e0) {
      need(d, 4);
      g.xfFormats.push(u16(d, 2));
    } else if (rec.type === 0x041e) {
      need(d, 5);
      g.formats.set(u16(d, 0), readPlainString(d, 2, false));
    } else if (rec.type === 0x0022) {
      need(d, 2);
      date1904 = u16(d, 0) === 1;
    }
  }
  return malformed("its workbook globals have no end record.");
}

interface SheetReadState {
  readonly cells: LegacyCell[];
  rows: number;
  cols: number;
  formulas: number;
}

function cellFormat(g: Globals, xf: number): string {
  const ifmt = g.xfFormats[xf];
  if (ifmt === undefined) return "General";
  return g.formats.get(ifmt) ?? BUILTIN_NUMBER_FORMATS[ifmt] ?? "General";
}

function readSheet(stream: Uint8Array, g: Globals, offset: number, budget: { cells: number }): SheetReadState {
  const state: SheetReadState = { cells: [], rows: 0, cols: 0, formulas: 0 };
  const first = recordAt(stream, offset);
  if (first.type !== BOF) malformed("a sheet does not start where the workbook says.");
  let depth = 1;
  let at = first.next;
  const pending: { cell: { row: number; col: number; xf: number } | null } = { cell: null };
  const push = (row: number, col: number, xf: number, value: LegacyCellValue, formula = false) => {
    if (budget.cells >= MAX_XLS_CELLS) {
      throw new LegacyOfficeError("tooLarge", `This workbook has more than ${MAX_XLS_CELLS.toLocaleString("en-US")} cells, the most Mesa reads from an older Excel file.`);
    }
    budget.cells++;
    if (formula) state.formulas++;
    state.cells.push({ row, col, value, format: cellFormat(g, xf), formula });
    state.rows = Math.max(state.rows, row + 1);
    state.cols = Math.max(state.cols, col + 1);
  };
  for (let guard = 0; at < stream.length && depth > 0 && guard < stream.length; guard++) {
    const rec = recordAt(stream, at);
    at = rec.next;
    const d = rec.data;
    if (rec.type === BOF) { depth++; continue; }
    if (rec.type === EOF) { depth--; continue; }
    if (depth !== 1) continue;
    const awaiting = pending.cell;
    if (rec.type === 0x0207 && awaiting) {
      push(awaiting.row, awaiting.col, awaiting.xf, { kind: "text", value: readPlainString(d, 0, false) }, true);
      pending.cell = null;
      continue;
    }
    // Shared, array and table formula records may sit between FORMULA and STRING.
    if (rec.type === 0x04bc || rec.type === 0x0221 || rec.type === 0x0236) continue;
    pending.cell = null;
    readCellRecord(rec.type, d, g, push, (row, col, xf) => { pending.cell = { row, col, xf }; });
  }
  if (depth > 0) malformed("a sheet has no end record.");
  return state;
}

type PushCell = (row: number, col: number, xf: number, value: LegacyCellValue, formula?: boolean) => void;

function readCellRecord(type: number, d: Uint8Array, g: Globals, push: PushCell, awaitString: (row: number, col: number, xf: number) => void): void {
  if (type === 0x00fd) { // LABELSST
    need(d, 10);
    const text = g.strings[u32(d, 6)];
    if (text === undefined) malformed("a cell points past the shared string table.");
    push(u16(d, 0), u16(d, 2), u16(d, 4), { kind: "text", value: text });
  } else if (type === 0x0204) { // LABEL
    need(d, 9);
    push(u16(d, 0), u16(d, 2), u16(d, 4), { kind: "text", value: readPlainString(d, 6, false) });
  } else if (type === 0x0203) { // NUMBER
    need(d, 14);
    push(u16(d, 0), u16(d, 2), u16(d, 4), { kind: "number", value: f64(d, 6) });
  } else if (type === 0x027e) { // RK
    need(d, 10);
    push(u16(d, 0), u16(d, 2), u16(d, 4), { kind: "number", value: decodeRk(u32(d, 6)) });
  } else if (type === 0x00bd) { // MULRK
    need(d, 6);
    const row = u16(d, 0);
    const firstCol = u16(d, 2);
    const count = Math.floor((d.length - 6) / 6);
    for (let i = 0; i < count; i++) push(row, firstCol + i, u16(d, 4 + i * 6), { kind: "number", value: decodeRk(u32(d, 6 + i * 6)) });
  } else if (type === 0x0205) { // BOOLERR
    need(d, 8);
    const value: LegacyCellValue = d[7] ? { kind: "error", value: ERROR_TEXT[d[6]] ?? "#N/A" } : { kind: "bool", value: d[6] !== 0 };
    push(u16(d, 0), u16(d, 2), u16(d, 4), value);
  } else if (type === 0x0006) { // FORMULA: cached result only
    need(d, 20);
    const row = u16(d, 0);
    const col = u16(d, 2);
    const xf = u16(d, 4);
    if (u16(d, 12) !== 0xffff) { push(row, col, xf, { kind: "number", value: f64(d, 6) }, true); return; }
    const kind = d[6];
    if (kind === 0) awaitString(row, col, xf);
    else if (kind === 1) push(row, col, xf, { kind: "bool", value: d[8] !== 0 }, true);
    else if (kind === 2) push(row, col, xf, { kind: "error", value: ERROR_TEXT[d[8]] ?? "#N/A" }, true);
    else if (kind === 3) push(row, col, xf, { kind: "text", value: "" }, true);
  }
}

/** Reads every worksheet's cell values. Throws `LegacyOfficeError`. */
export function readExcelBinary(cfb: CompoundFile): LegacyWorkbook {
  const stream = cfb.stream("Workbook");
  if (!stream) {
    if (cfb.stream("Book")) {
      throw new LegacyOfficeError("unsupported", "This is an Excel 5 or Excel 95 workbook. Mesa reads Excel 97-2003 (.xls) files only; save it as .xlsx in Excel or LibreOffice.");
    }
    malformed("it has no Workbook stream.");
  }
  const g = readGlobals(stream);
  const budget = { cells: 0 };
  const sheets: LegacySheet[] = [];
  const skippedSheets: string[] = [];
  let formulaCells = 0;
  for (const s of g.sheets) {
    if (s.type !== 0) { skippedSheets.push(s.name); continue; }
    if (s.offset >= stream.length) malformed(`sheet ${s.name} starts past the end of the workbook.`);
    const read = readSheet(stream, g, s.offset, budget);
    formulaCells += read.formulas;
    sheets.push({ name: s.name, hidden: s.hidden, cells: read.cells, rowCount: read.rows, columnCount: read.cols });
  }
  return { sheets, skippedSheets, date1904: g.date1904, formulaCells };
}

const compiled = new Map<string, CompiledNumberFormat>();

/** Display text of a legacy cell, locale-neutral like the .xlsx view. */
export function legacyCellText(cell: LegacyCell, date1904: boolean): string {
  const v = cell.value;
  if (v.kind === "text" || v.kind === "error") return v.value;
  if (v.kind === "bool") return v.value ? "TRUE" : "FALSE";
  if (cell.format === "General") return formatGeneral(v.value);
  let format = compiled.get(cell.format);
  if (!format) {
    format = compileNumberFormat(cell.format);
    if (compiled.size < 4096) compiled.set(cell.format, format);
  }
  return formatNumber(v.value, format, date1904);
}
