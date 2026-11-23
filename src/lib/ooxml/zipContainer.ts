import { Inflate, deflateSync } from "fflate";
import { isCfb } from "../cfb";
import { pdfBytesEqual } from "../pdfBytes";
import { decodeZipEntryName, u16, u32 } from "../zipCodec";
import { crc32 } from "./crc32";
import { formatBytes } from "../formatBytes";

// Lossless ZIP container for Office Open XML packages (ECMA-376 Part 2, OPC).
// Reading validates the whole central directory and every local record
// before any decompression. Writing copies each unchanged local record
// byte-for-byte (raw compressed data, same order, timestamps, extra fields
// and archive comment); only replaced or added entries are re-encoded.
// Layout references: PKWARE APPNOTE 6.3.10 sections 4.3.7 (local header),
// 4.3.9 (data descriptor), 4.3.12 (central header), 4.3.16 (end record).

export const OOXML_PACKAGE_LIMITS = {
  maxPackageBytes: 256 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 128 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  /** Ratio cap (expanded / compressed) for entries at or above `ratioFloorBytes`. */
  maxCompressionRatio: 500,
  ratioFloorBytes: 1024 * 1024,
} as const;

export type OoxmlRefusal =
  | "encrypted" | "notZip" | "zip64" | "multiDisk" | "tooLarge" | "tooManyEntries"
  | "zipBomb" | "unsafePath" | "duplicateName" | "encryptedEntry" | "unsupportedCompression"
  | "symlink" | "malformed" | "corrupt" | "unsupportedXml";

export class OoxmlPackageError extends Error {
  constructor(readonly code: OoxmlRefusal, message: string) {
    super(message);
    this.name = "OoxmlPackageError";
  }
}

export interface ZipEntryRecord {
  /** Central-directory position. */
  readonly index: number;
  readonly name: string;
  readonly rawName: Uint8Array;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly expandedSize: number;
  readonly centralStart: number;
  readonly centralEnd: number;
  readonly localStart: number;
  readonly dataStart: number;
  /** End of the local record, including any data descriptor. */
  readonly localEnd: number;
  readonly isDirectory: boolean;
}

export interface ZipContainer {
  readonly bytes: Uint8Array;
  /** Central-directory order. */
  readonly entries: readonly ZipEntryRecord[];
  readonly centralStart: number;
  readonly eocdStart: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_DESCRIPTOR = 0x08074b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const INFLATE_CHUNK = 16 * 1024;

function fail(code: OoxmlRefusal, message: string): never {
  throw new OoxmlPackageError(code, message);
}


function findEndRecord(bytes: Uint8Array): number {
  const first = Math.max(0, bytes.length - 0xffff - 22);
  for (let at = bytes.length - 22; at >= first; at--) {
    if (u32(bytes, at) === SIG_EOCD && at + 22 + u16(bytes, at + 20) === bytes.length) return at;
  }
  return fail("notZip", "This file is not a ZIP-based Office document.");
}

function checkEndRecord(bytes: Uint8Array, eocd: number): { count: number; centralStart: number } {
  if (eocd >= 20 && u32(bytes, eocd - 20) === SIG_ZIP64_LOCATOR) fail("zip64", "ZIP64 packages are not supported.");
  if (u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0 || u16(bytes, eocd + 8) !== u16(bytes, eocd + 10)) {
    fail("multiDisk", "Split (multi-disk) packages are not supported.");
  }
  const count = u16(bytes, eocd + 10);
  const size = u32(bytes, eocd + 12);
  const centralStart = u32(bytes, eocd + 16);
  if (count === 0xffff || size === 0xffffffff || centralStart === 0xffffffff) fail("zip64", "ZIP64 packages are not supported.");
  if (count > OOXML_PACKAGE_LIMITS.maxEntries) fail("tooManyEntries", `The package has ${count} entries; the limit is ${OOXML_PACKAGE_LIMITS.maxEntries}.`);
  if (centralStart + size !== eocd) fail("malformed", "The package's central directory does not end at its end record.");
  return { count, centralStart };
}

function hasForbiddenCharacter(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x5c || code === 0x3a) return true; // controls, backslash, colon
  }
  return false;
}

