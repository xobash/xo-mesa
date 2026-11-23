// Compound File Binary (MS-CFB) reader and writer. The reader checks the
// header, follows every sector chain with a visited map (a cycle or an
// out-of-range sector refuses the file) and walks the directory tree with an
// explicit stack, so hostile input cannot loop or exhaust the stack. The
// writer emits version 3 (512-byte sectors) with a DIFAT when needed.
// Stream paths are storage names joined with "/" (MS-CFB 2.6.1 forbids "/"
// in names).

export class CfbError extends Error {}

export interface CfbStream {
  /** Storage names and the stream name, joined with "/". */
  readonly path: string;
  readonly size: number;
}

export interface CfbFile {
  /** Every stream, in directory order. */
  readonly streams: readonly CfbStream[];
  /** The stream's bytes, or `null` when no stream has that path (case-insensitive, as MS-CFB 2.6.4 compares). */
  read(path: string): Uint8Array | null;
}

export interface CfbStreamInput {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export const CFB_LIMITS = {
  maxFileBytes: 1024 * 1024 * 1024,
  maxDirectoryEntries: 65_536,
} as const;

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MAX_REG_SECT = 0xfffffffa;
const DIFSECT = 0xfffffffc;
const FATSECT = 0xfffffffd;
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECT = 0xffffffff;
const NO_STREAM = 0xffffffff;
const HEADER_DIFAT = 109;
const ENTRY_BYTES = 128;
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;
const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;
const WRITE_SECTOR = 512;
const MAX_NAME_UNITS = 31;

function fail(message: string): never {
  throw new CfbError(message);
}

export function isCfb(bytes: Uint8Array): boolean {
  if (bytes.length < SIGNATURE.length) return false;
  for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) return false;
  return true;
}

/** MS-CFB 2.6.4: shorter names sort first, then code units compared upper-case. */
function compareNames(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

interface Geometry {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly sectorSize: number;
  readonly sectorCount: number;
}

function sectorOffset(g: Geometry, sector: number): number {
  return (sector + 1) * g.sectorSize;
}

/** Sector numbers of one chain; refuses cycles, free entries and out-of-range sectors. */
function chainOf(table: Uint32Array, start: number, count: number, what: string): number[] {
  const out: number[] = [];
  if (start === END_OF_CHAIN) return out;
  const seen = new Uint8Array(count);
  let sector = start;
  for (let step = 0; step <= count; step++) {
    if (sector === END_OF_CHAIN) return out;
    if (sector >= count || sector >= table.length) fail(`The ${what} chain points outside the file.`);
    if (seen[sector]) fail(`The ${what} chain loops.`);
    seen[sector] = 1;
    out.push(sector);
    sector = table[sector];
  }
  return fail(`The ${what} chain is longer than the file.`);
}

function gather(g: Geometry, sectors: readonly number[], what: string): Uint8Array {
  const out = new Uint8Array(sectors.length * g.sectorSize);
  for (let i = 0; i < sectors.length; i++) {
    const at = sectorOffset(g, sectors[i]);
    if (at + g.sectorSize > g.bytes.length) {
      // The last sector of a file may be short; anything else is truncation.
      if (at >= g.bytes.length) fail(`The ${what} is truncated.`);
      out.set(g.bytes.subarray(at), i * g.sectorSize);
      continue;
    }
    out.set(g.bytes.subarray(at, at + g.sectorSize), i * g.sectorSize);
  }
  return out;
}

function readHeader(bytes: Uint8Array): Geometry & { view: DataView } {
  if (!isCfb(bytes)) fail("This is not a compound file.");
  if (bytes.length < 512) fail("The compound file header is truncated.");
  if (bytes.length > CFB_LIMITS.maxFileBytes) fail("The compound file is too large.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = view.getUint16(26, true);
  const shift = view.getUint16(30, true);
  if (view.getUint16(28, true) !== 0xfffe) fail("The compound file has an unknown byte order.");
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12))) fail("The compound file version is not supported.");
  if (view.getUint16(32, true) !== 6) fail("The compound file mini sector size is not supported.");
  if (view.getUint32(56, true) !== MINI_CUTOFF) fail("The compound file mini stream cutoff is not supported.");
  const sectorSize = 1 << shift;
  const sectorCount = Math.ceil(Math.max(0, bytes.length - sectorSize) / sectorSize);
  return { bytes, view, sectorSize, sectorCount };
}

