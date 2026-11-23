// Hand-built legacy Office fixtures for tests. Nothing here is copied from a
// real file; every structure is written from the specifications:
//
// CFB ([MS-CFB]) — version 3, 512-byte sectors, laid out as
//   header | FAT sectors | directory sectors | mini FAT sectors |
//   mini stream sectors | one chain per stream of 4096 bytes or more.
// Streams under 4096 bytes live in the mini stream (64-byte mini sectors).
// Root children are chained through right-sibling pointers in CFB name order.
//
// .doc ([MS-DOC]) — WordDocument stream: FIB (FibBase 32 bytes, csw 14,
// cslw 22 with ccpText, cbRgFcLcb 93 with fcPlcfBtePapx at index 13 and
// fcClx at index 33), text pieces from offset 1024, one PAPX FKP page at
// offset 2048. 1Table stream: one Prc, then the Pcdt piece table, then the
// PlcBtePapx naming that FKP.
//
// .xls ([MS-XLS]) — Workbook stream: globals BOF (BIFF8) | [FILEPASS] |
// DATEMODE | FORMAT | XF records | BOUNDSHEET per sheet | SST split over
// CONTINUE | EOF, then per sheet BOF | cell records | EOF.
//
// .ppt ([MS-PPT]) — PowerPoint Document stream: DocumentContainer
// (DocumentAtom, slide list, notes list), SlideContainers (SlideAtom and a
// drawing with OutlineTextRefAtoms and a text box), NotesContainers, the
// PersistDirectoryAtom and the UserEditAtom. Current User stream: one
// CurrentUserAtom pointing at the UserEditAtom.

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;
const SECTOR = 512;

export interface CfbStream { readonly name: string; readonly data: Uint8Array }

export interface CfbLayout {
  readonly fatSectors: number;
  readonly dirStart: number;
  /** First regular sector of each large stream, by name. */
  readonly streamStart: ReadonlyMap<string, number>;
}

function put32(b: Uint8Array, at: number, v: number): void {
  b[at] = v & 0xff; b[at + 1] = (v >>> 8) & 0xff; b[at + 2] = (v >>> 16) & 0xff; b[at + 3] = (v >>> 24) & 0xff;
}

function put16(b: Uint8Array, at: number, v: number): void {
  b[at] = v & 0xff; b[at + 1] = (v >>> 8) & 0xff;
}

function cfbCompare(a: string, b: string): number {
  return a.length !== b.length ? a.length - b.length : a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0;
}

/** Offset of FAT entry `sector` (FAT sectors come first, starting at sector 0). */
export function fatEntryOffset(sector: number): number {
  return SECTOR + sector * 4;
}