/** OPC part names (ECMA-376 Part 2 section 6.2.2) plus ZIP-level traversal guards. */
function checkEntryName(name: string): void {
  const body = name.endsWith("/") ? name.slice(0, -1) : name;
  const unsafe = !body || hasForbiddenCharacter(body) || body.startsWith("/")
    || body.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.endsWith("."));
  if (unsafe) fail("unsafePath", `The package has an unsafe entry name: ${JSON.stringify(name)}.`);
}

function hasZip64Extra(bytes: Uint8Array, start: number, end: number): boolean {
  let at = start;
  for (let guard = 0; guard < 0x4000 && at + 4 <= end; guard++) {
    if (u16(bytes, at) === 0x0001) return true;
    at += 4 + u16(bytes, at + 2);
  }
  return false;
}

interface CentralFields {
  flags: number; method: number; crc: number; compressedSize: number; expandedSize: number;
  rawName: Uint8Array; name: string; localStart: number; centralEnd: number;
}

function readCentralFields(bytes: Uint8Array, at: number, limit: number): CentralFields {
  if (at + 46 > limit || u32(bytes, at) !== SIG_CENTRAL) fail("malformed", "The package's central directory is malformed.");
  const nameLength = u16(bytes, at + 28);
  const extraStart = at + 46 + nameLength;
  const centralEnd = extraStart + u16(bytes, at + 30) + u16(bytes, at + 32);
  if (centralEnd > limit) fail("malformed", "A central directory entry is truncated.");
  const flags = u16(bytes, at + 8);
  const rawName = bytes.slice(at + 46, extraStart);
  const fields: CentralFields = {
    flags, method: u16(bytes, at + 10), crc: u32(bytes, at + 16), compressedSize: u32(bytes, at + 20),
    expandedSize: u32(bytes, at + 24), rawName, name: decodeZipEntryName(rawName, flags),
    localStart: u32(bytes, at + 42), centralEnd,
  };
  if (u16(bytes, at + 34) !== 0) fail("multiDisk", "Split (multi-disk) packages are not supported.");
  if ((u32(bytes, at + 38) >>> 16 & 0o170000) === 0o120000) fail("symlink", `The package entry ${fields.name} is a symbolic link.`);
  if (fields.compressedSize === 0xffffffff || fields.expandedSize === 0xffffffff || fields.localStart === 0xffffffff
    || hasZip64Extra(bytes, extraStart, extraStart + u16(bytes, at + 30))) fail("zip64", "ZIP64 packages are not supported.");
  return fields;
}

function checkEntryPolicy(fields: CentralFields): void {
  if (fields.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) fail("encryptedEntry", `The package entry ${fields.name} is encrypted.`);
  if (fields.method !== 0 && fields.method !== 8) fail("unsupportedCompression", `The package entry ${fields.name} uses unsupported compression.`);
  checkEntryName(fields.name);
  const limits = OOXML_PACKAGE_LIMITS;
  if (fields.expandedSize > limits.maxEntryBytes) fail("tooLarge", `The package entry ${fields.name} is larger than ${formatBytes(limits.maxEntryBytes)}.`);
  if (fields.method === 0 && fields.compressedSize !== fields.expandedSize) fail("malformed", `The stored entry ${fields.name} has inconsistent sizes.`);
  const ratio = fields.expandedSize / Math.max(1, fields.compressedSize);
  if (fields.expandedSize >= limits.ratioFloorBytes && ratio > limits.maxCompressionRatio) {
    fail("zipBomb", `The package entry ${fields.name} expands ${Math.round(ratio)} times; the limit is ${limits.maxCompressionRatio}.`);
  }
}

function descriptorEnd(bytes: Uint8Array, dataEnd: number, fields: CentralFields, limit: number): number {
  const signed = dataEnd + 4 <= limit && u32(bytes, dataEnd) === SIG_DESCRIPTOR;
  const fieldsAt = signed ? dataEnd + 4 : dataEnd;
  const end = fieldsAt + 12;
  if (end > limit || u32(bytes, fieldsAt) !== fields.crc || u32(bytes, fieldsAt + 4) !== fields.compressedSize
    || u32(bytes, fieldsAt + 8) !== fields.expandedSize) fail("malformed", `The data descriptor of ${fields.name} disagrees with the central directory.`);
  return end;
}

