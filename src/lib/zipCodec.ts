import { unzip, type AsyncTerminable } from "fflate";

export const ZIP_IMPORT_LIMITS = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
} as const;

export interface ZipImportEntry {
  name: string;
  compressedBytes: number;
  expandedBytes: number;
}

/** One central-directory record, exactly as declared. Nothing is trusted yet. */
export interface ZipDirectoryRecord {
  name: string;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  compressedBytes: number;
  expandedBytes: number;
  /** Unix file type and mode from the upper 16 external-attribute bits. */
  unixMode: number;
  localHeaderOffset: number;
}

export interface ZipDirectory {
  /** Entry count the end record declares. */
  declaredEntries: number;
  /** At most the requested number of records, in directory order. */
  records: ZipDirectoryRecord[];
}

export function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

export function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x4000) out += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  return out;
}

const UTF8_NAMES = new TextDecoder("utf-8", { fatal: false });

/** Same rule as fflate's entry keys: UTF-8 only with general-purpose flag bit 11, else Latin-1. */
export function decodeZipEntryName(rawName: Uint8Array, flags: number): string {
  return flags & 0x0800 ? UTF8_NAMES.decode(rawName) : latin1(rawName);
}

/** The end-of-central-directory record, as declared. */
export interface ZipEnd {
  /** Offset of the end record inside the bytes searched. */
  eocd: number;
  entries: number;
  directoryBytes: number;
  directoryOffset: number;
}

/** Bytes from the end of an archive that always contain its end record. */
export const ZIP_END_SEARCH_BYTES = 0xffff + 22;

/** Finds the end record in `tail` (the last bytes of an archive, at most
 *  `ZIP_END_SEARCH_BYTES` needed). ZIP64 is refused: ordinary headers cannot
 *  bound its sizes. */
