import { describe, expect, it } from "vitest";
import { CfbError, isCfb, readCfb, writeCfb } from "./cfb";

const same = (a: Uint8Array | null, b: Uint8Array) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);
const bytesOf = (length: number, seed: number) => Uint8Array.from({ length }, (_, i) => (i * seed + 3) & 0xff);

const SAMPLE = [
  { path: "EncryptionInfo", bytes: bytesOf(300, 7) },
  { path: "EncryptedPackage", bytes: bytesOf(9000, 13) },
  { path: "\u0006DataSpaces/Version", bytes: bytesOf(76, 3) },
  { path: "\u0006DataSpaces/DataSpaceMap", bytes: bytesOf(112, 5) },
  { path: "\u0006DataSpaces/DataSpaceInfo/StrongEncryptionDataSpace", bytes: bytesOf(64, 9) },
  { path: "\u0006DataSpaces/TransformInfo/StrongEncryptionTransform/\u0006Primary", bytes: bytesOf(200, 11) },
  { path: "Empty", bytes: new Uint8Array(0) },
  { path: "Exactly4096", bytes: bytesOf(4096, 17) },
];

function u32(bytes: Uint8Array, at: number, value: number) {
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(at, value, true);
}
const sector = (n: number) => (n + 1) * 512;

describe("compound file writer and reader", () => {
  it("round-trips nested storages, mini and regular streams byte-for-byte", () => {
    const file = writeCfb(SAMPLE);
    expect(isCfb(file)).toBe(true);
    const cfb = readCfb(file);
    expect(cfb.streams.map((s) => s.path).sort()).toEqual(SAMPLE.map((s) => s.path).sort());
    for (const s of SAMPLE) expect(cfb.read(s.path)).toEqual(s.bytes);
    expect(cfb.read("encryptionINFO")).toEqual(SAMPLE[0].bytes);
    expect(cfb.read("Missing")).toBeNull();
  });

  it("writes a DIFAT when the FAT needs more than 109 sectors", () => {
    const big = bytesOf(8 * 1024 * 1024, 29);
    const file = writeCfb([{ path: "Big", bytes: big }, { path: "Small", bytes: bytesOf(10, 1) }]);
    const view = new DataView(file.buffer);
    expect(view.getUint32(72, true)).toBeGreaterThan(0); // DIFAT sector count
    const cfb = readCfb(file);
    expect(same(cfb.read("Big"), big)).toBe(true);
    expect(cfb.read("Small")).toEqual(bytesOf(10, 1));
  });

  it("orders siblings as a binary search tree by MS-CFB name order", () => {
    const names = ["b", "A", "ccc", "Bb", "a1", "zz", "Q", "dddd", "e", "ff"];
    const file = writeCfb(names.map((n, i) => ({ path: n, bytes: bytesOf(5, i + 1) })));
    const cfb = readCfb(file);
    for (const [i, n] of names.entries()) expect(cfb.read(n)).toEqual(bytesOf(5, i + 1));
    // In-order walk of the root's tree must be sorted: shorter names first, then upper-case order.
    const view = new DataView(file.buffer);
    const dir = sector(view.getUint32(48, true));
    const entry = (i: number) => {
      const at = dir + i * 128;
      const len = view.getUint16(at + 64, true) / 2 - 1;
      let name = "";
      for (let c = 0; c < len; c++) name += String.fromCharCode(view.getUint16(at + c * 2, true));
      return { name, left: view.getUint32(at + 68, true), right: view.getUint32(at + 72, true), child: view.getUint32(at + 76, true) };
    };
    const order: string[] = [];
    const stack: number[] = [];
    let node = entry(0).child;
    while (stack.length || node !== 0xffffffff) {
      if (node !== 0xffffffff) { stack.push(node); node = entry(node).left; continue; }
      const top = stack.pop()!;
      order.push(entry(top).name);
      node = entry(top).right;
    }
    const sorted = [...names].sort((a, b) => a.length - b.length || (a.toUpperCase() < b.toUpperCase() ? -1 : 1));
    expect(order).toEqual(sorted);
  });

  it("refuses duplicate paths, invalid names and a stream used as a storage", () => {
    expect(() => writeCfb([{ path: "A", bytes: new Uint8Array(1) }, { path: "a", bytes: new Uint8Array(1) }])).toThrow(CfbError);
    expect(() => writeCfb([{ path: "A", bytes: new Uint8Array(1) }, { path: "A/B", bytes: new Uint8Array(1) }])).toThrow(CfbError);
    expect(() => writeCfb([{ path: "x".repeat(32), bytes: new Uint8Array(1) }])).toThrow(CfbError);
    expect(() => writeCfb([{ path: "a:b", bytes: new Uint8Array(1) }])).toThrow(CfbError);
  });
});

describe("hostile compound files", () => {
  const base = () => writeCfb([{ path: "Big", bytes: bytesOf(5000, 3) }, { path: "Small", bytes: bytesOf(100, 5) }]);
  const fatAt = (file: Uint8Array) => sector(new DataView(file.buffer).getUint32(76, true));
  const dirAt = (file: Uint8Array) => sector(new DataView(file.buffer).getUint32(48, true));
  const firstBigSector = (file: Uint8Array) => {
    const cfb = readCfb(file);
    expect(cfb.read("Big")).not.toBeNull();
    // Directory entry 1 or 2 is "Big"; find by name length 3.
    const view = new DataView(file.buffer);
    for (let i = 1; i < 4; i++) if (view.getUint16(dirAt(file) + i * 128 + 64, true) === 8) return view.getUint32(dirAt(file) + i * 128 + 116, true);
    throw new Error("no Big entry");
  };

  it("refuses a FAT chain that loops", () => {
    const file = base();
    const start = firstBigSector(file);
    u32(file, fatAt(file) + (start + 1) * 4, start);
    expect(() => readCfb(file).read("Big")).toThrow(/loops/);
  });

  it("refuses a chain that points outside the file", () => {
    const file = base();
    const start = firstBigSector(file);
    u32(file, fatAt(file) + start * 4, 0x00ffffff);
    expect(() => readCfb(file).read("Big")).toThrow(/outside/);
  });

  it("refuses a directory tree that loops", () => {
    const file = base();
    const root = dirAt(file);
    const child = new DataView(file.buffer).getUint32(root + 76, true);
    u32(file, root + child * 128 + 68, child);
    expect(() => readCfb(file)).toThrow(/loops/);
  });

  it("refuses a stream larger than the file, a bad header and truncation", () => {
    const file = base();
    const start = firstBigSector(file);
    expect(start).toBeGreaterThan(0);
    for (let i = 1; i < 4; i++) {
      const at = dirAt(file) + i * 128;
      if (new DataView(file.buffer).getUint16(at + 64, true) === 8) u32(file, at + 120, 0x7fffffff);
    }
    expect(() => readCfb(file).read("Big")).toThrow(CfbError);
    const badOrder = base();
    badOrder[28] = 0;
    expect(() => readCfb(badOrder)).toThrow(/byte order/);
    expect(() => readCfb(base().subarray(0, 300))).toThrow(/truncated/);
    expect(() => readCfb(new Uint8Array(600))).toThrow(/not a compound file/);
    const lying = base();
    u32(lying, 44, 1_000_000);
    expect(() => readCfb(lying)).toThrow(/more FAT sectors/);
  });

  it("refuses names with path separators", () => {
    const file = base();
    const root = dirAt(file);
    const child = new DataView(file.buffer).getUint32(root + 76, true);
    new DataView(file.buffer).setUint16(root + child * 128, 0x2f, true);
    expect(() => readCfb(file)).toThrow(/invalid name/);
  });
});
