import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { buildPackage, contentTypes, relationships, W_NS, WORD_MAIN, wordDocumentXml, xmlHeader, type FixtureParts } from "./fixtures/ooxmlFixtures";
import { openOoxmlPackage } from "./ooxmlPackage";
import { scanOoxmlCapabilities } from "./capabilityGate";
import { describeWordPolicy, planWordSave, wordEditPolicy } from "./wordCompose";
import { spliceStoryPart } from "./wordSplicePart";

// Paragraph splice: a save into a Word file with tracked changes, comments or
// content controls writes the original part's bytes with only the changed
// blocks replaced by the editor's version.

const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";
const T = "application/vnd.openxmlformats-officedocument.wordprocessingml";

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const TRACKED = '<w:p><w:r><w:t>One</w:t></w:r><w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t xml:space="preserve"> added</w:t></w:r></w:ins>'
  + '<w:del w:id="2" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve"> gone</w:delText></w:r></w:del></w:p>';
const COMMENTED = '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Commented</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>';
const CONTROL = '<w:sdt><w:sdtPr><w:alias w:val="Box"/><w:id w:val="5"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>In control</w:t></w:r></w:p></w:sdtContent></w:sdt>';
const SECT = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>';
const BLOCKS = [TRACKED, P("Two"), COMMENTED, CONTROL, P("Five"), P("Six")];

const COMMENTS = xmlHeader(`<w:comments xmlns:w="${W_NS}"><w:comment w:id="0" w:author="A"><w:p><w:r><w:t>note</w:t></w:r></w:p></w:comment></w:comments>`);
const COMMENTS_TYPE = `${T}.comments+xml`;

/** What the engine does to a block it did not change: same content, different bytes, and it drops tracked-change dates. */
const engine = (block: string) => block.replace(/<w:p>/g, '<w:p w14:paraId="1A2B3C4D">').replace(/ w:date="[^"]*"/g, "");
const engineDocument = (blocks: readonly string[], sect = '<w:sectPr><w:pgSz w:h="15840" w:w="12240"/></w:sectPr>') =>
  `<w:document xmlns:mc="${MC}" xmlns:r="${R_NS}" xmlns:w="${W_NS}" xmlns:w14="${W14}" mc:Ignorable="w14"><w:body>${blocks.join("")}${sect}</w:body></w:document>`;

interface Variant { blocks: readonly string[]; extra?: FixtureParts; rels?: Parameters<typeof relationships>[0]; defaults?: Record<string, string>; comments?: string }

function wordPackage(document: string, variant: Omit<Variant, "blocks">): Uint8Array {
  return buildPackage({
    "[Content_Types].xml": contentTypes({ "word/document.xml": WORD_MAIN, "word/comments.xml": COMMENTS_TYPE }, variant.defaults),
    "_rels/.rels": relationships([{ id: "rId1", type: "officeDocument", target: "word/document.xml" }]),
    "word/document.xml": document,
    "word/_rels/document.xml.rels": relationships(variant.rels ?? [{ id: "rIdC", type: "comments", target: "comments.xml" }]),
    "word/comments.xml": variant.comments ?? COMMENTS,
    ...variant.extra,
  });
}

const original = (blocks: readonly string[] = BLOCKS, rest: Omit<Variant, "blocks"> = {}) => wordPackage(wordDocumentXml(blocks.join("") + SECT), rest);
const engineOutput = (variant: Variant, sect?: string) => wordPackage(engineDocument(variant.blocks.map(engine), sect), variant);
const partText = (bytes: Uint8Array, part: string) => new TextDecoder().decode(unzipSync(bytes)[part]);
const withBlock = (index: number, block: string, blocks: readonly string[] = BLOCKS) => blocks.map((b, i) => (i === index ? block : b));

function plan(blocks: readonly string[], editedBlocks: readonly string[], options?: Parameters<typeof planWordSave>[3]) {
  return planWordSave(openOoxmlPackage(original(blocks)), engineOutput({ blocks }), engineOutput({ blocks: editedBlocks }), options);
}

