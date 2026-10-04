export interface TextReadHandle { read(buffer: Uint8Array): Promise<number | null>; close(): Promise<void> }
/** Require EOF within the byte limit; a prefix can never become editable authority. */
export async function readBoundedText(handle: TextReadHandle, maxBytes: number): Promise<string> {
  try {
    if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 8 * 1024 * 1024) throw new Error('Invalid text read limit');
    const buffer = new Uint8Array(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const read = await handle.read(buffer.subarray(filled));
      if (read === null || read === 0) return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, filled));
      if (!Number.isInteger(read) || read < 0 || read > buffer.length - filled) throw new Error('Invalid text read length');
      filled += read;
      if (filled > maxBytes) throw new Error('File exceeds the inline review limit. Open each copy to review it.');
    }
    throw new Error('File exceeds the inline review limit.');
  } finally { await handle.close(); }
}
