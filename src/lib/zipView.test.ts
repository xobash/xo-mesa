import { describe, expect, it } from "vitest";
import { deflateSync, zipSync } from "fflate";
import { ByteSource, memoryRangeReader, type RangeReader } from "./byteSource";
import { ZIP_VIEW_LIMITS, dosDateTime, listZipArchive, readZipEntry } from "./zipView";

const source = (data: Uint8Array) => ByteSource.open(memoryRangeReader(data));

const text = (value: string) => new TextEncoder().encode(value);

interface RawEntry { name: string; data: Uint8Array; method?: 0 | 8; declaredSize?: number; flags?: number; unixMode?: number }

/** Builds an archive by hand so tests can lie about sizes and names. */
function buildZip(entries: RawEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = text(entry.name);
    const method = entry.method ?? 0;
    const body = method === 8 ? deflateSync(entry.data) : entry.data;
    const size = entry.declaredSize ?? entry.data.length;
    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(6, entry.flags ?? 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, entry.flags ?? 0, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, (13 << 11) | (45 << 5) | 15, true);
    cv.setUint16(14, ((2024 - 1980) << 9) | (3 << 5) | 9, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, (entry.unixMode ?? 0) * 0x1_0000, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directorySize = centrals.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(offset + directorySize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals]) { out.set(part, at); at += part.length; }
  const ev = new DataView(out.buffer);
  ev.setUint32(at, 0x06054b50, true);
  ev.setUint16(at + 8, entries.length, true);
  ev.setUint16(at + 10, entries.length, true);
  ev.setUint32(at + 12, directorySize, true);
  ev.setUint32(at + 16, offset, true);
  return out;
}

/** A stored archive whose first entry is `padding` virtual zero bytes, so a
 *  multi-GB file is served without allocating it. */
