import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { inspectZipForImport, unzipForImport, ZIP_IMPORT_LIMITS } from "./zipCodec";

function centralDirectory(names: Array<{ name: string; expanded?: number; symlink?: boolean }>): Uint8Array {
  const encoder = new TextEncoder();
  const entries = names.map(({ name, expanded = 1, symlink = false }) => {
    const nameBytes = encoder.encode(name);
    const entry = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(entry.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint32(20, 1, true);
    view.setUint32(24, expanded, true);
    view.setUint16(28, nameBytes.length, true);
    if (symlink) view.setUint32(38, 0o120777 * 0x1_0000, true);
    entry.set(nameBytes, 46);
    return entry;
  });
  const size = entries.reduce((total, entry) => total + entry.length, 0);
  const out = new Uint8Array(size + 22);
  let at = 0;
  for (const entry of entries) { out.set(entry, at); at += entry.length; }
  const view = new DataView(out.buffer);
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, size, true);
  view.setUint32(at + 16, 0, true);
  return out;
}

describe("ZIP import preflight", () => {
  it("accepts bounded ordinary entries before decoding", () => {
    expect(inspectZipForImport(centralDirectory([{ name: "notes/a.md", expanded: 12 }]))).toEqual([
      { name: "notes/a.md", compressedBytes: 1, expandedBytes: 12 },
    ]);
  });

  it("rejects traversal before decompression", () => {
    expect(() => inspectZipForImport(centralDirectory([{ name: "../escape.md" }]))).toThrow("unsafe path");
  });

  it("rejects a declared expansion bomb before decompression", () => {
    expect(() => inspectZipForImport(centralDirectory([{
      name: "huge.md", expanded: ZIP_IMPORT_LIMITS.maxEntryBytes + 1,
    }]))).toThrow("per-file limit");
  });

  it("rejects symbolic-link entries before decoding", () => {
    expect(() => inspectZipForImport(centralDirectory([{ name: "linked.md", symlink: true }])))
      .toThrow("symbolic link");
  });

  it("decodes a preflighted archive asynchronously", async () => {
    const archive = zipSync({ "notes/a.md": new TextEncoder().encode("safe import") });
    expect(inspectZipForImport(archive)).toHaveLength(1);
    await expect(unzipForImport(archive)).resolves.toMatchObject({
      "notes/a.md": new TextEncoder().encode("safe import"),
    });
  });

  it("honors cancellation before a worker-backed decode starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const archive = zipSync({ "notes/a.md": new TextEncoder().encode("safe import") });
    await expect(unzipForImport(archive, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("ZIP entry name encoding", () => {
  it("reads a Latin-1 name the way fflate keys the decoded entry when flag bit 11 is clear", async () => {
    // Windows' built-in compressor writes code-page names without the UTF-8 flag.
    const archive = zipSync({ "cafe.md": new TextEncoder().encode("hi") }, { level: 0 });
    const name = new TextEncoder().encode("cafe.md");
    for (let at = 0; at + name.length <= archive.length; at++) {
      if (name.every((byte, k) => archive[at + k] === byte)) archive[at + 3] = 0xe9;
    }
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const central = archive.findIndex((_, at) => view.getUint32(at, true) === 0x02014b50);
    expect(view.getUint16(central + 8, true) & 0x0800).toBe(0);
    const [entry] = inspectZipForImport(archive);
    expect(entry.name).toBe("café.md");
    const entries = await unzipForImport(archive);
    expect(Object.keys(entries)).toEqual([entry.name]);
  });

  it("reads UTF-8 names when flag bit 11 is set", () => {
    const archive = zipSync({ "café.md": new TextEncoder().encode("hi") });
    expect(inspectZipForImport(archive)[0].name).toBe("café.md");
  });
});
