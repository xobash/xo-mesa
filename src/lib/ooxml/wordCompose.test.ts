import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { buildPackage, docxParts, relationships, type FixtureParts } from "./fixtures/ooxmlFixtures";
import { openOoxmlPackage } from "./ooxmlPackage";
import { describeCensusLosses, describeWordPolicy, planWordSave, wordEditPolicy } from "./wordCompose";
import { OoxmlPackageError } from "./zipContainer";

const STYLES_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml";
const STYLES = '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"/></w:styles>';
// What an editor's whole-part serializer does to an untouched part: same infoset, different bytes.
const STYLES_REWRITTEN = '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:styleId="Normal" w:type="paragraph"/></w:styles>';
const STYLES_REL = [{ id: "rIdS", type: "styles", target: "styles.xml" }];

function word(body: string, styles = STYLES, extra: FixtureParts = {}, rels = STYLES_REL, overrides: Record<string, string> = {}): Uint8Array {
  return buildPackage(docxParts(body, { "word/styles.xml": styles, ...extra }, { "word/styles.xml": STYLES_TYPE, ...overrides }, rels));
}

const PARA = (text: string) => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
const text = (bytes: Uint8Array, part: string) => new TextDecoder().decode(unzipSync(bytes)[part]);

describe("Word save composition", () => {
  it("writes nothing when the editor output equals its own no-edit output", () => {
    const original = openOoxmlPackage(word(PARA("Hello")));
    const baseline = word(PARA("Hello"), STYLES_REWRITTEN);
    expect(planWordSave(original, baseline, baseline.slice())).toEqual({ kind: "unchanged" });
  });

  it("keeps the original bytes of every part the edit did not change", () => {
    const originalBytes = word(PARA("Hello"));
    const original = openOoxmlPackage(originalBytes);
    const baseline = word(PARA("Hello"), STYLES_REWRITTEN);
    const edited = word(PARA("Hello world"), STYLES_REWRITTEN);
    const plan = planWordSave(original, baseline, edited);
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(plan.changedParts).toEqual(["word/document.xml"]);
    expect(text(plan.bytes, "word/styles.xml")).toBe(STYLES);
    expect(text(plan.bytes, "word/document.xml")).toContain("Hello world");
    expect(plan.losses).toEqual([]);
  });

  it("adds new parts with their relationships and content types", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const original = openOoxmlPackage(word(PARA("A")));
    const baseline = word(PARA("A"), STYLES_REWRITTEN);
    const picture = '<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rIdP"/></w:drawing></w:r></w:p>';
    const edited = word(PARA("A") + picture, STYLES_REWRITTEN, { "word/media/image1.png": png },
      [...STYLES_REL, { id: "rIdP", type: "image", target: "media/image1.png" }], { "word/media/image1.png": "image/png" });
    const plan = planWordSave(original, baseline, edited);
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(plan.package.parts.get("word/media/image1.png")).toEqual(png);
    expect(plan.losses).toEqual([]);
  });

  it("refuses a save that would leave a reference without its relationship", () => {
    const original = openOoxmlPackage(word(PARA("A")));
    const baseline = word(PARA("A"), STYLES_REWRITTEN);
    const edited = word(`${PARA("A")}<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rIdGone"/></w:drawing></w:r></w:p>`, STYLES_REWRITTEN);
    const plan = planWordSave(original, baseline, edited);
    expect(plan.kind).toBe("refused");
    if (plan.kind === "refused") expect(plan.problems.join(" ")).toMatch(/r:embed="rIdGone" points to no relationship/);
  });

  it("refuses values Word requires but the editor left out, and spaces that would be dropped", () => {
    const original = openOoxmlPackage(word(PARA("A")));
    const baseline = word(PARA("A"), STYLES_REWRITTEN);
    const noValue = planWordSave(original, baseline, word('<w:p><w:pPr><w:jc/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>', STYLES_REWRITTEN));
    expect(noValue.kind === "refused" && noValue.problems.join(" ")).toMatch(/<w:jc> has no required value/);
    const spaces = planWordSave(original, baseline, word("<w:p><w:r><w:t> A </w:t></w:r></w:p>", STYLES_REWRITTEN));
    expect(spaces.kind === "refused" && spaces.problems.join(" ")).toMatch(/leading or trailing spaces/);
    const kept = planWordSave(original, baseline, word('<w:p><w:r><w:t xml:space="preserve"> A </w:t></w:r></w:p>', STYLES_REWRITTEN));
    expect(kept.kind).toBe("ready");
  });

  it("refuses a missing style only when the save introduces it", () => {
    const unknownStyle = '<w:p><w:pPr><w:pStyle w:val="Missing"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>';
    const original = openOoxmlPackage(word(unknownStyle));
    const baseline = word(unknownStyle, STYLES_REWRITTEN);
    expect(planWordSave(original, baseline, word(unknownStyle + PARA("B"), STYLES_REWRITTEN)).kind).toBe("ready");
    const clean = openOoxmlPackage(word(PARA("A")));
    const plan = planWordSave(clean, word(PARA("A"), STYLES_REWRITTEN), word(unknownStyle, STYLES_REWRITTEN));
    expect(plan.kind === "refused" && plan.problems.join(" ")).toMatch(/style "Missing" is not defined/);
  });

  it("reports structures the save removes so the user can confirm", () => {
    const marked = `<w:p><w:bookmarkStart w:id="0" w:name="b"/><w:r><w:t>A</w:t></w:r><w:bookmarkEnd w:id="0"/><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>`;
    const original = openOoxmlPackage(word(marked));
    const plan = planWordSave(original, word(marked, STYLES_REWRITTEN), word(PARA("A"), STYLES_REWRITTEN));
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(plan.losses).toEqual([{ label: "bookmarks", before: 1, after: 0 }, { label: "fields", before: 1, after: 0 }]);
    expect(describeCensusLosses(plan.losses)).toBe("bookmarks: 1 → 0; fields: 1 → 0");
  });

  it("throws a package error when editor output is not an Office package", () => {
    const original = openOoxmlPackage(word(PARA("A")));
    expect(() => planWordSave(original, word(PARA("A")), new Uint8Array([1, 2, 3]))).toThrow(OoxmlPackageError);
  });

  it("keeps a part the editor never writes and drops nothing the edit did not remove", () => {
    const extra = { "customXml/item1.xml": "<data/>", "customXml/_rels/item1.xml.rels": relationships([]) };
    const original = openOoxmlPackage(word(PARA("A"), STYLES, extra));
    const plan = planWordSave(original, word(PARA("A"), STYLES_REWRITTEN), word(PARA("B"), STYLES_REWRITTEN));
    expect(plan.kind === "ready" && plan.package.parts.has("customXml/item1.xml")).toBe(true);
  });
});