function virtualArchive(padding: number): { reader: RangeReader; size: number } {
  const local = (name: Uint8Array, size: number) => {
    const out = new Uint8Array(30 + name.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint32(18, size, true);
    v.setUint32(22, size, true);
    v.setUint16(26, name.length, true);
    out.set(name, 30);
    return out;
  };
  const central = (name: Uint8Array, size: number, offset: number) => {
    const out = new Uint8Array(46 + name.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint32(20, size, true);
    v.setUint32(24, size, true);
    v.setUint16(28, name.length, true);
    v.setUint32(42, offset, true);
    out.set(name, 46);
    return out;
  };
  const hugeName = text("huge.bin");
  const smallName = text("a.txt");
  const head = local(hugeName, padding);
  const secondOffset = head.length + padding;
  const second = new Uint8Array([...local(smallName, 5), ...text("hello")]);
  const directory = new Uint8Array([...central(hugeName, padding, 0), ...central(smallName, 5, secondOffset)]);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 2, true);
  ev.setUint16(10, 2, true);
  ev.setUint32(12, directory.length, true);
  ev.setUint32(16, secondOffset + second.length, true);
  const segments: Array<{ at: number; bytes: Uint8Array | null; len: number }> = [];
  let at = 0;
  for (const part of [head, null, second, directory, eocd]) {
    const len = part ? part.length : padding;
    segments.push({ at, bytes: part, len });
    at += len;
  }
  const size = at;
  const reader: RangeReader = async (offset, len) => {
    const end = Math.min(size, offset + len);
    const out = new Uint8Array(Math.max(0, end - offset));
    for (const seg of segments) {
      const from = Math.max(offset, seg.at);
      const to = Math.min(end, seg.at + seg.len);
      if (from < to && seg.bytes) out.set(seg.bytes.subarray(from - seg.at, to - seg.at), from - offset);
    }
    return { bytes: out, size, stamp: "v1" };
  };
  return { reader, size };
}

describe("ZIP viewer listing", () => {
  it("lists path, size, compressed size and date from the central directory", async () => {
    const listing = await listZipArchive(await source(buildZip([
      { name: "docs/", data: new Uint8Array() },
      { name: "docs/readme.txt", data: text("hello archive ".repeat(20)), method: 8 },
    ])));
    expect(listing.declaredEntries).toBe(2);
    expect(listing.entries[0].directory).toBe(true);
    const file = listing.entries[1];
    expect(file).toMatchObject({ name: "docs/readme.txt", size: 280, directory: false, unsafe: null });
    expect(file.compressedSize).toBeLessThan(file.size);
    expect(file.modified?.getFullYear()).toBe(2024);
    expect(file.modified?.getMonth()).toBe(2);
  });

  it("shows traversal, absolute and link names flagged instead of refusing the archive", async () => {
    const listing = await listZipArchive(await source(buildZip([
      { name: "../../escape.sh", data: text("x") },
      { name: "/etc/passwd", data: text("x") },
      { name: "C:/Windows/evil.dll", data: text("x") },
      { name: "link", data: text("/etc"), unixMode: 0o120777 },
      { name: "ok.txt", data: text("x") },
    ])));
    expect(listing.entries.map((e) => e.unsafe)).toEqual([
      "climbs out of the archive", "absolute path", "absolute path", "symbolic link", null,
    ]);
  });

  it("previews stored and deflated text entries in memory", async () => {
    const data = buildZip([
      { name: "a.txt", data: text("stored text") },
      { name: "b.md", data: text("# deflated\n".repeat(50)), method: 8 },
    ]);
    const [a, b] = (await listZipArchive(await source(data))).entries;
    expect(new TextDecoder().decode(await readZipEntry(await source(data), a))).toBe("stored text");
    expect(new TextDecoder().decode(await readZipEntry(await source(data), b))).toBe("# deflated\n".repeat(50));
  });

  it("refuses an entry that expands beyond its declared size (ZIP bomb)", async () => {
    const data = buildZip([{ name: "bomb.txt", data: new Uint8Array(4 * 1024 * 1024), method: 8, declaredSize: 100 }]);
    const [bomb] = (await listZipArchive(await source(data))).entries;
    await expect(readZipEntry(await source(data), bomb)).rejects.toThrow(/ZIP bomb/);
  });

  it("refuses entries declared over the preview limit before decoding", async () => {
    const data = buildZip([{ name: "big.bin", data: text("x"), declaredSize: ZIP_VIEW_LIMITS.maxPreviewBytes + 1 }]);
    const [big] = (await listZipArchive(await source(data))).entries;
    await expect(readZipEntry(await source(data), big)).rejects.toThrow(/preview limit/);
  });

  it("refuses encrypted entries and damaged data offsets", async () => {
    const data = buildZip([{ name: "secret.txt", data: text("x"), flags: 1 }]);
    const [secret] = (await listZipArchive(await source(data))).entries;
    await expect(readZipEntry(await source(data), secret)).rejects.toThrow(/encrypted/);
    const plain = buildZip([{ name: "a.txt", data: text("abc") }]);
    const [a] = (await listZipArchive(await source(plain))).entries;
    await expect(readZipEntry(await source(plain), { ...a, localHeaderOffset: 5 })).rejects.toThrow(/local header/);
    await expect(readZipEntry(await source(plain), { ...a, compressedSize: 1_000_000, size: 3 })).rejects.toThrow(/past the end/);
  });

  it("lists at most the entry limit and says it is partial", async () => {
    const names: Record<string, Uint8Array> = {};
    for (let i = 0; i <= ZIP_VIEW_LIMITS.maxListedEntries; i++) names[`f${i}`] = new Uint8Array();
    const listing = await listZipArchive(await source(zipSync(names, { level: 0 })));
    expect(listing.entries).toHaveLength(ZIP_VIEW_LIMITS.maxListedEntries);
    expect(listing.declaredEntries).toBe(ZIP_VIEW_LIMITS.maxListedEntries + 1);
    expect(listing.truncated).toBe(true);
  });

  it("refuses ZIP64", async () => {
    const zip64 = buildZip([{ name: "a", data: text("a") }]);
    new DataView(zip64.buffer).setUint16(zip64.length - 22 + 10, 0xffff, true);
    await expect(listZipArchive(await source(zip64))).rejects.toThrow(/ZIP64/);
  });

  it("lists and previews an archive far over 64 MiB by reading only its end and directory", async () => {
    const padding = 3 * 1024 ** 3;
    const { reader, size } = virtualArchive(padding);
    const calls: Array<[number, number]> = [];
    const counted: RangeReader = (offset, len) => { calls.push([offset, len]); return reader(offset, len); };
    const archive = await ByteSource.open(counted);
    const listing = await listZipArchive(archive);
    expect(listing.entries.map((e) => [e.name, e.size])).toEqual([["huge.bin", padding], ["a.txt", 5]]);
    expect(new TextDecoder().decode(await readZipEntry(archive, listing.entries[1]))).toBe("hello");
    expect(Math.max(...calls.map(([, len]) => len))).toBeLessThanOrEqual(1024 * 1024);
    expect(calls.reduce((n, [, len]) => n + len, 0)).toBeLessThan(80 * 1024);
    expect(size).toBeGreaterThan(padding);
  });

  it("rejects impossible DOS dates", async () => {
    expect(dosDateTime(0, 0)).toBeNull();
  });
});