function readLocalRecord(bytes: Uint8Array, fields: CentralFields, limit: number): { dataStart: number; localEnd: number } {
  const at = fields.localStart;
  if (at + 30 > limit || u32(bytes, at) !== SIG_LOCAL) fail("malformed", `The local header of ${fields.name} is missing.`);
  const nameLength = u16(bytes, at + 26);
  const dataStart = at + 30 + nameLength + u16(bytes, at + 28);
  const sameHeader = u16(bytes, at + 6) === fields.flags && u16(bytes, at + 8) === fields.method
    && pdfBytesEqual(bytes.subarray(at + 30, at + 30 + nameLength), fields.rawName);
  if (!sameHeader) fail("malformed", `The local header of ${fields.name} disagrees with the central directory.`);
  const declared = (fields.flags & FLAG_DESCRIPTOR) !== 0
    || (u32(bytes, at + 14) === fields.crc && u32(bytes, at + 18) === fields.compressedSize && u32(bytes, at + 22) === fields.expandedSize);
  if (!declared) fail("malformed", `The local header of ${fields.name} disagrees with the central directory.`);
  const dataEnd = dataStart + fields.compressedSize;
  if (dataEnd > limit) fail("malformed", `The data of ${fields.name} runs past the central directory.`);
  const localEnd = fields.flags & FLAG_DESCRIPTOR ? descriptorEnd(bytes, dataEnd, fields, limit) : dataEnd;
  return { dataStart, localEnd };
}

/** Local records must tile [0, centralStart) exactly: no prefix, gap or overlap. */
function checkTiling(entries: readonly ZipEntryRecord[], centralStart: number): void {
  const ordered = [...entries].sort((a, b) => a.localStart - b.localStart);
  let expected = 0;
  for (const entry of ordered) {
    if (entry.localStart !== expected) fail("malformed", "The package has gaps, prefixes or overlapping entries.");
    expected = entry.localEnd;
  }
  if (expected !== centralStart) fail("malformed", "The package has data between its last entry and its central directory.");
}

/** Reads and validates the package structure without decompressing anything. */
export function readZipContainer(bytes: Uint8Array): ZipContainer {
  // Encrypted OOXML (MS-OFFCRYPTO) and legacy .doc/.xls/.ppt are OLE compound files.
  if (isCfb(bytes)) fail("encrypted", "This file is encrypted or in the legacy binary Office format; Mesa cannot edit it.");
  if (bytes.length > OOXML_PACKAGE_LIMITS.maxPackageBytes) fail("tooLarge", `The package is larger than ${formatBytes(OOXML_PACKAGE_LIMITS.maxPackageBytes)}.`);
  if (bytes.length < 22) fail("notZip", "This file is not a ZIP-based Office document.");
  const eocdStart = findEndRecord(bytes);
  const { count, centralStart } = checkEndRecord(bytes, eocdStart);
  const entries: ZipEntryRecord[] = [];
  const seen = new Set<string>();
  let expanded = 0;
  let at = centralStart;
  for (let index = 0; index < count; index++) {
    const fields = readCentralFields(bytes, at, eocdStart);
    checkEntryPolicy(fields);
    // OPC part names compare case-insensitively over ASCII (Part 2 section 6.2.2.3).
    const key = fields.name.toLowerCase();
    if (seen.has(key)) fail("duplicateName", `The package has two entries named ${fields.name}.`);
    seen.add(key);
    expanded += fields.expandedSize;
    if (expanded > OOXML_PACKAGE_LIMITS.maxExpandedBytes) fail("zipBomb", `The package expands beyond ${formatBytes(OOXML_PACKAGE_LIMITS.maxExpandedBytes)}.`);
    const local = readLocalRecord(bytes, fields, centralStart);
    entries.push({
      index, name: fields.name, rawName: fields.rawName, flags: fields.flags, method: fields.method, crc: fields.crc,
      compressedSize: fields.compressedSize, expandedSize: fields.expandedSize, centralStart: at, centralEnd: fields.centralEnd,
      localStart: fields.localStart, dataStart: local.dataStart, localEnd: local.localEnd, isDirectory: fields.name.endsWith("/"),
    });
    at = fields.centralEnd;
  }
  if (at !== eocdStart) fail("malformed", "The central directory has trailing data.");
  checkTiling(entries, centralStart);
  return { bytes, entries, centralStart, eocdStart };
}

