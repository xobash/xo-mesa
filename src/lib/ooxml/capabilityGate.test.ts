import { describe, expect, it } from "vitest";
import { buildPackage, docxParts, pptxParts, wordDocumentXml, xlsxParts, W_NS } from "./fixtures/ooxmlFixtures";
import { openOoxmlPackage } from "./ooxmlPackage";
import { decideOoxmlEditPolicy, scanOoxmlCapabilities, type OoxmlFeature } from "./capabilityGate";
import { forEachStartTag } from "./xmlScan";

function features(parts: Record<string, string | Uint8Array>): OoxmlFeature[] {
  return scanOoxmlCapabilities(openOoxmlPackage(buildPackage(parts))).features.map((f) => f.feature);
}

const CT = "application/vnd.openxmlformats-officedocument";

describe("OOXML capability gate", () => {
  it("reports nothing for a plain document", () => {
    const report = scanOoxmlCapabilities(openOoxmlPackage(buildPackage(docxParts())));
    expect(report).toMatchObject({ kind: "wordprocessing", mainPart: "word/document.xml", features: [] });
  });

  it("detects tracked changes under any prefix bound to the WordprocessingML namespace", () => {
    expect(features(docxParts('<w:p><w:ins w:id="1"><w:r><w:t>x</w:t></w:r></w:ins></w:p>'))).toEqual(["trackedChanges"]);
    const other = { ...docxParts(), "word/document.xml": wordDocumentXml('<q:p><q:del q:id="1"/><q:rPrChange/></q:p>', "q") };
    expect(features(other)).toEqual(["trackedChanges"]);
    // Same local name in an unrelated namespace is not a revision.
    const foreign = docxParts(`<w:p><x:ins xmlns:x="urn:example"/></w:p>`);
    expect(features(foreign)).toEqual([]);
  });

  it("detects comments, content controls, custom XML markup and alternate content in the body", () => {
    const body = '<w:p><w:commentRangeStart w:id="0"/><w:sdt/><w:customXml w:element="x"/><mc:AlternateContent/></w:p>';
    expect(features(docxParts(body))).toEqual(["comments", "customXmlMarkup", "contentControls", "alternateContent"]);
  });

  it("detects part-level features by content type, name and relationship", () => {
    const parts = docxParts(undefined, {
      "word/vbaProject.bin": new Uint8Array([1]),
      "word/comments.xml": `<w:comments xmlns:w="${W_NS}"/>`,
      "customXml/item1.xml": "<root/>",
      "word/charts/chart1.xml": "<c/>",
      "word/diagrams/data1.xml": "<d/>",
      "word/embeddings/oleObject1.bin": new Uint8Array([2]),
      "_xmlsignatures/sig1.xml": "<s/>",
    }, {
      "word/comments.xml": `${CT}.wordprocessingml.comments+xml`,
      "word/charts/chart1.xml": `${CT}.drawingml.chart+xml`,
      "word/diagrams/data1.xml": `${CT}.drawingml.diagramData+xml`,
    }, [
      { id: "rId5", type: "attachedTemplate", target: "file:///C:/t.dotm", external: true },
      { id: "rId6", type: "hyperlink", target: "https://example.invalid/", external: true },
    ]);
    expect(features(parts)).toEqual([
      "macros", "comments", "customXmlParts", "charts", "smartArt", "embeddedObjects", "digitalSignatures", "externalLinks",
    ]);
  });

  it("detects spreadsheet and presentation features", () => {
    const xlsx = xlsxParts({ "xl/revisions/revisionHeaders.xml": "<h/>", "xl/externalLinks/externalLink1.xml": "<e/>" }, {
      "xl/revisions/revisionHeaders.xml": `${CT}.spreadsheetml.revisionHeaders+xml`,
      "xl/externalLinks/externalLink1.xml": `${CT}.spreadsheetml.externalLink+xml`,
    });
    expect(features(xlsx)).toEqual(["trackedChanges", "externalLinks"]);
    const pptm = pptxParts({ "ppt/comments/comment1.xml": "<c/>" }, {
      "ppt/presentation.xml": "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
      "ppt/comments/comment1.xml": `${CT}.presentationml.comments+xml`,
    });
    const report = scanOoxmlCapabilities(openOoxmlPackage(buildPackage(pptm)));
    expect(report.kind).toBe("presentation");
    expect(report.features.map((f) => f.feature)).toEqual(["macros", "comments"]);
  });

  it("refuses a part that declares a DTD", () => {
    const parts = { ...docxParts(), "word/document.xml": '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aa">]><w:document/>' };
    expect(() => scanOoxmlCapabilities(openOoxmlPackage(buildPackage(parts)))).toThrow(/DTD/);
  });

  it("scans deeply nested XML without recursion", () => {
    const nested = (depth: number) => `<w:document xmlns:w="${W_NS}">${"<w:p>".repeat(depth)}<w:del/>${"</w:p>".repeat(depth)}</w:document>`;
    let tags = 0;
    forEachStartTag(nested(200_000), () => { tags++; });
    expect(tags).toBe(200_002);
    // Small enough to stay under the package's compression-ratio guard.
    expect(features({ ...docxParts(), "word/document.xml": nested(50_000) })).toEqual(["trackedChanges"]);
  });
});

describe("OOXML edit policy", () => {
  const report = (parts: Record<string, string | Uint8Array>) => scanOoxmlCapabilities(openOoxmlPackage(buildPackage(parts)));

  it("allows a plain document and refuses a mismatched editor", () => {
    expect(decideOoxmlEditPolicy(report(docxParts()), "wordprocessing", new Set()).decision).toBe("allow");
    expect(decideOoxmlEditPolicy(report(docxParts()), "spreadsheet", new Set()).decision).toBe("refuseSave");
  });

  it("refuses inline features the editor does not model and warns for part features", () => {
    const tracked = report(docxParts("<w:p><w:del/></w:p>"));
    expect(decideOoxmlEditPolicy(tracked, "wordprocessing", new Set()).decision).toBe("refuseSave");
    expect(decideOoxmlEditPolicy(tracked, "wordprocessing", new Set<OoxmlFeature>(["trackedChanges"])).decision).toBe("allow");
    const chart = report(docxParts(undefined, { "word/charts/chart1.xml": "<c/>" }, { "word/charts/chart1.xml": `${CT}.drawingml.chart+xml` }));
    expect(decideOoxmlEditPolicy(chart, "wordprocessing", new Set())).toEqual({
      decision: "allowWithWarning", reasons: [{ feature: "charts", decision: "allowWithWarning" }],
    });
  });

  it("always refuses to save a signed package", () => {
    const signed = report(docxParts(undefined, { "_xmlsignatures/sig1.xml": "<s/>" }));
    expect(decideOoxmlEditPolicy(signed, "wordprocessing", new Set<OoxmlFeature>(["digitalSignatures"])).decision).toBe("refuseSave");
  });
});
