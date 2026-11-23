/** Bounded slices of one file version. No file access happens here: callers
 *  pass a `RangeReader` (native `vault_read_range`, or memory). */

import { formatBytes } from "./formatBytes";

/** Largest slice one native call returns (`vault_read_range`). */
export const RANGE_READ_MAX_BYTES = 1024 * 1024;
/** Largest single `ByteSource.read`; bounds its call loop. */
export const SOURCE_READ_MAX_BYTES = 64 * 1024 * 1024;

export interface RangeRead {
  bytes: Uint8Array;
  /** File size when this slice was read. */
  size: number;
  /** Changes whenever the file changes (size and modification time). */
  stamp: string;
}

export type RangeReader = (offset: number, len: number) => Promise<RangeRead>;

export class FileChangedError extends Error {
  constructor() {
    super("This file changed on disk while Mesa was reading it. Reopen it to see the current version.");
    this.name = "FileChangedError";
  }
}

export function assertRange(offset: number, len: number, maxLen: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(len) || offset < 0 || len < 0) {
    throw new Error("Invalid byte range.");
  }
  if (len > maxLen) throw new Error(`A single read is limited to ${formatBytes(maxLen)}.`);
}

/** Reads an in-memory file the way the native range read does. */
export function memoryRangeReader(data: Uint8Array, stamp = "memory"): RangeReader {
  return async (offset, len) => {
    assertRange(offset, len, RANGE_READ_MAX_BYTES);
    if (offset > data.length) throw new Error("offset is past the end of the file");
    return { bytes: data.subarray(offset, offset + len), size: data.length, stamp };
  };
}

/**
 * Random access pinned to the file version seen at `open`. A later slice from
 * another version throws `FileChangedError`, so one parse never mixes versions.
 */
export class ByteSource {
  private constructor(private readonly reader: RangeReader, readonly size: number, readonly stamp: string) {}

  static async open(reader: RangeReader): Promise<ByteSource> {
    const first = await reader(0, 0);
    return new ByteSource(reader, first.size, first.stamp);
  }

  /** `[offset, offset + len)` clipped to the file, in native-sized calls. */
  async read(offset: number, len: number): Promise<Uint8Array> {
    assertRange(offset, len, SOURCE_READ_MAX_BYTES);
    if (offset > this.size) throw new Error("This read starts past the end of the file.");
    const end = Math.min(this.size, offset + len);
    const out = new Uint8Array(end - offset);
    let at = offset;
    const maxCalls = Math.ceil(SOURCE_READ_MAX_BYTES / RANGE_READ_MAX_BYTES);
    for (let call = 0; at < end && call < maxCalls; call++) {
      const got = await this.reader(at, Math.min(RANGE_READ_MAX_BYTES, end - at));
      if (got.stamp !== this.stamp || got.size !== this.size) throw new FileChangedError();
      if (got.bytes.length === 0) break;
      out.set(got.bytes.subarray(0, end - at), at - offset);
      at += got.bytes.length;
    }
    if (at < end) throw new FileChangedError();
    return out;
  }
}