/** FAT sector numbers from the header DIFAT and the DIFAT chain. */
function fatSectors(g: Geometry): number[] {
  const { view, sectorSize, sectorCount } = g;
  const fatCount = view.getUint32(44, true);
  if (fatCount > sectorCount) fail("The compound file lists more FAT sectors than it has.");
  const out: number[] = [];
  for (let i = 0; i < HEADER_DIFAT && out.length < fatCount; i++) out.push(view.getUint32(76 + i * 4, true));
  let difat = view.getUint32(68, true);
  const difatCount = view.getUint32(72, true);
  if (difatCount > sectorCount) fail("The compound file lists more DIFAT sectors than it has.");
  const perSector = sectorSize / 4 - 1;
  const seen = new Uint8Array(sectorCount);
  for (let n = 0; n < difatCount && out.length < fatCount; n++) {
    if (difat >= sectorCount || seen[difat]) fail("The compound file DIFAT chain is damaged.");
    seen[difat] = 1;
    const at = sectorOffset(g, difat);
    if (at + sectorSize > g.bytes.length) fail("The compound file DIFAT is truncated.");
    for (let i = 0; i < perSector && out.length < fatCount; i++) out.push(view.getUint32(at + i * 4, true));
    difat = view.getUint32(at + perSector * 4, true);
  }
  if (out.length < fatCount) fail("The compound file FAT list is incomplete.");
  for (const s of out) if (s >= sectorCount) fail("A compound file FAT sector is outside the file.");
  return out;
}

function readFat(g: Geometry): Uint32Array {
  const sectors = fatSectors(g);
  const raw = gather(g, sectors, "FAT");
  const fat = new Uint32Array(raw.length / 4);
  const dv = new DataView(raw.buffer);
  for (let i = 0; i < fat.length; i++) fat[i] = dv.getUint32(i * 4, true);
  return fat;
}

function toTable(raw: Uint8Array): Uint32Array {
  const out = new Uint32Array(Math.floor(raw.length / 4));
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = dv.getUint32(i * 4, true);
  return out;
}

interface DirEntry {
  readonly name: string;
  readonly type: number;
  readonly left: number;
  readonly right: number;
  readonly child: number;
  readonly start: number;
  readonly size: number;
}

function readEntry(dir: DataView, index: number, major: number): DirEntry {
  const at = index * ENTRY_BYTES;
  const nameBytes = dir.getUint16(at + 64, true);
  if (nameBytes > 64 || nameBytes % 2) fail("A compound file directory name is damaged.");
  let name = "";
  for (let i = 0; i + 2 < nameBytes; i += 2) name += String.fromCharCode(dir.getUint16(at + i, true));
  const low = dir.getUint32(at + 120, true);
  const high = dir.getUint32(at + 124, true);
  // MS-CFB 2.6.3: version 3 readers ignore the high 32 bits of the size.
  if (major === 4 && high !== 0) fail("A compound file stream is too large.");
  return {
    name,
    type: dir.getUint8(at + 66),
    left: dir.getUint32(at + 68, true),
    right: dir.getUint32(at + 72, true),
    child: dir.getUint32(at + 76, true),
    start: dir.getUint32(at + 116, true),
    size: low,
  };
}

/** Walks the red-black trees iteratively; each entry is visited at most once. */
function collectStreams(entries: readonly DirEntry[]): Map<string, { entry: DirEntry; path: string }> {
  const out = new Map<string, { entry: DirEntry; path: string }>();
  const root = entries[0];
  if (!root || root.type !== TYPE_ROOT) fail("The compound file has no root entry.");
  const seen = new Uint8Array(entries.length);
  seen[0] = 1;
  const stack: Array<{ index: number; parent: string }> = [];
  if (root.child !== NO_STREAM) stack.push({ index: root.child, parent: "" });
  for (let guard = 0; stack.length && guard <= entries.length; guard++) {
    const { index, parent } = stack.pop()!;
    if (index >= entries.length) fail("The compound file directory points outside itself.");
    if (seen[index]) fail("The compound file directory loops.");
    seen[index] = 1;
    const entry = entries[index];
    if (!entry.name || /[/\\:!]/.test(entry.name)) fail("A compound file entry has an invalid name.");
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    if (entry.left !== NO_STREAM) stack.push({ index: entry.left, parent });
    if (entry.right !== NO_STREAM) stack.push({ index: entry.right, parent });
    if (entry.type === TYPE_STORAGE) {
      if (entry.child !== NO_STREAM) stack.push({ index: entry.child, parent: path });
    } else if (entry.type === TYPE_STREAM) {
      const key = path.toUpperCase();
      if (out.has(key)) fail("The compound file has two streams with the same name.");
      out.set(key, { entry, path });
    } else {
      fail("The compound file directory has an entry of unknown type.");
    }
  }
  if (stack.length) fail("The compound file directory is too large.");
  return out;
}

