// @vitest-environment jsdom
import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { buildOds } from "./fixtures/odfFixtures";
import { buildOdfSave, openOdfPackage } from "./odfPackage";
import { applyOdsEdits, cellAt, cellKey, checkOdsEdits, openOdsWorkbook } from "./odsSheet";
import { escapeXmlAttribute, escapeXmlText } from "../ooxml/xmlScan";

const TABLE_NS = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";

function saveAndReopen(edits: Map<string, string>) {
  const pkg = openOdfPackage(buildOds());
  const text = applyOdsEdits(openOdsWorkbook(pkg), edits);
  const saved = buildOdfSave(pkg, text, (s) => checkOdsEdits(openOdsWorkbook(s), edits))!;
  return { saved, sheet: openOdsWorkbook(openOdfPackage(saved)).sheets[0] };
}

/** Formulas as a conforming XML reader (an office suite) sees them; it normalizes raw tabs and line breaks in attributes. */
function formulasSeenByXmlReader(saved: Uint8Array): string[] {
  const doc = new DOMParser().parseFromString(strFromU8(unzipSync(saved)["content.xml"]), "application/xml");
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  return [...doc.getElementsByTagNameNS(TABLE_NS, "table-cell")].map((c) => c.getAttributeNS(TABLE_NS, "formula")).filter((f): f is string => !!f);
}

describe("ODS save escaping", () => {
  it("round-trips a formula and cell text holding tabs and line breaks exactly", () => {
    const formula = "=IF([.B1]>0;\n\t[.B1];\r0)";
    const text = "first\tcolumn\nsecond line";
    const { saved, sheet } = saveAndReopen(new Map([[cellKey(0, 0, 2), formula], [cellKey(0, 1, 2), text]]));
    expect(cellAt(sheet, 0, 2)?.edit).toBe(formula);
    expect(cellAt(sheet, 1, 2)?.display).toBe(text);
    expect(formulasSeenByXmlReader(saved)).toContain(`of:${formula}`);
  });

  it("drops characters XML 1.0 cannot carry and escapes attribute whitespace as references", () => {
    expect(escapeXmlText("a\u0000b\u001fc\ufffe<")).toBe("abc&lt;");
    expect(escapeXmlAttribute('"\t\n\r\u0008')).toBe("&#34;&#9;&#10;&#13;");
  });
});
