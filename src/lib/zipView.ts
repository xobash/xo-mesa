import { Inflate } from "fflate";
import type { ByteSource } from "./byteSource";
import { ZIP_END_SEARCH_BYTES, findZipEnd, isZipSymlink, parseZipCentralDirectory, u16, u32, unsafeZipPathReason, zipDirectoryRange } from "./zipCodec";
import { formatBytes } from "./formatBytes";

/**
 * Read-only ZIP inspection for the file viewer. Nothing here writes to disk.
 * The archive is never read whole: listing reads the end record and the
 * central directory, and one entry is read and decoded at a time, in memory,
 * under fixed limits. Archive size is not limited.
 */
export const ZIP_VIEW_LIMITS = {
  /** Central-directory bytes read; a larger directory is listed partly. */
  maxDirectoryBytes: 16 * 1024 * 1024,
  /** Rows listed; a larger directory is listed partly and says so. */
  maxListedEntries: 10_000,
  /** Largest single entry decoded for a text or byte preview. */
  maxPreviewBytes: 1024 * 1024,
  /** Compressed bytes pushed to the decoder per step; bounds the output one
   *  step can produce (deflate expands at most ~1032x). */
  inflateStepBytes: 4096,
} as const;

export interface ZipViewEntry {
  index: number;
  name: string;
  size: number;
  compressedSize: number;
  modified: Date | null;
  directory: boolean;
  encrypted: boolean;
  method: number;
  /** Why this name would be unsafe to extract, or why it is a link. */
  unsafe: string | null;
  localHeaderOffset: number;
}

export interface ZipListing {
  entries: ZipViewEntry[];
  declaredEntries: number;
  truncated: boolean;
  totalSize: number;
}

/** MS-DOS date/time fields; invalid fields give `null`. */
export function dosDateTime(date: number, time: number): Date | null {
  const year = 1980 + (date >>> 9);
  const month = (date >>> 5) & 15;
  const day = date & 31;
  const hours = time >>> 11;
  const minutes = (time >>> 5) & 63;
  const seconds = (time & 31) * 2;
  if (month < 1 || month > 12 || day < 1 || hours > 23 || minutes > 59 || seconds > 59) return null;
  return new Date(year, month - 1, day, hours, minutes, seconds);
}

/** Lists an archive from its end record and central directory only. Throws
 *  a plain sentence for archives that cannot be listed. */
export async function listZipArchive(source: ByteSource): Promise<ZipListing> {
  const tailLength = Math.min(source.size, ZIP_END_SEARCH_BYTES);
  const tailStart = source.size - tailLength;
  const end = findZipEnd(await source.read(tailStart, tailLength));
  const range = zipDirectoryRange(end, tailStart + end.eocd);
  const readBytes = Math.min(range.end - range.start, ZIP_VIEW_LIMITS.maxDirectoryBytes);
  const directory = await source.read(range.start, readBytes);
  const records = parseZipCentralDirectory(directory, end.entries, ZIP_VIEW_LIMITS.maxListedEntries, readBytes === range.end - range.start);
  const declaredEntries = end.entries;
  let totalSize = 0;
  const entries = records.map((record, index): ZipViewEntry => {
    totalSize += record.expandedBytes;
    return {
      index,
      name: record.name,
      size: record.expandedBytes,
      compressedSize: record.compressedBytes,
      modified: dosDateTime(record.dosDate, record.dosTime),
      directory: record.name.endsWith("/") || record.name.endsWith("\\"),
      encrypted: (record.flags & 1) === 1,
      method: record.method,
      unsafe: isZipSymlink(record) ? "symbolic link" : unsafeZipPathReason(record.name),
      localHeaderOffset: record.localHeaderOffset,
    };
  });
  return { entries, declaredEntries, truncated: declaredEntries > records.length, totalSize };
}

/** Deflate with a hard output ceiling. Input goes in small steps so a bomb
 *  stops after at most one step's expansion beyond `expected`. */
function inflateBounded(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let filled = 0;
  let overflow = false;
  const inflater = new Inflate((chunk) => {
    if (overflow) return;
    if (filled + chunk.length > expected) { overflow = true; return; }
    out.set(chunk, filled);
    filled += chunk.length;
  });
  const step = ZIP_VIEW_LIMITS.inflateStepBytes;
  if (input.length === 0) inflater.push(input, true);
  for (let at = 0; at < input.length && !overflow; at += step) {
    inflater.push(input.subarray(at, at + step), at + step >= input.length);
  }
  if (overflow) throw new Error("This entry expands beyond its declared size. Mesa refused it as a possible ZIP bomb.");
  if (filled !== expected) throw new Error("This entry is damaged: it is shorter than its declared size.");
  return out;
}

/**
 * Reads and decodes one entry in memory. Refuses directories, encrypted
 * entries, unsupported methods, declared sizes over `maxBytes`, compressed
 * data far larger than that, data outside the archive and output larger than
 * declared.
 */
export async function readZipEntry(source: ByteSource, entry: ZipViewEntry, maxBytes: number = ZIP_VIEW_LIMITS.maxPreviewBytes): Promise<Uint8Array> {
  if (entry.directory) throw new Error("This entry is a folder.");
  if (entry.encrypted) throw new Error("This entry is encrypted. Mesa cannot preview it.");
  if (entry.size > maxBytes) {
    throw new Error(`This entry is ${formatBytes(entry.size)}, over the ${formatBytes(maxBytes)} preview limit.`);
  }
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`This entry uses compression method ${entry.method}, which Mesa cannot preview.`);
  // Deflate adds at most a few bytes per 16 KiB block to incompressible data.
  if (entry.compressedSize > maxBytes + Math.ceil(maxBytes / 64) + 1024) {
    throw new Error("This entry's compressed data is larger than its preview limit allows.");
  }
  const at = entry.localHeaderOffset;
  const header = at + 30 <= source.size ? await source.read(at, 30) : new Uint8Array();
  if (header.length < 30 || u32(header, 0) !== 0x04034b50) {
    throw new Error("This entry's local header is missing or damaged.");
  }
  const start = at + 30 + u16(header, 26) + u16(header, 28);
  if (start + entry.compressedSize > source.size) throw new Error("This entry's data runs past the end of the archive.");
  const raw = await source.read(start, entry.compressedSize);
  if (entry.method === 0) {
    if (raw.length !== entry.size) throw new Error("This stored entry's sizes disagree.");
    return raw;
  }
  return inflateBounded(raw, entry.size);
}