/** Opens a compound file; streams are read on demand. Throws `CfbError` on any damage. */
export function readCfb(bytes: Uint8Array): CfbFile {
  const g = readHeader(bytes);
  const major = g.view.getUint16(26, true);
  const fat = readFat(g);
  const count = Math.min(g.sectorCount, fat.length);
  const dirRaw = gather(g, chainOf(fat, g.view.getUint32(48, true), count, "directory"), "directory");
  const entryCount = Math.floor(dirRaw.length / ENTRY_BYTES);
  if (entryCount > CFB_LIMITS.maxDirectoryEntries) fail("The compound file directory is too large.");
  const dirView = new DataView(dirRaw.buffer);
  const entries: DirEntry[] = [];
  for (let i = 0; i < entryCount; i++) entries.push(readEntry(dirView, i, major));
  const found = collectStreams(entries);
  const root = entries[0];
  let mini: { table: Uint32Array; stream: Uint8Array } | null = null;
  const loadMini = () => {
    if (mini) return mini;
    const miniFatStart = g.view.getUint32(60, true);
    const table = toTable(gather(g, chainOf(fat, miniFatStart, count, "mini FAT"), "mini FAT"));
    const stream = gather(g, chainOf(fat, root.start, count, "mini stream"), "mini stream");
    if (root.size > stream.length) fail("The compound file mini stream is truncated.");
    mini = { table, stream: stream.subarray(0, root.size) };
    return mini;
  };
  const readEntryBytes = (entry: DirEntry): Uint8Array => {
    if (entry.size > bytes.length) fail("A compound file stream is larger than the file.");
    if (entry.size === 0) return new Uint8Array(0);
    if (entry.size >= MINI_CUTOFF) {
      const data = gather(g, chainOf(fat, entry.start, count, "stream"), "stream");
      if (data.length < entry.size) fail("A compound file stream is truncated.");
      return data.slice(0, entry.size);
    }
    const m = loadMini();
    const miniCount = Math.floor(m.stream.length / MINI_SECTOR);
    const out = new Uint8Array(entry.size);
    let sector = entry.start;
    const seen = new Uint8Array(miniCount);
    for (let done = 0; done < entry.size; done += MINI_SECTOR) {
      if (sector >= miniCount || sector >= m.table.length) fail("A compound file mini stream chain points outside the mini stream.");
      if (seen[sector]) fail("A compound file mini stream chain loops.");
      seen[sector] = 1;
      out.set(m.stream.subarray(sector * MINI_SECTOR, sector * MINI_SECTOR + Math.min(MINI_SECTOR, entry.size - done)), done);
      sector = m.table[sector];
    }
    return out;
  };
  const streams = [...found.values()].map(({ entry, path }) => ({ path, size: entry.size }));
  return {
    streams,
    read(path) {
      const hit = found.get(path.toUpperCase());
      return hit ? readEntryBytes(hit.entry) : null;
    },
  };
}

// ---- Writer ----

interface WriteNode {
  readonly name: string;
  readonly type: number;
  readonly bytes: Uint8Array | null;
  readonly children: WriteNode[];
  index: number;
  left: number;
  right: number;
  child: number;
  start: number;
}

function checkName(name: string): void {
  if (!name || name.length > MAX_NAME_UNITS || /[/\\:!]/.test(name)) fail(`"${name}" is not a valid compound file name.`);
}