function boundedInflate(raw: Uint8Array, expected: number, name: string): Uint8Array {
  const out = new Uint8Array(expected);
  let filled = 0;
  let ended = false;
  const inflater = new Inflate((chunk, final) => {
    if (filled + chunk.length > expected) fail("zipBomb", `The package entry ${name} expands beyond its declared size.`);
    out.set(chunk, filled);
    filled += chunk.length;
    ended ||= final;
  });
  try {
    const last = Math.max(0, raw.length - 1);
    for (let at = 0; at <= last; at += INFLATE_CHUNK) inflater.push(raw.subarray(at, at + INFLATE_CHUNK), at + INFLATE_CHUNK > last);
  } catch (error) {
    if (error instanceof OoxmlPackageError) throw error;
    fail("corrupt", `The package entry ${name} could not be decompressed.`);
  }
  if (!ended || filled !== expected) fail("corrupt", `The package entry ${name} has the wrong decompressed size.`);
  return out;
}

/** Decompresses one entry, enforcing its declared size and CRC-32. */
export function readEntryBytes(container: ZipContainer, entry: ZipEntryRecord): Uint8Array {
  const raw = container.bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  const out = entry.method === 0 ? raw.slice() : boundedInflate(raw, entry.expandedSize, entry.name);
  if (crc32(out) !== entry.crc) fail("corrupt", `The package entry ${entry.name} fails its checksum.`);
  return out;
}

/**
 * First entry of `original` (other than `skip`ped names) that `saved` lost or
 * changed: compressed bytes, method, CRC-32 or expanded size. Compares raw
 * records, so nothing is inflated; `null` when every entry was kept.
 */
export function firstAlteredEntry(original: ZipContainer, saved: ZipContainer, skip: (name: string) => boolean): string | null {
  const written = new Map(saved.entries.map((e) => [e.name, e]));
  const raw = (c: ZipContainer, e: ZipEntryRecord) => c.bytes.subarray(e.dataStart, e.dataStart + e.compressedSize);
  for (const entry of original.entries) {
    if (skip(entry.name)) continue;
    const copy = written.get(entry.name);
    if (!copy || copy.crc !== entry.crc || copy.method !== entry.method || copy.expandedSize !== entry.expandedSize
      || !pdfBytesEqual(raw(saved, copy), raw(original, entry))) return entry.name;
  }
  return null;
}

// ---------- writing ----------

/** Replacement bytes, or `null` to remove. Names not in the package are appended in map order. */
export type ZipEdits = ReadonlyMap<string, Uint8Array | null>;

interface Encoded { crc: number; data: Uint8Array; method: number; size: number }

function encode(content: Uint8Array): Encoded {
  const deflated = deflateSync(content, { level: 6 });
  const stored = deflated.length >= content.length;
  return { crc: crc32(content), data: stored ? content : deflated, method: stored ? 0 : 8, size: content.length };
}

function localHeader(rawName: Uint8Array, extra: Uint8Array, versionNeeded: number, flags: number, time: number, date: number, enc: Encoded): Uint8Array {
  const out = new Uint8Array(30 + rawName.length + extra.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, SIG_LOCAL, true);
  view.setUint16(4, versionNeeded, true);
  view.setUint16(6, flags, true);
  view.setUint16(8, enc.method, true);
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  view.setUint32(14, enc.crc, true);
  view.setUint32(18, enc.data.length, true);
  view.setUint32(22, enc.size, true);
  view.setUint16(26, rawName.length, true);
  view.setUint16(28, extra.length, true);
  out.set(rawName, 30);
  out.set(extra, 30 + rawName.length);
  return out;
}

function patchCentral(record: Uint8Array, flags: number, enc: Encoded): void {
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  view.setUint16(8, flags, true);
  view.setUint16(10, enc.method, true);
  view.setUint32(16, enc.crc, true);
  view.setUint32(20, enc.data.length, true);
  view.setUint32(24, enc.size, true);
}

function newCentral(rawName: Uint8Array, template: Uint8Array, flags: number, enc: Encoded): Uint8Array {
  const out = new Uint8Array(46 + rawName.length);
  out.set(template.subarray(4, 16), 4); // version made by, needed, flags, method, time, date
  const view = new DataView(out.buffer);
  view.setUint32(0, SIG_CENTRAL, true);
  view.setUint16(28, rawName.length, true);
  view.setUint32(38, 0, true);
  out.set(rawName, 46);
  patchCentral(out, flags, enc);
  return out;
}

interface Piece { localRecord: Uint8Array[]; central: Uint8Array }