export function buildCfb(streams: readonly CfbStream[]): { bytes: Uint8Array; layout: CfbLayout } {
  const sorted = [...streams].sort((a, b) => cfbCompare(a.name, b.name));
  const small = sorted.filter((s) => s.data.length < 4096);
  const large = sorted.filter((s) => s.data.length >= 4096);
  const miniOffsets = new Map<string, number>();
  let miniLen = 0;
  for (const s of small) { miniOffsets.set(s.name, miniLen / 64); miniLen += Math.ceil(s.data.length / 64) * 64; }
  const dirSectors = Math.ceil(((sorted.length + 1) * 128) / SECTOR);
  const miniFatSectors = Math.ceil(((miniLen / 64) * 4) / SECTOR);
  const miniSectors = Math.ceil(miniLen / SECTOR);
  const largeSectors = large.map((s) => Math.ceil(s.data.length / SECTOR));
  const other = dirSectors + miniFatSectors + miniSectors + largeSectors.reduce((a, b) => a + b, 0);
  let fatSectors = 1;
  while (fatSectors * 128 < other + fatSectors) fatSectors++;
  const total = fatSectors + other;
  const bytes = new Uint8Array(SECTOR * (total + 1));
  const fat = new Uint32Array(fatSectors * 128).fill(FREESECT);
  for (let i = 0; i < fatSectors; i++) fat[i] = FATSECT;
  let next = fatSectors;
  const chain = (count: number): number => {
    const start = count > 0 ? next : ENDOFCHAIN;
    for (let i = 0; i < count; i++) fat[next + i] = i === count - 1 ? ENDOFCHAIN : next + i + 1;
    next += count;
    return start;
  };
  const dirStart = chain(dirSectors);
  const miniFatStart = chain(miniFatSectors);
  const miniStart = chain(miniSectors);
  const streamStart = new Map<string, number>();
  large.forEach((s, i) => streamStart.set(s.name, chain(largeSectors[i])));
  const off = (sector: number) => (sector + 1) * SECTOR;
  // Header.
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  put16(bytes, 24, 0x3e); put16(bytes, 26, 3); put16(bytes, 28, 0xfffe); put16(bytes, 30, 9); put16(bytes, 32, 6);
  put32(bytes, 44, fatSectors); put32(bytes, 48, dirStart); put32(bytes, 56, 4096);
  put32(bytes, 60, miniFatSectors ? miniFatStart : ENDOFCHAIN); put32(bytes, 64, miniFatSectors);
  put32(bytes, 68, ENDOFCHAIN); put32(bytes, 72, 0);
  for (let i = 0; i < 109; i++) put32(bytes, 76 + i * 4, i < fatSectors ? i : FREESECT);
  for (let i = 0; i < fat.length; i++) put32(bytes, off(Math.floor(i / 128)) + (i % 128) * 4, fat[i]);
  // Mini FAT and mini stream.
  const miniFat = new Uint32Array(miniFatSectors * 128).fill(FREESECT);
  for (const s of small) {
    const first = miniOffsets.get(s.name)!;
    const count = Math.ceil(s.data.length / 64);
    for (let i = 0; i < count; i++) miniFat[first + i] = i === count - 1 ? ENDOFCHAIN : first + i + 1;
    const at = off(miniStart) + first * 64; // mini stream sectors are contiguous here
    bytes.set(s.data, at);
  }
  for (let i = 0; i < miniFat.length; i++) put32(bytes, off(miniFatStart) + i * 4, miniFat[i]);
  large.forEach((s) => bytes.set(s.data, off(streamStart.get(s.name)!)));
  // Directory.
  const dir = off(dirStart);
  const entry = (id: number, name: string, type: number, start: number, size: number, right: number, child: number) => {
    const at = dir + id * 128;
    for (let c = 0; c < name.length; c++) put16(bytes, at + c * 2, name.charCodeAt(c));
    put16(bytes, at + 64, (name.length + 1) * 2);
    bytes[at + 66] = type; bytes[at + 67] = 1;
    put32(bytes, at + 68, NOSTREAM); put32(bytes, at + 72, right); put32(bytes, at + 76, child);
    put32(bytes, at + 116, start); put32(bytes, at + 120, size);
  };
  for (let id = 0; id < dirSectors * 4; id++) {
    put32(bytes, dir + id * 128 + 68, NOSTREAM); put32(bytes, dir + id * 128 + 72, NOSTREAM); put32(bytes, dir + id * 128 + 76, NOSTREAM);
  }
  entry(0, "Root Entry", 5, miniLen ? miniStart : ENDOFCHAIN, miniLen, NOSTREAM, sorted.length ? 1 : NOSTREAM);
  sorted.forEach((s, i) => {
    const start = s.data.length >= 4096 ? streamStart.get(s.name)! : miniOffsets.get(s.name)!;
    entry(i + 1, s.name, 2, start, s.data.length, i + 1 < sorted.length ? i + 2 : NOSTREAM, NOSTREAM);
  });
  return { bytes, layout: { fatSectors, dirStart, streamStart } };
}

// ---------- .doc ----------