function buildTree(streams: readonly CfbStreamInput[]): { root: WriteNode; order: WriteNode[] } {
  const node = (name: string, type: number, bytes: Uint8Array | null): WriteNode =>
    ({ name, type, bytes, children: [], index: -1, left: NO_STREAM, right: NO_STREAM, child: NO_STREAM, start: END_OF_CHAIN });
  const root = node("Root Entry", TYPE_ROOT, null);
  const byPath = new Map<string, WriteNode>([["", root]]);
  for (const { path, bytes } of streams) {
    const names = path.split("/");
    let parentKey = "";
    for (let i = 0; i < names.length; i++) {
      checkName(names[i]);
      const key = `${parentKey}/${names[i].toUpperCase()}`;
      const last = i === names.length - 1;
      const existing = byPath.get(key);
      if (existing && (last || existing.type !== TYPE_STORAGE)) fail(`The compound file path "${path}" is used twice.`);
      if (!existing) {
        const made = node(names[i], last ? TYPE_STREAM : TYPE_STORAGE, last ? bytes : null);
        byPath.get(parentKey)!.children.push(made);
        byPath.set(key, made);
      }
      parentKey = key;
    }
  }
  // Breadth-first numbering, root first.
  const order: WriteNode[] = [root];
  for (let i = 0; i < order.length; i++) {
    order[i].index = i;
    order[i].children.sort((a, b) => compareNames(a.name, b.name));
    for (const c of order[i].children) order.push(c);
  }
  if (order.length > CFB_LIMITS.maxDirectoryEntries) fail("Too many compound file entries.");
  for (const parent of order) parent.child = balance(parent.children);
  return { root, order };
}

/** Balanced binary search tree over sorted siblings, built with an explicit stack; returns the root index. */
function balance(sorted: WriteNode[]): number {
  if (!sorted.length) return NO_STREAM;
  const top = sorted.length >> 1;
  const stack: Array<{ lo: number; hi: number; at: number }> = [{ lo: 0, hi: sorted.length - 1, at: top }];
  for (let guard = 0; stack.length && guard <= sorted.length; guard++) {
    const { lo, hi, at } = stack.pop()!;
    if (lo <= at - 1) {
      const l = (lo + at - 1) >> 1;
      sorted[at].left = sorted[l].index;
      stack.push({ lo, hi: at - 1, at: l });
    }
    if (at + 1 <= hi) {
      const r = (at + 1 + hi) >> 1;
      sorted[at].right = sorted[r].index;
      stack.push({ lo: at + 1, hi, at: r });
    }
  }
  return sorted[top].index;
}

const sectorsFor = (bytes: number, size: number) => Math.ceil(bytes / size);