export function findZipEnd(tail: Uint8Array): ZipEnd {
  const minimumEocd = 22;
  const first = Math.max(0, tail.length - ZIP_END_SEARCH_BYTES);
  let eocd = -1;
  for (let at = tail.length - minimumEocd; at >= first; at--) {
    if (u32(tail, at) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error("ZIP archive has no supported central directory.");
  const end = { eocd, entries: u16(tail, eocd + 10), directoryBytes: u32(tail, eocd + 12), directoryOffset: u32(tail, eocd + 16) };
  if (end.entries === 0xffff || end.directoryBytes === 0xffffffff || end.directoryOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported.");
  }
  return end;
}

/**
 * Parses up to `maxEntries` records from `directory`, the central directory
 * starting at its first record. When `complete` is false the bytes are a
 * prefix and parsing stops cleanly at the first record that does not fit.
 * Every loop is bounded by the declared count, `maxEntries` and the bytes.
 */
export function parseZipCentralDirectory(directory: Uint8Array, entries: number, maxEntries: number, complete: boolean): ZipDirectoryRecord[] {
  const records: ZipDirectoryRecord[] = [];
  const count = Math.min(entries, maxEntries);
  const directoryEnd = directory.length;
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (!complete && (at + 46 > directoryEnd || at + 46 + u16(directory, at + 28) + u16(directory, at + 30) + u16(directory, at + 32) > directoryEnd)) break;
    if (at + 46 > directoryEnd || u32(directory, at) !== 0x02014b50) {
      throw new Error("ZIP central directory is malformed.");
    }
    const nameBytes = u16(directory, at + 28);
    const end = at + 46 + nameBytes + u16(directory, at + 30) + u16(directory, at + 32);
    if (end > directoryEnd) throw new Error("ZIP entry metadata is truncated.");
    const flags = u16(directory, at + 8);
    const rawName = directory.subarray(at + 46, at + 46 + nameBytes);
    records.push({
      name: decodeZipEntryName(rawName, flags),
      flags,
      method: u16(directory, at + 10),
      dosTime: u16(directory, at + 12),
      dosDate: u16(directory, at + 14),
      compressedBytes: u32(directory, at + 20),
      expandedBytes: u32(directory, at + 24),
      unixMode: u32(directory, at + 38) >>> 16,
      localHeaderOffset: u32(directory, at + 42),
    });
    at = end;
  }
  if (complete && count === entries && at !== directoryEnd) throw new Error("ZIP central directory has trailing malformed data.");
  return records;
}

/** Checks that the declared directory lies before the end record. */
export function zipDirectoryRange(end: ZipEnd, eocdOffset: number): { start: number; end: number } {
  const directoryEnd = end.directoryOffset + end.directoryBytes;
  if (!Number.isSafeInteger(directoryEnd) || directoryEnd > eocdOffset) {
    throw new Error("ZIP central directory is outside the archive.");
  }
  return { start: end.directoryOffset, end: directoryEnd };
}

/** Parses the end record and up to `maxEntries` records of an in-memory archive. */
export function readZipDirectory(data: Uint8Array, maxEntries: number): ZipDirectory {
  const end = findZipEnd(data);
  const range = zipDirectoryRange(end, end.eocd);
  const records = parseZipCentralDirectory(data.subarray(range.start, range.end), end.entries, maxEntries, true);
  return { declaredEntries: end.entries, records };
}

/** Unix symlink type bits. Extractors disagree about where a link member
 *  points, so it is never treated as ordinary bytes. */
export function isZipSymlink(record: Pick<ZipDirectoryRecord, "unixMode">): boolean {
  return (record.unixMode & 0o170000) === 0o120000;
}

/** Why a member name is unsafe to extract (empty, NUL, absolute, drive
 *  letter, `.` or `..` segment), or `null` when it is safe. */
export function unsafeZipPathReason(name: string): string | null {
  if (!name || name.includes("\0")) return "empty or NUL name";
  const normalizedName = name.replace(/\\/g, "/");
  if (normalizedName.startsWith("/") || /^[A-Za-z]:/.test(normalizedName)) return "absolute path";
  const segments = normalizedName.replace(/\/$/, "").split("/");
  if (segments.some((part) => part === "..")) return "climbs out of the archive";
  if (segments.some((part) => !part || part === ".")) return "malformed path";
  return null;
}

/**
 * Reads ZIP central-directory metadata before decompression. ZIP64 is rejected
 * because ordinary headers cannot bound its expansion; entry sizes come from the
 * central directory, so a local data descriptor never sets a budget.
 */
export function inspectZipForImport(data: Uint8Array): ZipImportEntry[] {
  if (data.byteLength > ZIP_IMPORT_LIMITS.maxArchiveBytes) {
    throw new Error(`ZIP archive exceeds the ${ZIP_IMPORT_LIMITS.maxArchiveBytes / 1024 / 1024} MiB import limit.`);
  }
  const { declaredEntries, records } = readZipDirectory(data, ZIP_IMPORT_LIMITS.maxEntries);
  if (declaredEntries > ZIP_IMPORT_LIMITS.maxEntries) {
    throw new Error(`ZIP archive has ${declaredEntries.toLocaleString()} entries; Mesa imports at most ${ZIP_IMPORT_LIMITS.maxEntries.toLocaleString()} at once.`);
  }
  const result: ZipImportEntry[] = [];
  let expanded = 0;
  for (const record of records) {
    const { name, compressedBytes, expandedBytes } = record;
    if (isZipSymlink(record)) {
      throw new Error(`ZIP entry is a symbolic link and cannot be imported: ${name}.`);
    }
    if (unsafeZipPathReason(name)) {
      throw new Error(`ZIP entry has an unsafe path: ${name || "(empty)"}.`);
    }
    if (expandedBytes > ZIP_IMPORT_LIMITS.maxEntryBytes) {
      throw new Error(`ZIP entry ${name} exceeds the ${ZIP_IMPORT_LIMITS.maxEntryBytes / 1024 / 1024} MiB per-file limit.`);
    }
    expanded += expandedBytes;
    if (expanded > ZIP_IMPORT_LIMITS.maxExpandedBytes) {
      throw new Error(`ZIP archive expands beyond Mesa's ${ZIP_IMPORT_LIMITS.maxExpandedBytes / 1024 / 1024} MiB import limit.`);
    }
    result.push({ name, compressedBytes, expandedBytes });
  }
  return result;
}

/** Decode off the renderer's synchronous call stack; fflate uses workers. */
export function unzipForImport(data: Uint8Array, signal?: AbortSignal): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // eslint-disable-next-line prefer-const -- abort is registered before the worker exists and calls this later-assigned handle
    let terminate: AsyncTerminable | undefined;
    const abort = () => {
      terminate?.();
      finish(() => reject(new DOMException("ZIP import cancelled.", "AbortError")));
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      fn();
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    terminate = unzip(data, (error, entries) => finish(() => error ? reject(error) : resolve(entries)));
  });
}