export interface DocPiece { readonly text: string; readonly compressed: boolean }

export interface DocOptions {
  readonly encrypted?: boolean;
  readonly nFib?: number;
  /** Table flags per paragraph mark (by its index among \r and \x07 marks); omitted means no PAPX. */
  readonly paragraphFlags?: (markIndex: number) => { inTable: boolean; rowEnd: boolean };
}

function encodePiece(p: DocPiece): Uint8Array {
  const out = new Uint8Array(p.text.length * (p.compressed ? 1 : 2));
  for (let i = 0; i < p.text.length; i++) {
    const code = p.text.charCodeAt(i);
    if (p.compressed) out[i] = code === 0x2019 ? 0x92 : code;
    else put16(out, i * 2, code);
  }
  return out;
}

export function buildDocStreams(pieces: readonly DocPiece[], options: DocOptions = {}): CfbStream[] {
  const ws = new Uint8Array(2048 + (options.paragraphFlags ? 512 : 0));
  put16(ws, 0, 0xa5ec); put16(ws, 2, options.nFib ?? 0x00c1);
  put16(ws, 0x0a, 0x0200 | (options.encrypted ? 0x0100 : 0));
  put16(ws, 32, 14); put16(ws, 62, 22); put16(ws, 152, 93);
  let fc = 1024;
  const cps = [0];
  const fcs: { fc: number; compressed: boolean }[] = [];
  for (const p of pieces) {
    const encoded = encodePiece(p);
    ws.set(encoded, fc);
    fcs.push({ fc, compressed: p.compressed });
    fc += encoded.length;
    cps.push(cps[cps.length - 1] + p.text.length);
  }
  if (fc > 2048) throw new Error("fixture text too long");
  const ccpText = cps[cps.length - 1];
  put32(ws, 76, ccpText);
  const n = pieces.length;
  const pcdt = new Uint8Array(5 + (n + 1) * 4 + n * 8);
  pcdt[0] = 2; put32(pcdt, 1, (n + 1) * 4 + n * 8);
  cps.forEach((cp, i) => put32(pcdt, 5 + i * 4, cp));
  fcs.forEach((f, i) => put32(pcdt, 5 + (n + 1) * 4 + i * 8 + 2, f.compressed ? ((f.fc * 2) | 0x40000000) >>> 0 : f.fc));
  const prc = new Uint8Array([1, 2, 0, 0x00, 0x00]);
  const clx = new Uint8Array(prc.length + pcdt.length);
  clx.set(prc); clx.set(pcdt, prc.length);
  let table = clx;
  put32(ws, 154 + 33 * 8, 0); put32(ws, 154 + 33 * 8 + 4, clx.length);
  if (options.paragraphFlags) {
    // One FKP page at 2048 (pn 4); assumes a single compressed piece.
    const text = pieces.map((p) => p.text).join("");
    const page = 2048;
    const bounds: number[] = [1024];
    const marks: number[] = [];
    for (let i = 0; i < text.length; i++) if (text[i] === "\r" || text[i] === "\x07") { bounds.push(1024 + i + 1); marks.push(i); }
    const crun = marks.length;
    bounds.forEach((b, i) => put32(ws, page + i * 4, b));
    const papx = { plain: 200, inTable: 210, rowEnd: 220 };
    ws.set([2, 0, 0, 0], page + papx.plain * 2);
    ws.set([3, 0, 0, 0x16, 0x24, 1], page + papx.inTable * 2);
    ws.set([5, 0, 0, 0x16, 0x24, 1, 0x17, 0x24, 1, 0], page + papx.rowEnd * 2);
    marks.forEach((_, r) => {
      const f = options.paragraphFlags!(r);
      ws[page + (crun + 1) * 4 + r * 13] = f.rowEnd ? papx.rowEnd : f.inTable ? papx.inTable : papx.plain;
    });
    ws[page + 511] = crun;
    const bte = new Uint8Array(12);
    put32(bte, 0, 1024); put32(bte, 4, bounds[bounds.length - 1]); put32(bte, 8, 4);
    table = new Uint8Array(clx.length + bte.length);
    table.set(clx); table.set(bte, clx.length);
    put32(ws, 154 + 13 * 8, clx.length); put32(ws, 154 + 13 * 8 + 4, bte.length);
  }
  return [{ name: "WordDocument", data: ws }, { name: "1Table", data: table }];
}

