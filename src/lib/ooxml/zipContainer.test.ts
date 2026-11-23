import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { buildPackage, buildStreamedPackage, docxParts } from "./fixtures/ooxmlFixtures";
import { crc32 } from "./crc32";
import {
  OOXML_PACKAGE_LIMITS,
  OoxmlPackageError,
  readEntryBytes,
  readZipContainer,
  writeZipContainer,
  type ZipContainer,
} from "./zipContainer";

function localRecord(container: ZipContainer, name: string): Uint8Array {
  const entry = container.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`missing ${name}`);
  return container.bytes.subarray(entry.localStart, entry.localEnd);
}

function centralWithoutOffset(container: ZipContainer, name: string): Uint8Array {
  const entry = container.entries.find((e) => e.name === name)!;
  const copy = container.bytes.slice(entry.centralStart, entry.centralEnd);
  copy.fill(0, 42, 46);
  return copy;
}

function refusal(bytes: Uint8Array): string {
  try {
    const container = readZipContainer(bytes);
    for (const entry of container.entries) readEntryBytes(container, entry);
  } catch (error) {
    if (error instanceof OoxmlPackageError) return error.code;
    throw error;
  }
  return "accepted";
}

/** Writes `value` at `field` offset of both the local and central header of `name`. */
function patchBoth(bytes: Uint8Array, name: string, localField: number, centralField: number, value: number, width: 2 | 4): Uint8Array {
  const container = readZipContainer(bytes);
  const entry = container.entries.find((e) => e.name === name)!;
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  const set = (at: number) => (width === 2 ? view.setUint16(at, value, true) : view.setUint32(at, value, true));
  set(entry.localStart + localField);
  set(entry.centralStart + centralField);
  return out;
}

const SAMPLE = docxParts();

describe("OOXML ZIP container", () => {
  it("returns the original bytes for a save without edits", () => {
    const bytes = buildPackage(SAMPLE, { comment: "kept" });
    const container = readZipContainer(bytes);
    expect(writeZipContainer(container, new Map())).toBe(bytes);
  });

  it("re-encodes only the changed entry and copies every other record byte-for-byte", () => {
    const bytes = buildPackage(SAMPLE, { comment: "archive comment" });
    const before = readZipContainer(bytes);
    const replacement = strToU8("<changed/>");
    const saved = writeZipContainer(before, new Map([["word/document.xml", replacement]]));
    const after = readZipContainer(saved);
    expect(after.entries.map((e) => e.name)).toEqual(before.entries.map((e) => e.name));
    for (const entry of before.entries) {
      if (entry.name === "word/document.xml") continue;
      expect(localRecord(after, entry.name)).toEqual(localRecord(before, entry.name));
      expect(centralWithoutOffset(after, entry.name)).toEqual(centralWithoutOffset(before, entry.name));
    }
    const changed = after.entries.find((e) => e.name === "word/document.xml")!;
    expect(readEntryBytes(after, changed)).toEqual(replacement);
    // Timestamp and the archive comment survive.
    const original = before.entries.find((e) => e.name === "word/document.xml")!;
    expect(saved.subarray(changed.localStart + 10, changed.localStart + 14)).toEqual(bytes.subarray(original.localStart + 10, original.localStart + 14));
    expect(new TextDecoder().decode(saved.subarray(saved.length - 15))).toBe("archive comment");
    expect(unzipSync(saved)["word/document.xml"]).toEqual(replacement);
  });

  it("copies data-descriptor and stored entries verbatim and writes a readable archive", () => {
    const parts = { ...SAMPLE, "word/media/image1.png": new Uint8Array([137, 80, 78, 71, 1, 2, 3]) };
    const bytes = buildStreamedPackage(parts);
    const before = readZipContainer(bytes);
    expect(before.entries.every((e) => (e.flags & 0x0008) !== 0)).toBe(true);
    const saved = writeZipContainer(before, new Map([["docProps/core.xml", strToU8("<x/>")]]));
    const after = readZipContainer(saved);
    expect(localRecord(after, "word/media/image1.png")).toEqual(localRecord(before, "word/media/image1.png"));
    expect(localRecord(after, "word/document.xml")).toEqual(localRecord(before, "word/document.xml"));
    expect(after.entries.find((e) => e.name === "docProps/core.xml")!.flags & 0x0008).toBe(0);
    const decoded = unzipSync(saved);
    expect(decoded["word/media/image1.png"]).toEqual(parts["word/media/image1.png"]);
  });

  it("entries added to an empty archive get a valid version and DOS date", () => {
    const empty = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);
    const saved = writeZipContainer(readZipContainer(empty), new Map([["a.xml", strToU8("<a/>")]]));
    const entry = readZipContainer(saved).entries[0];
    const view = new DataView(saved.buffer, saved.byteOffset);
    for (const at of [entry.localStart + 4, entry.centralStart + 4, entry.centralStart + 6]) expect(view.getUint16(at, true)).toBe(20);
    for (const at of [entry.localStart + 12, entry.centralStart + 14]) expect(view.getUint16(at, true)).toBe(0x21);
    expect(strFromU8(unzipSync(saved)["a.xml"])).toBe("<a/>");
  });

  it("removes and appends entries without disturbing the rest", () => {
    const bytes = buildPackage(SAMPLE, { stored: ["docProps/core.xml"] });
    const before = readZipContainer(bytes);
    const saved = writeZipContainer(before, new Map<string, Uint8Array | null>([["docProps/core.xml", null], ["word/média.xml", strToU8("<m/>")]]));
    const after = readZipContainer(saved);
    expect(after.entries.map((e) => e.name)).toEqual([...before.entries.map((e) => e.name).filter((n) => n !== "docProps/core.xml"), "word/média.xml"]);
    expect(localRecord(after, "word/document.xml")).toEqual(localRecord(before, "word/document.xml"));
    expect(readEntryBytes(after, after.entries.at(-1)!)).toEqual(strToU8("<m/>"));
  });

  it("refuses edits that would create case-only duplicates or unsafe names", () => {
    const container = readZipContainer(buildPackage(SAMPLE));
    expect(() => writeZipContainer(container, new Map([["WORD/document.xml", strToU8("x")]]))).toThrow(/differs only in case/);
    expect(() => writeZipContainer(container, new Map([["../evil.xml", strToU8("x")]]))).toThrow(/unsafe entry name/);
  });

  it("computes the standard CRC-32", () => {
    expect(crc32(strToU8("123456789"))).toBe(0xcbf43926);
  });
});