describe("Word overwrite policy", () => {
  it("allows plain documents, splices inline review features, warns for copied parts and refuses signatures", () => {
    expect(wordEditPolicy(openOoxmlPackage(word(PARA("A")))).decision).toBe("allow");
    const tracked = word('<w:p><w:ins w:id="1" w:author="A"><w:r><w:t>x</w:t></w:r></w:ins></w:p>');
    expect(wordEditPolicy(openOoxmlPackage(tracked))).toMatchObject({ decision: "allow", splice: ["trackedChanges"] });
    const chart = word(PARA("A"), STYLES, { "word/charts/chart1.xml": "<c:chartSpace xmlns:c=\"x\"/>" }, STYLES_REL,
      { "word/charts/chart1.xml": "application/vnd.openxmlformats-officedocument.drawingml.chart+xml" });
    expect(wordEditPolicy(openOoxmlPackage(chart)).decision).toBe("allowWithWarning");
    const signed = word(PARA("A"), STYLES, { "_xmlsignatures/sig1.xml": "<Signature/>" });
    expect(wordEditPolicy(openOoxmlPackage(signed)).decision).toBe("refuseSave");
  });

  it("explains the decision in plain words", () => {
    expect(describeWordPolicy(wordEditPolicy(openOoxmlPackage(word(PARA("A")))))).toEqual({ canSave: true, message: null });
    const both = word('<w:p><w:ins w:id="1" w:author="A"><w:r><w:t>x</w:t></w:r></w:ins><w:commentReference w:id="0"/></w:p>');
    const spliced = describeWordPolicy(wordEditPolicy(openOoxmlPackage(both)));
    expect(spliced.canSave).toBe(true);
    expect(spliced.message).toMatch(/has tracked changes and comments\. Mesa saves edits only in paragraphs without them.*Save as copy/);
    const signed = describeWordPolicy(wordEditPolicy(openOoxmlPackage(word(PARA("A"), STYLES, { "_xmlsignatures/sig1.xml": "<Signature/>" }))));
    expect(signed.message).toMatch(/signature will show as invalid/);
  });
});