export function buildDoc(pieces: readonly DocPiece[], options: DocOptions = {}): Uint8Array {
  return buildCfb(buildDocStreams(pieces, options)).bytes;
}

// ---------- .xls ----------

export function biffRecord(type: number, data: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  put16(out, 0, type); put16(out, 2, data.length);
  out.set(data, 4);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function f64Bytes(v: number): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return [...b];
}

function le16(v: number): number[] { return [v & 0xff, (v >>> 8) & 0xff]; }
function le32(v: number): number[] { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

function xlString(text: string, short: boolean): number[] {
  const wide = [...text].some((c) => c.charCodeAt(0) > 0xff);
  const chars = [...text].flatMap((c) => (wide ? le16(c.charCodeAt(0)) : [c.charCodeAt(0)]));
  return [...(short ? [text.length] : le16(text.length)), wide ? 1 : 0, ...chars];
}

export type XlsCell =
  | { kind: "sst"; row: number; col: number; index: number; xf?: number }
  | { kind: "number"; row: number; col: number; value: number; xf?: number }
  | { kind: "rk"; row: number; col: number; rk: number; xf?: number }
  | { kind: "mulrk"; row: number; col: number; values: { rk: number; xf: number }[] }
  | { kind: "bool"; row: number; col: number; value: boolean }
  | { kind: "error"; row: number; col: number; code: number }
  | { kind: "formulaNumber"; row: number; col: number; value: number }
  | { kind: "formulaString"; row: number; col: number; value: string }
  | { kind: "label"; row: number; col: number; value: string };

export interface XlsSheet { readonly name: string; readonly cells: readonly XlsCell[]; readonly type?: number; readonly hidden?: boolean }

export interface XlsOptions {
  readonly strings?: readonly string[];
  /** Split the SST data at this byte (inside a character array) into a CONTINUE record. */
  readonly splitSstAt?: number;
  /** Spread the SST over CONTINUE records of at most this many bytes, split between strings. */
  readonly sstRecordBytes?: number;
  readonly encrypted?: boolean;
  readonly date1904?: boolean;
  /** Custom formats by id; XF index i uses `xfFormats[i]`. */
  readonly formats?: Readonly<Record<number, string>>;
  readonly xfFormats?: readonly number[];
  readonly biffVersion?: number;
}

function cellRecord(c: XlsCell): Uint8Array[] {
  const head = (xf = 0) => [...le16(c.row), ...le16(c.col), ...le16(xf)];
  switch (c.kind) {
    case "sst": return [biffRecord(0x00fd, [...head(c.xf), ...le32(c.index)])];
    case "number": return [biffRecord(0x0203, [...head(c.xf), ...f64Bytes(c.value)])];
    case "rk": return [biffRecord(0x027e, [...head(c.xf), ...le32(c.rk)])];
    case "mulrk": return [biffRecord(0x00bd, [...le16(c.row), ...le16(c.col), ...c.values.flatMap((v) => [...le16(v.xf), ...le32(v.rk)]), ...le16(c.col + c.values.length - 1)])];
    case "bool": return [biffRecord(0x0205, [...head(), c.value ? 1 : 0, 0])];
    case "error": return [biffRecord(0x0205, [...head(), c.code, 1])];
    case "formulaNumber": return [biffRecord(0x0006, [...head(), ...f64Bytes(c.value), 0, 0, 0, 0, 0, 0, 3, 0, 0x1e, 1, 0])];
    case "formulaString": return [
      biffRecord(0x0006, [...head(), 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 3, 0, 0x1e, 1, 0]),
      biffRecord(0x0207, xlString(c.value, false)),
    ];
    case "label": return [biffRecord(0x0204, [...head(), ...xlString(c.value, false)])];
  }
}

export function buildXlsWorkbookStream(sheets: readonly XlsSheet[], options: XlsOptions = {}): Uint8Array {
  const version = options.biffVersion ?? 0x0600;
  const globals: Uint8Array[] = [biffRecord(0x0809, [...le16(version), ...le16(0x0005), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])];
  if (options.encrypted) globals.push(biffRecord(0x002f, [1, 0, 1, 0, 1, 0]));
  globals.push(biffRecord(0x0022, le16(options.date1904 ? 1 : 0)));
  for (const [id, code] of Object.entries(options.formats ?? {})) globals.push(biffRecord(0x041e, [...le16(Number(id)), ...xlString(code, false)]));
  for (const ifmt of options.xfFormats ?? [0]) globals.push(biffRecord(0x00e0, [0, 0, ...le16(ifmt), ...new Array<number>(16).fill(0)]));
  const boundsheetAt: number[] = [];
  for (const s of sheets) {
    boundsheetAt.push(globals.length);
    globals.push(biffRecord(0x0085, [0, 0, 0, 0, s.hidden ? 1 : 0, s.type ?? 0, ...xlString(s.name, true)]));
  }
  const strings = options.strings ?? [];
  const sstData = [...le32(strings.length), ...le32(strings.length), ...strings.flatMap((s) => xlString(s, false))];
  if (strings.length) {
    const split = options.splitSstAt;
    if (options.sstRecordBytes) {
      let record: number[] = sstData.slice(0, 8);
      let type = 0x00fc;
      for (const s of strings) {
        const bytes = xlString(s, false);
        if (record.length + bytes.length > options.sstRecordBytes) {
          globals.push(biffRecord(type, record));
          record = [];
          type = 0x003c;
        }
        for (const b of bytes) record.push(b);
      }
      globals.push(biffRecord(type, record));
    } else if (split !== undefined) {
      // The continuation repeats the flags byte of the string being split.
      globals.push(biffRecord(0x00fc, sstData.slice(0, split)), biffRecord(0x003c, [0, ...sstData.slice(split)]));
    } else globals.push(biffRecord(0x00fc, sstData));
  }
  globals.push(biffRecord(0x000a, []));
  const sheetStreams = sheets.map((s) => concat([
    biffRecord(0x0809, [...le16(version), ...le16(0x0010), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ...s.cells.flatMap(cellRecord),
    biffRecord(0x000a, []),
  ]));
  let offset = globals.reduce((n, g) => n + g.length, 0);
  boundsheetAt.forEach((at, i) => { put32(globals[at], 4, offset); offset += sheetStreams[i].length; });
  return concat([...globals, ...sheetStreams]);
}

export function buildXls(sheets: readonly XlsSheet[], options: XlsOptions = {}): Uint8Array {
  return buildCfb([{ name: "Workbook", data: buildXlsWorkbookStream(sheets, options) }]).bytes;
}

/** An RK value holding the integer `n` (fits in 30 bits). */
export function rkInt(n: number): number {
  return ((n << 2) | 0x02) >>> 0;
}

// ---------- .ppt ----------

function pptRecord(type: number, body: ArrayLike<number>, instance = 0, container = false): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  put16(out, 0, (instance << 4) | (container ? 0x0f : 0));
  put16(out, 2, type);
  put32(out, 4, body.length);
  out.set(body, 8);
  return out;
}

const pptContainer = (type: number, children: readonly Uint8Array[], instance = 0) => pptRecord(type, concat(children), instance, true);
const chars16 = (text: string) => pptRecord(0x0fa0, [...text].flatMap((c) => le16(c.charCodeAt(0))));
const chars8 = (text: string) => pptRecord(0x0fa8, [...text].map((c) => c.charCodeAt(0)));
const textHeader = (type: number) => pptRecord(0x0f9f, le32(type));

export interface PptSlide {
  readonly title: string;
  readonly body: string;
  readonly box?: string;
  readonly notes?: string;
}

export interface PptOptions {
  readonly encryptedToken?: boolean;
  /** Point the UserEditAtom's previous-edit offset back at itself. */
  readonly editLoop?: boolean;
}

export function buildPptStreams(slides: readonly PptSlide[], options: PptOptions = {}): CfbStream[] {
  const slideList: Uint8Array[] = [];
  const notesList: Uint8Array[] = [];
  slides.forEach((s, i) => {
    slideList.push(pptRecord(0x03f3, [...le32(2 + i * 2), 0, 0, 0, 0, ...le32(2), ...le32(256 + i), 0, 0, 0, 0]),
      textHeader(0), chars16(s.title), textHeader(1), chars8(s.body));
    if (s.notes) notesList.push(pptRecord(0x03f3, [...le32(3 + i * 2), 0, 0, 0, 0, ...le32(1), ...le32(0x100 + i), 0, 0, 0, 0]), textHeader(2), chars16(s.notes));
  });
  const documentAtom = pptRecord(0x03e9, [...le32(5760), ...le32(4320), ...new Array<number>(32).fill(0)]);
  const docChildren = [documentAtom, pptContainer(0x0ff0, slideList, 0)];
  if (notesList.length) docChildren.push(pptContainer(0x0ff0, notesList, 2));
  const parts: Uint8Array[] = [];
  const offsets = new Map<number, number>();
  let at = 0;
  const add = (persistId: number | null, rec: Uint8Array) => { if (persistId !== null) offsets.set(persistId, at); parts.push(rec); at += rec.length; };
  add(1, pptContainer(0x03e8, docChildren));
  slides.forEach((s, i) => {
    const slideAtom = pptRecord(0x03ef, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le32(s.notes ? 0x100 + i : 0), 0, 0, 0, 0]);
    const drawingChildren = [pptContainer(0xf00d, [pptRecord(0x0f9e, le32(0))]), pptContainer(0xf00d, [pptRecord(0x0f9e, le32(1))])];
    if (s.box) drawingChildren.push(pptContainer(0xf00d, [textHeader(4), chars16(s.box)]));
    add(2 + i * 2, pptContainer(0x03ee, [slideAtom, pptContainer(0x040c, [pptContainer(0xf002, drawingChildren)])]));
    if (s.notes) add(3 + i * 2, pptContainer(0x03f0, [pptRecord(0x03f1, new Array<number>(8).fill(0))]));
  });
  const ids = [...offsets.keys()].sort((a, b) => a - b);
  const dirBody: number[] = [];
  for (const id of ids) dirBody.push(...le32(id | (1 << 20)), ...le32(offsets.get(id)!));
  const dirAt = at;
  add(null, pptRecord(0x1772, dirBody));
  const editAt = at;
  add(null, pptRecord(0x0ff5, [...le32(256), 0, 0, 0, 3, ...le32(options.editLoop ? editAt : 0), ...le32(dirAt), ...le32(1), ...le32(ids[ids.length - 1] + 1), 1, 0, 0, 0]));
  const current = pptRecord(0x0ff6, [...le32(0x14), ...le32(options.encryptedToken ? 0xf3d1c4df : 0xe391c05f), ...le32(editAt), 0, 0, 0xf4, 0x03, 3, 0, 0, 0]);
  return [{ name: "PowerPoint Document", data: concat(parts) }, { name: "Current User", data: current }];
}

export function buildPpt(slides: readonly PptSlide[], options: PptOptions = {}): Uint8Array {
  return buildCfb(buildPptStreams(slides, options)).bytes;
}
