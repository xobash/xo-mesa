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

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/**
 * Reads ZIP central-directory metadata before decompression. ZIP64 and data
 * descriptors are intentionally rejected here: their widened/streamed fields
 * cannot prove the configured expansion budget from the ordinary header.
 */
export function inspectZipForImport(data: Uint8Array): ZipImportEntry[] {
  if (data.byteLength > ZIP_IMPORT_LIMITS.maxArchiveBytes) {
    throw new Error(`ZIP archive exceeds the ${ZIP_IMPORT_LIMITS.maxArchiveBytes / 1024 / 1024} MB import limit.`);
  }
  const minimumEocd = 22;
  const first = Math.max(0, data.length - 0xffff - minimumEocd);
  let eocd = -1;
  for (let at = data.length - minimumEocd; at >= first; at--) {
    if (u32(data, at) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error("ZIP archive has no supported central directory.");
  const entries = u16(data, eocd + 10);
  const directoryBytes = u32(data, eocd + 12);
  const directoryOffset = u32(data, eocd + 16);
  if (entries === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported for import.");
  }
  if (entries > ZIP_IMPORT_LIMITS.maxEntries) {
    throw new Error(`ZIP archive has ${entries.toLocaleString()} entries; Mesa imports at most ${ZIP_IMPORT_LIMITS.maxEntries.toLocaleString()} at once.`);
  }
  const directoryEnd = directoryOffset + directoryBytes;
  if (!Number.isSafeInteger(directoryEnd) || directoryEnd > eocd) {
    throw new Error("ZIP central directory is outside the archive.");
  }
  const decode = new TextDecoder("utf-8", { fatal: false });
  const result: ZipImportEntry[] = [];
  let expanded = 0;
  let at = directoryOffset;
  for (let index = 0; index < entries; index++) {
    if (at + 46 > directoryEnd || u32(data, at) !== 0x02014b50) {
      throw new Error("ZIP central directory is malformed.");
    }
    const compressedBytes = u32(data, at + 20);
    const expandedBytes = u32(data, at + 24);
    const nameBytes = u16(data, at + 28);
    const extraBytes = u16(data, at + 30);
    const commentBytes = u16(data, at + 32);
    const end = at + 46 + nameBytes + extraBytes + commentBytes;
    if (end > directoryEnd) throw new Error("ZIP entry metadata is truncated.");
    const name = decode.decode(data.subarray(at + 46, at + 46 + nameBytes));
    // Unix file type is stored in the upper 16 bits of the external
    // attributes. A symlink archive member must never be treated as ordinary
    // bytes: different extractors disagree about where it points.
    const unixMode = u32(data, at + 38) >>> 16;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new Error(`ZIP entry is a symbolic link and cannot be imported: ${name}.`);
    }
    const normalizedName = name.replace(/\\/g, "/");
    const segments = normalizedName.replace(/\/$/, "").split("/");
    if (!name || name.includes("\0") || segments.some((part) => !part || part === "." || part === "..")) {
      throw new Error(`ZIP entry has an unsafe path: ${name || "(empty)"}.`);
    }
    if (expandedBytes > ZIP_IMPORT_LIMITS.maxEntryBytes) {
      throw new Error(`ZIP entry ${name} exceeds the ${ZIP_IMPORT_LIMITS.maxEntryBytes / 1024 / 1024} MB per-file limit.`);
    }
    expanded += expandedBytes;
    if (expanded > ZIP_IMPORT_LIMITS.maxExpandedBytes) {
      throw new Error(`ZIP archive expands beyond Mesa's ${ZIP_IMPORT_LIMITS.maxExpandedBytes / 1024 / 1024} MB import limit.`);
    }
    result.push({ name, compressedBytes, expandedBytes });
    at = end;
  }
  if (at !== directoryEnd) throw new Error("ZIP central directory has trailing malformed data.");
  return result;
}

/** Decode off the renderer's synchronous call stack; fflate uses workers. */
export function unzipForImport(data: Uint8Array, signal?: AbortSignal): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false;
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