/** Writes a version 3 compound file holding exactly `streams` (storages are implied by paths). */
export function writeCfb(streams: readonly CfbStreamInput[]): Uint8Array {
  const { root, order } = buildTree(streams);
  const files = order.filter((n) => n.type === TYPE_STREAM);
  const small = files.filter((n) => n.bytes!.length > 0 && n.bytes!.length < MINI_CUTOFF);
  const big = files.filter((n) => n.bytes!.length >= MINI_CUTOFF);
  const miniSectors = small.reduce((sum, n) => sum + sectorsFor(n.bytes!.length, MINI_SECTOR), 0);
  const miniStreamSectors = sectorsFor(miniSectors * MINI_SECTOR, WRITE_SECTOR);
  const miniFatSectors = sectorsFor(miniSectors * 4, WRITE_SECTOR);
  const dirSectors = sectorsFor(order.length * ENTRY_BYTES, WRITE_SECTOR);
  const bigSectors = big.reduce((sum, n) => sum + sectorsFor(n.bytes!.length, WRITE_SECTOR), 0);
  const content = dirSectors + miniFatSectors + miniStreamSectors + bigSectors;
  const perFat = WRITE_SECTOR / 4;
  let fatCount = 1;
  let difatCount = 0;
  for (let i = 0; i < 32; i++) {
    difatCount = fatCount > HEADER_DIFAT ? sectorsFor(fatCount - HEADER_DIFAT, perFat - 1) : 0;
    const need = sectorsFor(content + fatCount + difatCount, perFat);
    if (need <= fatCount) break;
    fatCount = need;
  }
  const total = content + fatCount + difatCount;
  if (total >= MAX_REG_SECT || (total + 1) * WRITE_SECTOR > CFB_LIMITS.maxFileBytes) fail("The compound file would be too large.");
  const out = new Uint8Array((total + 1) * WRITE_SECTOR);
  const view = new DataView(out.buffer);
  const fat = new Uint32Array(fatCount * perFat).fill(FREE_SECT);
  let next = 0;
  const run = (count: number, mark?: number): number => {
    const first = next;
    for (let i = 0; i < count; i++) fat[first + i] = mark ?? (i === count - 1 ? END_OF_CHAIN : first + i + 1);
    next += count;
    return count ? first : END_OF_CHAIN;
  };
  run(fatCount, FATSECT);
  const firstDifat = run(difatCount, DIFSECT);
  const firstDir = run(dirSectors);
  const firstMiniFat = run(miniFatSectors);
  root.start = run(miniStreamSectors);
  const at = (sector: number) => (sector + 1) * WRITE_SECTOR;
  for (const n of big) {
    n.start = run(sectorsFor(n.bytes!.length, WRITE_SECTOR));
    out.set(n.bytes!, at(n.start));
  }
  // Mini stream and mini FAT.
  const miniFat = new Uint32Array(miniFatSectors * perFat).fill(FREE_SECT);
  let miniNext = 0;
  for (const n of small) {
    const count = sectorsFor(n.bytes!.length, MINI_SECTOR);
    n.start = miniNext;
    for (let i = 0; i < count; i++) miniFat[miniNext + i] = i === count - 1 ? END_OF_CHAIN : miniNext + i + 1;
    out.set(n.bytes!, at(root.start) + miniNext * MINI_SECTOR);
    miniNext += count;
  }
  for (let i = 0; i < miniFat.length; i++) view.setUint32(at(firstMiniFat) + i * 4, miniFat[i], true);
  // Directory.
  for (let i = 0; i < dirSectors * (WRITE_SECTOR / ENTRY_BYTES); i++) {
    const base = at(firstDir) + i * ENTRY_BYTES;
    const n = order[i];
    view.setUint32(base + 68, NO_STREAM, true);
    view.setUint32(base + 72, NO_STREAM, true);
    view.setUint32(base + 76, NO_STREAM, true);
    if (!n) continue;
    for (let c = 0; c < n.name.length; c++) view.setUint16(base + c * 2, n.name.charCodeAt(c), true);
    view.setUint16(base + 64, (n.name.length + 1) * 2, true);
    view.setUint8(base + 66, n.type);
    view.setUint8(base + 67, 1); // black
    view.setUint32(base + 68, n.left, true);
    view.setUint32(base + 72, n.right, true);
    view.setUint32(base + 76, n.child, true);
    const size = n.type === TYPE_ROOT ? miniSectors * MINI_SECTOR : n.bytes?.length ?? 0;
    view.setUint32(base + 116, n.type === TYPE_STORAGE || size === 0 ? (n.type === TYPE_STORAGE ? 0 : END_OF_CHAIN) : n.start, true);
    view.setUint32(base + 120, size, true);
  }
  // FAT, DIFAT and header.
  for (let i = 0; i < fat.length; i++) view.setUint32(at(Math.floor(i / perFat)) + (i % perFat) * 4, fat[i], true);
  for (let d = 0; d < difatCount; d++) {
    const base = at(firstDifat + d);
    for (let i = 0; i < perFat - 1; i++) {
      const k = HEADER_DIFAT + d * (perFat - 1) + i;
      view.setUint32(base + i * 4, k < fatCount ? k : FREE_SECT, true);
    }
    view.setUint32(base + (perFat - 1) * 4, d === difatCount - 1 ? END_OF_CHAIN : firstDifat + d + 1, true);
  }
  out.set(SIGNATURE, 0);
  view.setUint16(24, 0x003e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, fatCount, true);
  view.setUint32(48, firstDir, true);
  view.setUint32(56, MINI_CUTOFF, true);
  view.setUint32(60, firstMiniFat, true);
  view.setUint32(64, miniFatSectors, true);
  view.setUint32(68, firstDifat, true);
  view.setUint32(72, difatCount, true);
  for (let i = 0; i < HEADER_DIFAT; i++) view.setUint32(76 + i * 4, i < fatCount ? i : FREE_SECT, true);
  return out;
}