describe("Word paragraph splice", () => {
  it("keeps tracked changes, comments and content controls byte-for-byte when another paragraph changes", () => {
    const opened = openOoxmlPackage(original());
    const edited = engineOutput({ blocks: withBlock(4, P("Five edited")), comments: COMMENTS.replace('w:author="A"', 'w:author="A" w:initials="A"') });
    const result = planWordSave(opened, engineOutput({ blocks: BLOCKS }), edited);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    const doc = partText(result.bytes, "word/document.xml");
    for (const block of [TRACKED, P("Two"), COMMENTED, CONTROL, P("Six")]) expect(doc).toContain(block);
    expect(doc).toContain(engine(P("Five edited")));
    expect(doc).not.toContain(">Five<");
    expect(doc.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true);
    expect(doc).toContain(`${SECT}</w:body>`);
    expect(doc).toMatch(new RegExp(`xmlns:w14="${W14}"`));
    expect(doc).toMatch(/mc:Ignorable="w14"/);
    expect(result.changedParts).toEqual(["word/document.xml"]);
    expect(result.package.parts.get("word/comments.xml")).toEqual(opened.parts.get("word/comments.xml"));
    expect(result.losses).toEqual([]);
    const features = scanOoxmlCapabilities(result.package).features.map((f) => f.feature);
    expect(features).toEqual(expect.arrayContaining(["trackedChanges", "comments", "contentControls"]));
  });

  it("refuses an edit inside the commented paragraph and names the feature and the paragraph", () => {
    const result = plan(BLOCKS, withBlock(2, COMMENTED.replace("Commented", "Commented again")));
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.problems.join(" ")).toMatch(/paragraph 3 of the main text \(“Commented”\) has a comment/);
  });

  it("refuses an edit inside a content control and inside a tracked change", () => {
    const control = plan(BLOCKS, withBlock(3, CONTROL.replace("In control", "Changed")));
    expect(control.kind === "blocked" && control.problems.join(" ")).toMatch(/content control 1 of the main text \(“In control”\) has a content control/);
    const tracked = plan(BLOCKS, withBlock(0, TRACKED.replace(">One<", ">Uno<")));
    expect(tracked.kind === "blocked" && tracked.problems.join(" ")).toMatch(/paragraph 1 .*has tracked changes/);
  });

  it("refuses an edit or an insertion inside a comment range that spans paragraphs", () => {
    const spanning = withBlock(5, '<w:p><w:r><w:t>Six</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>',
      withBlock(1, '<w:p><w:commentRangeStart w:id="7"/><w:r><w:t>Two</w:t></w:r></w:p>'));
    const edit = plan(spanning, withBlock(4, P("Five edited"), spanning));
    expect(edit.kind === "blocked" && edit.problems.join(" ")).toMatch(/paragraph 4 of the main text \(“Five”\) is inside a comment that runs from paragraph 2 .* to paragraph 5/);
    const insert = plan(spanning, [...spanning.slice(0, 5), P("New"), spanning[5]]);
    expect(insert.kind === "blocked" && insert.problems.join(" ")).toMatch(/new text after paragraph 4 .* would land inside a comment/);
  });

  it("refuses an edit to the paragraph a tracked paragraph mark joins", () => {
    const marked = withBlock(4, '<w:p><w:pPr><w:rPr><w:del w:id="9" w:author="A"/></w:rPr></w:pPr><w:r><w:t>Five</w:t></w:r></w:p>');
    const result = plan(marked, withBlock(5, P("Six edited"), marked));
    expect(result.kind === "blocked" && result.problems.join(" ")).toMatch(/paragraph 5 .*“Six”.* is inside a tracked change on a paragraph mark/);
  });

  it("deletes and inserts plain paragraphs and keeps every other block", () => {
    const edited = [BLOCKS[0], ...BLOCKS.slice(2), P("Seven")];
    const result = plan(BLOCKS, edited);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    const doc = partText(result.bytes, "word/document.xml");
    expect(doc).toContain(`<w:body>${TRACKED}${COMMENTED}${CONTROL}${P("Five")}${P("Six")}${engine(P("Seven"))}${SECT}</w:body>`);
  });

  it("merges relationships and content types: keeps entries the editor dropped and adds the new picture", () => {
    const rels = [{ id: "rIdC", type: "comments", target: "comments.xml" }, { id: "rIdX", type: "customXml", target: "../customXml/item1.xml" }];
    const extra = { "customXml/item1.xml": "<data/>" };
    const opened = openOoxmlPackage(original(BLOCKS, { rels, extra }));
    const engineRels = [rels[0]];
    const picture = '<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rIdP"/></w:drawing></w:r></w:p>';
    const edited = engineOutput({ blocks: [...BLOCKS, picture], rels: [...engineRels, { id: "rIdP", type: "image", target: "media/image1.png" }],
      extra: { ...extra, "word/media/image1.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }, defaults: { png: "image/png" } });
    const result = planWordSave(opened, engineOutput({ blocks: BLOCKS, rels: engineRels, extra }), edited);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    const merged = partText(result.bytes, "word/_rels/document.xml.rels");
    for (const id of ["rIdC", "rIdX", "rIdP"]) expect(merged).toContain(`Id="${id}"`);
    expect(result.package.contentTypeOf("word/media/image1.png")).toBe("image/png");
    expect(result.package.contentTypeOf("word/comments.xml")).toBe(COMMENTS_TYPE);
  });

  it("refuses an edit that changes section settings outside the paragraphs", () => {
    const opened = openOoxmlPackage(original());
    const result = planWordSave(opened, engineOutput({ blocks: BLOCKS }), engineOutput({ blocks: BLOCKS }, '<w:sectPr><w:pgSz w:h="12240" w:w="15840"/></w:sectPr>'));
    expect(result.kind === "blocked" && result.problems.join(" ")).toMatch(/changed the main text outside its paragraphs/);
  });

  it("refuses a namespace prefix that means something else in the file", () => {
    const o = xmlHeader(`<w:document xmlns:w="${W_NS}" xmlns:w14="urn:other"><w:body>${P("A")}</w:body></w:document>`);
    const b = engineDocument([engine(P("A"))]);
    const e = engineDocument([engine(P("B"))]);
    const result = spliceStoryPart(o, b, e, "the main text");
    expect(result.kind === "refused" && result.problems.join(" ")).toMatch(/prefix "w14" means different things/);
  });

  it("falls back to whole-part composition for Save as copy when the splice refuses", () => {
    const result = plan(BLOCKS, withBlock(2, COMMENTED.replace("Commented", "Commented again")), { mode: "copy" });
    expect(result.kind).toBe("ready");
  });

  it("splices a large document in linear time", () => {
    const run = (count: number) => {
      const blocks = Array.from({ length: count }, (_, i) => P(`Paragraph ${i}`));
      const o = wordDocumentXml(blocks.join("") + SECT);
      const b = engineDocument(blocks.map(engine));
      const e = engineDocument(withBlock(count >> 1, P("Edited"), blocks).map(engine));
      const started = performance.now();
      expect(spliceStoryPart(o, b, e, "the main text").kind).toBe("spliced");
      return performance.now() - started;
    };
    run(1_000);
    let best = Infinity;
    for (let round = 0; round < 5; round++) {
      const large = run(16_000);
      let small = 0;
      for (let k = 0; k < 8; k++) small += run(2_000);
      best = Math.min(best, large / small);
    }
    expect(best).toBeLessThan(4);
    // Large inputs need more than the default timeout under coverage; the ratio is the contract.
  }, 30000);
});

describe("Word overwrite policy with the paragraph splice", () => {
  it("allows in-place saves for review features through the splice and explains the rule", () => {
    const policy = wordEditPolicy(openOoxmlPackage(original()));
    expect(policy.decision).toBe("allow");
    expect(policy.splice).toEqual(expect.arrayContaining(["trackedChanges", "comments", "contentControls"]));
    const notice = describeWordPolicy(policy);
    expect(notice.canSave).toBe(true);
    expect(notice.message).toMatch(/tracked changes, comments and content controls.*paragraphs you do not change keep them exactly/);
  });

  it("still refuses signed files", () => {
    const signed = openOoxmlPackage(original(BLOCKS, { extra: { "_xmlsignatures/sig1.xml": "<Signature/>" } }));
    expect(wordEditPolicy(signed).decision).toBe("refuseSave");
  });
});