describe("OOXML ZIP container refusals", () => {
  const valid = buildPackage(SAMPLE);

  it("refuses OLE compound files (encrypted or legacy Office)", () => {
    const cfb = new Uint8Array(512);
    cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(refusal(cfb)).toBe("encrypted");
  });

  it("refuses non-ZIP input", () => {
    expect(refusal(strToU8("plain text that is long enough to scan"))).toBe("notZip");
  });

  it("refuses traversal, backslash and absolute names", () => {
    for (const name of ["../x.xml", "a\\b.xml", "/abs.xml", "a//b.xml", "a/./b.xml"]) {
      expect(refusal(zipSync({ [name]: strToU8("x"), "[Content_Types].xml": strToU8("<T/>") }))).toBe("unsafePath");
    }
  });

  it("refuses names that differ only in case", () => {
    const bytes = zipSync({ "a.xml": strToU8("1"), "b.xml": strToU8("2") });
    const container = readZipContainer(bytes);
    const b = container.entries.find((e) => e.name === "b.xml")!;
    const patched = bytes.slice();
    patched[b.localStart + 30] = 0x41; // "A.xml"
    patched[b.centralStart + 46] = 0x41;
    expect(refusal(patched)).toBe("duplicateName");
  });

  it("refuses encrypted entries, unknown compression and symbolic links", () => {
    expect(refusal(patchBoth(valid, "word/document.xml", 6, 8, 0x0001, 2))).toBe("encryptedEntry");
    expect(refusal(patchBoth(valid, "word/document.xml", 8, 10, 12, 2))).toBe("unsupportedCompression");
    const container = readZipContainer(valid);
    const entry = container.entries[0];
    const link = valid.slice();
    new DataView(link.buffer).setUint32(entry.centralStart + 38, 0o120777 * 0x10000, true);
    expect(refusal(link)).toBe("symlink");
  });

  it("refuses a high-ratio entry before decompression", () => {
    const bomb = zipSync({ "[Content_Types].xml": new Uint8Array(4 * 1024 * 1024) });
    expect(refusal(bomb)).toBe("zipBomb");
  });

  it("stops inflating at the declared size when the header lies", () => {
    const parts = { "big.xml": strToU8("<a>".repeat(20_000)) };
    const bytes = zipSync(parts);
    const lie = patchBoth(bytes, "big.xml", 22, 24, 10, 4);
    expect(refusal(lie)).toBe("zipBomb");
  });

  it("refuses a corrupted checksum", () => {
    expect(refusal(patchBoth(valid, "word/document.xml", 14, 16, 0x12345678, 4))).toBe("corrupt");
  });

  it("refuses a prefix, ZIP64 locator and too many entries", () => {
    const prefixed = new Uint8Array(valid.length + 4);
    prefixed.set(valid, 4);
    expect(refusal(prefixed)).toBe("malformed");
    const container = readZipContainer(valid);
    const many = valid.slice();
    new DataView(many.buffer).setUint16(container.eocdStart + 8, OOXML_PACKAGE_LIMITS.maxEntries + 1, true);
    new DataView(many.buffer).setUint16(container.eocdStart + 10, OOXML_PACKAGE_LIMITS.maxEntries + 1, true);
    expect(refusal(many)).toBe("tooManyEntries");
    const zip64 = valid.slice();
    new DataView(zip64.buffer).setUint32(container.eocdStart - 20, 0x07064b50, true);
    expect(refusal(zip64)).toBe("zip64");
  });
});
