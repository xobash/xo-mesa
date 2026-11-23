import { describe, expect, it } from "vitest";
import { strToU8 } from "fflate";
import { decodeXmlText, escapeXmlText } from "../ooxml/xmlScan";
import { applySplices, descendants, encodeXmlPart, parseXmlTree } from "./xmlTree";
import { editTextBody } from "./pptxTextEdit";

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

function body(paragraphs: string): string {
  return `<p:sld ${P}><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sld>`;
}

describe("XML tree", () => {
  it("keeps source spans and namespaces, and parses deep nesting without recursion", () => {
    const doc = parseXmlTree(strToU8(`<r xmlns="u:1"><x:a xmlns:x="u:2" k="1"/><b>t</b></r>`));
    expect(doc.root.ns).toBe("u:1");
    expect(doc.root.children.map((c) => [c.localName, c.ns])).toEqual([["a", "u:2"], ["b", "u:1"]]);
    const b = doc.root.children[1];
    expect(doc.text.slice(b.start, b.end)).toBe("<b>t</b>");
    const depth = 200_000;
    const deep = parseXmlTree(strToU8(`${"<d>".repeat(depth)}${"</d>".repeat(depth)}`));
    expect(descendants(deep.root)).toHaveLength(depth - 1);
  });

  it("refuses DTDs, mismatched tags, truncation and multiple roots", () => {
    expect(() => parseXmlTree(strToU8('<!DOCTYPE r [<!ENTITY e "x">]><r/>'))).toThrow(/DTD/);
    expect(() => parseXmlTree(strToU8("<a><b></a></b>"))).toThrow(/mismatched/);
    expect(() => parseXmlTree(strToU8("<a><b>"))).toThrow(/truncated/);
    expect(() => parseXmlTree(strToU8("<a/><b/>"))).toThrow(/more than one root/);
  });

  it("decodes and encodes text, dropping characters XML cannot carry", () => {
    expect(decodeXmlText("a &amp; b &lt;c&gt; &#x41;&#66; &bogus;")).toBe("a & b <c> AB &bogus;");
    expect(escapeXmlText("a<b>&\u0001c\td")).toBe("a&lt;b&gt;&amp;c\td");
    expect(applySplices("abcdef", [{ start: 4, end: 5, text: "E" }, { start: 1, end: 2, text: "" }])).toBe("acdEf");
  });

  it("keeps a UTF-8 byte-order mark when re-encoding an edited part", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8("<a>x</a>")]);
    const doc = parseXmlTree(bytes);
    expect([...encodeXmlPart(doc, "<a>y</a>").subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe("run-preserving text edits", () => {
  const twoRuns = body('<a:p><a:r><a:rPr b="1"/><a:t>Hello</a:t></a:r><a:r><a:rPr i="1"/><a:t> world</a:t></a:r></a:p>');

  it("typing at the end of a run extends that run, keeping both run properties", () => {
    const out = editTextBody(parseXmlTree(strToU8(twoRuns)), 0, "Hello! world");
    expect(out).toContain('<a:rPr b="1"/><a:t>Hello!</a:t>');
    expect(out).toContain('<a:rPr i="1"/><a:t> world</a:t>');
  });

  it("a deletion across runs trims each run and keeps the runs", () => {
    const out = editTextBody(parseXmlTree(strToU8(twoRuns)), 0, "Held");
    expect(out).toContain('<a:rPr b="1"/><a:t>Hel</a:t>');
    expect(out).toContain('<a:rPr i="1"/><a:t>d</a:t>');
  });

  it("fills an empty paragraph with a run built from its end properties", () => {
    const xml = body('<a:p><a:endParaRPr lang="en-GB" sz="1200"/></a:p>');
    expect(editTextBody(parseXmlTree(strToU8(xml)), 0, "New")).toContain('<a:p><a:r><a:rPr lang="en-GB" sz="1200"/><a:t>New</a:t></a:r><a:endParaRPr lang="en-GB" sz="1200"/></a:p>');
  });

  it("fills a self-closing text element and never splits a surrogate pair", () => {
    const xml = body("<a:p><a:r><a:t/></a:r></a:p>");
    expect(editTextBody(parseXmlTree(strToU8(xml)), 0, "x")).toContain("<a:r><a:t>x</a:t></a:r>");
    const emoji = body("<a:p><a:r><a:t>\u{1F600}</a:t></a:r></a:p>");
    const out = editTextBody(parseXmlTree(strToU8(emoji)), 0, "\u{1F601}");
    expect(out).toContain("<a:t>\u{1F601}</a:t>");
  });
});