function replacedPiece(container: ZipContainer, entry: ZipEntryRecord, content: Uint8Array): Piece {
  const b = container.bytes;
  const enc = encode(content);
  const flags = entry.flags & ~FLAG_DESCRIPTOR;
  const localExtra = b.subarray(entry.localStart + 30 + entry.rawName.length, entry.dataStart);
  const header = localHeader(entry.rawName, localExtra, u16(b, entry.localStart + 4), flags, u16(b, entry.localStart + 10), u16(b, entry.localStart + 12), enc);
  const central = b.slice(entry.centralStart, entry.centralEnd);
  patchCentral(central, flags, enc);
  return { localRecord: [header, enc.data], central };
}

/** Central-record template for an archive with no entries: version 2.0 made and needed, DOS date 1980-01-01. */
function emptyArchiveTemplate(): Uint8Array {
  const out = new Uint8Array(46);
  const view = new DataView(out.buffer);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(14, 0x21, true);
  return out;
}

function addedPiece(container: ZipContainer, name: string, content: Uint8Array): Piece {
  const first = container.entries[0];
  const template = first ? container.bytes.subarray(first.centralStart, first.centralStart + 46) : emptyArchiveTemplate();
  const rawName = new TextEncoder().encode(name);
  const flags = /^[\x20-\x7e]*$/.test(name) ? 0 : FLAG_UTF8;
  const enc = encode(content);
  const header = localHeader(rawName, new Uint8Array(0), 20, flags, u16(template, 12), u16(template, 14), enc);
  return { localRecord: [header, enc.data], central: newCentral(rawName, template, flags, enc) };
}

function validateEdits(container: ZipContainer, edits: ZipEdits): void {
  const existing = new Map(container.entries.map((e) => [e.name.toLowerCase(), e.name]));
  for (const [name, content] of edits) {
    checkEntryName(name);
    const match = existing.get(name.toLowerCase());
    if (match !== undefined && match !== name) fail("duplicateName", `${name} differs only in case from the existing entry ${match}.`);
    if (match === undefined && content === null) fail("malformed", `Cannot remove ${name}: the package has no such entry.`);
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

function endRecord(container: ZipContainer, count: number, centralSize: number, centralStart: number): Uint8Array {
  const out = container.bytes.slice(container.eocdStart);
  const view = new DataView(out.buffer);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralStart, true);
  return out;
}

/**
 * Rebuilds the package. Unchanged entries keep their exact local record bytes
 * and central record (offset patched); the end record keeps its comment.
 * With no edits the input array itself is returned.
 */
export function writeZipContainer(container: ZipContainer, edits: ZipEdits): Uint8Array {
  if (edits.size === 0) return container.bytes;
  validateEdits(container, edits);
  const byLocalOrder = [...container.entries].sort((a, b) => a.localStart - b.localStart);
  const centralByIndex = new Map<number, Uint8Array>();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const place = (piece: Piece): Uint8Array => {
    new DataView(piece.central.buffer, piece.central.byteOffset).setUint32(42, offset, true);
    for (const part of piece.localRecord) { chunks.push(part); offset += part.length; }
    return piece.central;
  };
  for (const entry of byLocalOrder) {
    const content = edits.get(entry.name);
    if (content === null) continue;
    const piece = content === undefined
      ? { localRecord: [container.bytes.subarray(entry.localStart, entry.localEnd)], central: container.bytes.slice(entry.centralStart, entry.centralEnd) }
      : replacedPiece(container, entry, content);
    centralByIndex.set(entry.index, place(piece));
  }
  const known = new Set(container.entries.map((e) => e.name));
  const added = [...edits].filter(([name, content]) => !known.has(name) && content !== null)
    .map(([name, content]) => place(addedPiece(container, name, content as Uint8Array)));
  const central = [...container.entries.map((e) => centralByIndex.get(e.index)).filter((c): c is Uint8Array => c !== undefined), ...added];
  if (central.length > OOXML_PACKAGE_LIMITS.maxEntries) fail("tooManyEntries", "The saved package would have too many entries.");
  const centralStart = offset;
  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  if (centralStart + centralSize > OOXML_PACKAGE_LIMITS.maxPackageBytes) fail("tooLarge", "The saved package would exceed the package size limit.");
  return concat([...chunks, ...central, endRecord(container, central.length, centralSize, centralStart)]);
}
