import { describe, expect, it } from "vitest";
import { strToU8 } from "fflate";
import { buildPackage, docxParts, pptxParts, xlsxParts, contentTypes } from "./fixtures/ooxmlFixtures";
import {
  contentTypeResolver,
  effectiveChanges,
  openOoxmlPackage,
  readRelationships,
  resolveRelationshipTarget,
  saveOoxmlPackage,
} from "./ooxmlPackage";
import { scanOoxmlCapabilities } from "./capabilityGate";
import { PackagePartMap } from "./partMaps";
import { firstAlteredEntry, readZipContainer } from "./zipContainer";

/** Package bytes with the CRC-32 of `name` replaced in its local and central headers. */
function withBadChecksum(bytes: Uint8Array, name: string): Uint8Array {
  const entry = readZipContainer(bytes).entries.find((e) => e.name === name)!;
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  view.setUint32(entry.localStart + 14, entry.crc ^ 1, true);
  view.setUint32(entry.centralStart + 16, entry.crc ^ 1, true);
  return out;
}

const PICTURE = "word/media/image1.png";
const pictureDoc = () => buildPackage(docxParts(undefined, { [PICTURE]: new Uint8Array(4096).map((_, i) => (i * 7919) & 0xff) }), { stored: [PICTURE] });

describe("OOXML package", () => {
  it("identifies the document kind from the main part's content type", () => {
    expect(openOoxmlPackage(buildPackage(docxParts())).kind).toBe("wordprocessing");
    expect(openOoxmlPackage(buildPackage(xlsxParts())).kind).toBe("spreadsheet");
    expect(openOoxmlPackage(buildPackage(pptxParts())).kind).toBe("presentation");
    const pkg = openOoxmlPackage(buildPackage(docxParts()));
    expect(pkg.mainPart).toBe("word/document.xml");
    expect(pkg.contentTypeOf("word/_rels/document.xml.rels")).toBe("application/vnd.openxmlformats-package.relationships+xml");
  });

  it("reports an unknown kind for a ZIP without an office main part", () => {
    const parts = { "[Content_Types].xml": contentTypes({}), "readme.xml": "<r/>" };
    expect(openOoxmlPackage(buildPackage(parts)).kind).toBe("unknown");
    expect(() => openOoxmlPackage(buildPackage({ "a.xml": "<a/>" }))).toThrow(/no \[Content_Types\]\.xml/);
  });

  it("returns the original bytes when nothing changed, including identical replacements", () => {
    const bytes = buildPackage(docxParts());
    const pkg = openOoxmlPackage(bytes);
    expect(saveOoxmlPackage(pkg, new Map())).toBe(bytes);
    const same = pkg.parts.get("word/document.xml")!.slice();
    expect(saveOoxmlPackage(pkg, new Map([["word/document.xml", same]]))).toBe(bytes);
  });

  it("compares against the archive, not the caller-visible part buffer", () => {
    const pkg = openOoxmlPackage(buildPackage(docxParts()));
    const visible = pkg.parts.get("word/document.xml") as Uint8Array;
    visible[visible.length - 1] ^= 1; // a caller mutated the shared buffer in place
    expect(effectiveChanges(pkg, new Map([["word/document.xml", visible]])).size).toBe(1);
  });

  it("saves one changed part and reopens with every other part identical", () => {
    const bytes = buildPackage(docxParts(), { comment: "c" });
    const pkg = openOoxmlPackage(bytes);
    const edited = strToU8(new TextDecoder().decode(pkg.parts.get("word/document.xml")).replace("Hello", "Hi"));
    const saved = saveOoxmlPackage(pkg, new Map([["word/document.xml", edited]]));
    const reopened = openOoxmlPackage(saved);
    for (const [name, content] of pkg.parts) {
      expect(reopened.parts.get(name)).toEqual(name === "word/document.xml" ? edited : content);
    }
    const before = readZipContainer(bytes);
    const after = readZipContainer(saved);
    const unchanged = (c: typeof before, name: string) => {
      const e = c.entries.find((x) => x.name === name)!;
      return c.bytes.subarray(e.localStart, e.localEnd);
    };
    expect(unchanged(after, "docProps/core.xml")).toEqual(unchanged(before, "docProps/core.xml"));
  });

  it("resolves relationship targets and refuses targets that leave the package", () => {
    expect(resolveRelationshipTarget("word/document.xml", "media/image1.png")).toBe("word/media/image1.png");
    expect(resolveRelationshipTarget("word/document.xml", "../customXml/item1.xml")).toBe("customXml/item1.xml");
    expect(resolveRelationshipTarget("word/document.xml", "/word/styles.xml")).toBe("word/styles.xml");
    expect(resolveRelationshipTarget("word/document.xml", "../../escape.xml")).toBeNull();
    expect(resolveRelationshipTarget("", "word/a%20b.xml")).toBe("word/a b.xml");
    const pkg = openOoxmlPackage(buildPackage(docxParts(undefined, {}, {}, [{ id: "rId9", type: "hyperlink", target: "https://example.invalid/", external: true }])));
    expect(readRelationships(pkg, "word/document.xml")).toEqual([
      { id: "rId9", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", target: "https://example.invalid/", external: true, targetPart: null },
    ]);
  });

  it("decodes XML entities in relationship targets and part names", () => {
    const pkg = openOoxmlPackage(buildPackage(docxParts(undefined, {}, {}, [{ id: "rId8", type: "image", target: "media/R&amp;D.png" }])));
    const rel = readRelationships(pkg, "word/document.xml").find((r) => r.id === "rId8");
    expect(rel).toMatchObject({ target: "media/R&D.png", targetPart: "word/media/R&D.png" });
    const types = contentTypeResolver(strToU8('<Types><Override PartName="/word/R&amp;D.xml" ContentType="text/x-test"/></Types>'));
    expect(types("word/R&D.xml")).toBe("text/x-test");
  });

  it("opens and scans without decoding parts it never reads", () => {
    const pkg = openOoxmlPackage(pictureDoc());
    const report = scanOoxmlCapabilities(pkg);
    expect(report.partCount).toBe(6);
    expect(pkg.parts).toBeInstanceOf(PackagePartMap);
    const parts = pkg.parts as PackagePartMap;
    expect(parts.isDecoded("word/document.xml")).toBe(true);
    expect(parts.isDecoded(PICTURE)).toBe(false);
    expect(parts.has(PICTURE)).toBe(true);
    expect(parts.get(PICTURE)!.length).toBe(4096);
    expect(parts.isDecoded(PICTURE)).toBe(true);
  });

  it("refuses a part that fails its checksum when it is read, and copies it untouched on save", () => {
    const bytes = withBadChecksum(pictureDoc(), PICTURE);
    const pkg = openOoxmlPackage(bytes);
    expect(() => pkg.parts.get(PICTURE)).toThrow(/fails its checksum/);
    expect(() => [...pkg.parts.values()]).toThrow(/fails its checksum/);
    expect(saveOoxmlPackage(pkg, new Map())).toBe(bytes);
    const edited = strToU8(new TextDecoder().decode(pkg.parts.get("word/document.xml")).replace("Hello", "Hi"));
    const saved = saveOoxmlPackage(pkg, new Map([["word/document.xml", edited]]));
    const after = readZipContainer(saved);
    expect(firstAlteredEntry(pkg.container, after, (name) => name === "word/document.xml")).toBeNull();
    expect(firstAlteredEntry(pkg.container, after, () => false)).toBe("word/document.xml");
  });

  it("still refuses a high-ratio part at open, before anything is read", () => {
    const bomb = buildPackage(docxParts(undefined, { "word/media/blank.bin": new Uint8Array(4 * 1024 * 1024) }));
    expect(() => openOoxmlPackage(bomb)).toThrow(/expands/);
  });
});
