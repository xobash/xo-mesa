import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { buildOdf, buildOdp, buildOds, buildOdt, contentXml, ODS_BODY } from "./fixtures/odfFixtures";
import { buildOdfSave, openOdfPackage } from "./odfPackage";
import { applyOdtEdit, openOdtDocument, readOdtDocument } from "./odtDocument";
import { applyOdsEdits, cellAt, cellKey, checkOdsEdits, odsCellRefusal, openOdsWorkbook, readOdsWorkbook } from "./odsSheet";
import { editContainerText, moveOdpSlide, odpNotes, openOdpDeck, readOdpDeck, renderOdpSlide } from "./odpDeck";
import { encodeOdfText, MAX_PARAGRAPH_CHARS, readParagraph } from "./odfText";
import { parseXmlTree } from "../pptx/xmlTree";
import { readZipContainer } from "../ooxml/zipContainer";

const enc = new TextEncoder();

/** Entry names, in local-header order, with their compression method, read by an independent parser (fflate). */
function entriesOf(bytes: Uint8Array): Record<string, string> {
  return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k, v]) => [k, strFromU8(v)]));
}

function layout(bytes: Uint8Array): { first: string; method: number } {
  const c = readZipContainer(bytes);
  const first = [...c.entries].sort((a, b) => a.localStart - b.localStart)[0];
  return { first: first.name, method: first.method };
}

describe("ODF package", () => {
  it("opens all three kinds and a no-op save writes nothing", () => {
    for (const bytes of [buildOdt(), buildOds(), buildOdp()]) {
      const pkg = openOdfPackage(bytes);
      expect(pkg.policy.canEdit).toBe(true);
      expect(buildOdfSave(pkg, pkg.content.text)).toBeNull();
    }
  });

  it("an edit changes only content.xml and keeps mimetype first and stored", () => {
    const original = buildOdt();
    const pkg = openOdfPackage(original);
    const odt = openOdtDocument(pkg);
    const saved = buildOdfSave(pkg, applyOdtEdit(odt, { kind: "text", paragraph: 0, text: "New title" }))!;
    expect(layout(saved)).toEqual({ first: "mimetype", method: 0 });
    const before = entriesOf(original);
    const after = entriesOf(saved);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const name of Object.keys(before)) if (name !== "content.xml") expect(after[name]).toBe(before[name]);
    expect(after["content.xml"]).toContain("<text:h text:outline-level=\"1\">New title</text:h>");
    // Unchanged local records are byte-identical: the mimetype record leads both files.
    expect(saved.subarray(0, 60)).toEqual(original.subarray(0, 60));
  });

  it("gates signatures, encryption, templates, layout and macros", () => {
    const signed = openOdfPackage(buildOdt(undefined, { extra: { "META-INF/documentsignatures.xml": "<x/>" } }));
    expect(signed.policy.canEdit).toBe(false);
    expect(signed.policy.refusals.join(" ")).toMatch(/signed/);
    const encrypted = openOdfPackage(buildOdt(undefined, { extra: { "Pictures/a.png": "x" }, encrypted: ["Pictures/a.png"] }));
    expect(encrypted.policy.refusals.join(" ")).toMatch(/encrypted/);
    expect(() => openOdfPackage(buildOdt(undefined, { encrypted: ["content.xml"] }))).toThrow(/password-protected/);
    const template = openOdfPackage(buildOdt(undefined, { mime: "application/vnd.oasis.opendocument.text-template" }));
    expect(template.policy.refusals.join(" ")).toMatch(/template/);
    expect(openOdfPackage(buildOdt(undefined, { deflateMimetype: true })).policy.refusals.join(" ")).toMatch(/mimetype/);
    expect(openOdfPackage(buildOdt(undefined, { unlisted: ["meta.xml"] })).policy.refusals.join(" ")).toMatch(/manifest does not list meta.xml/);
    const macros = openOdfPackage(buildOdt(undefined, { extra: { "Basic/Standard/Module1.xml": "<x/>" } }));
    expect(macros.policy.canEdit).toBe(true);
    expect(macros.policy.warnings.join(" ")).toMatch(/macros/);
    expect(() => buildOdfSave(signed, signed.content.text + " ")).toThrow(/does not save/);
  });

  it("matches manifest paths after decoding XML entities", () => {
    const pkg = openOdfPackage(buildOdt(undefined, { extra: { "Pictures/R&D.png": "x" } }));
    expect(pkg.policy.refusals.join(" ")).not.toMatch(/manifest does not list/);
    expect(pkg.policy.canEdit).toBe(true);
  });

  it("refuses to write content that is not well-formed", () => {
    const pkg = openOdfPackage(buildOdt());
    expect(() => buildOdfSave(pkg, pkg.content.text.replace("</office:body>", ""))).toThrow(/well-formed|re-open/);
  });
});

describe("ODF text runs", () => {
  it("round-trips spaces, tabs and line breaks", () => {
    for (const text of ["a  b", "  lead", "trail  ", "x\ty", "one\ntwo", "a & <b>", " "]) {
      const xml = `<text:p xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">${encodeOdfText(text, "text")}</text:p>`;
      const doc = parseXmlTree(enc.encode(xml));
      expect(readParagraph(doc, doc.root).plain).toBe(text);
    }
  });

  // Each 22-byte <text:s text:c="10000"/> expands 450-fold; the length limit
  // ran only after the whole paragraph was built, so one content.xml could
  // demand gigabytes of text.
  it("stops building a paragraph once it passes the length limit", () => {
    const xml = `<text:p xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">${'<text:s text:c="10000"/>'.repeat(2000)}</text:p>`;
    const doc = parseXmlTree(enc.encode(xml));
    const read = readParagraph(doc, doc.root);
    expect(read.plain.length).toBe(MAX_PARAGRAPH_CHARS + 1);
    expect(read.refusal).toMatch(/too long/);
  });
});

describe("ODT", () => {
  const odt = () => openOdtDocument(openOdfPackage(buildOdt()));

  it("reads headings, formatting, lists, tables and refusals", () => {
    const doc = odt();
    const first = doc.blocks[0];
    expect(first).toMatchObject({ kind: "paragraph", heading: 1 });
    const para = doc.blocks[1];
    expect(para.kind === "paragraph" && para.runs.find((r) => r.text === "italic words")?.italic).toBe(true);
    expect(doc.blocks.filter((b) => b.kind === "paragraph" && b.listLevel === 1)).toHaveLength(2);
    expect(doc.blocks.some((b) => b.kind === "table" && b.rows[0].length === 2)).toBe(true);
    const link = doc.paragraphs.findIndex((p) => p.plain === "Visit the site.");
    expect(doc.paragraphs[link].refusal).toMatch(/link/);
    expect(doc.paragraphs.at(-1)!.plain).toBe("Two  spaces");
    expect(() => applyOdtEdit(doc, { kind: "text", paragraph: link, text: "x" })).toThrow(/link/);
  });

  it("edits keep the bookmark and other runs, and only the changed paragraph", () => {
    const doc = odt();
    const next = applyOdtEdit(doc, { kind: "text", paragraph: 1, text: "Plain italic words here end." });
    const reread = readOdtDocument(parseXmlTree(enc.encode(next)), null, false);
    expect(reread.paragraphs[1].plain).toBe("Plain italic words here end.");
    expect(next).toContain('<text:bookmark text:name="b1"/>');
    expect(next).toContain('<text:p>Plain <text:span text:style-name="T1">italic words</text:span> here end.<text:bookmark text:name="b1"/></text:p>');
    expect(next.replace(/<text:p>Plain[\s\S]*?<\/text:p>/, "")).toBe(doc.doc.text.replace(/<text:p>Plain[\s\S]*?<\/text:p>/, ""));
  });

  it("bold adds one automatic style in content.xml and toggles back off", () => {
    const pkg = openOdfPackage(buildOdt());
    const doc = openOdtDocument(pkg);
    const bold = applyOdtEdit(doc, { kind: "format", paragraph: 0, start: 0, end: 6, prop: "bold" });
    expect(bold).toMatch(/<style:style style:name="Mesa_T1" style:family="text"><style:text-properties fo:font-weight="bold"/);
    const saved = buildOdfSave(pkg, bold)!;
    const reopened = openOdtDocument(openOdfPackage(saved));
    const runs = reopened.blocks[0].kind === "paragraph" ? reopened.blocks[0].runs : [];
    expect(runs.map((r) => [r.text, !!r.bold])).toEqual([["Report", true], [" title", false]]);
    const off = applyOdtEdit(reopened, { kind: "format", paragraph: 0, start: 0, end: 6, prop: "bold" });
    const again = readOdtDocument(parseXmlTree(enc.encode(off)), null, false);
    expect(again.blocks[0].kind === "paragraph" && again.blocks[0].runs.every((r) => !r.bold)).toBe(true);
  });

  it("refuses edits inside a tracked-change region", () => {
    const body = '<text:tracked-changes><text:changed-region text:id="c1"><text:insertion><office:change-info/></text:insertion></text:changed-region></text:tracked-changes>'
      + '<text:p>Before</text:p><text:p><text:change-start text:change-id="c1"/>Inserted</text:p><text:p>Middle</text:p><text:p>End<text:change-end text:change-id="c1"/></text:p><text:p>After</text:p>';
    const pkg = openOdfPackage(buildOdt(body));
    expect(pkg.policy.trackedChanges).toBe(true);
    const doc = openOdtDocument(pkg);
    expect(doc.paragraphs.map((p) => !!p.refusal)).toEqual([false, true, true, true, false]);
    expect(() => applyOdtEdit(doc, { kind: "text", paragraph: 2, text: "x" })).toThrow(/tracked change/);
    expect(applyOdtEdit(doc, { kind: "text", paragraph: 4, text: "Later" })).toContain("<text:p>Later</text:p>");
  });
});

describe("ODS", () => {
  it("reads values, formulas, repeats and merges", () => {
    const wb = openOdsWorkbook(openOdfPackage(buildOds()));
    const [s1, s2] = wb.sheets;
    expect(cellAt(s1, 0, 0)?.display).toBe("Name");
    expect(cellAt(s1, 0, 2)).toMatchObject({ display: "6", edit: "=[.B1]*2", formula: true });
    expect(s1.usedRows).toBe(1);
    expect(s1.usedColumns).toBe(3);
    expect(s1.declaredColumns).toBe(1024);
    expect(s2.merges).toEqual([{ top: 0, left: 0, bottom: 0, right: 1 }]);
    expect(odsCellRefusal(s2, 0, 1)).toMatch(/covered/);
    expect(odsCellRefusal(s2, 0, 5)).toMatch(/outside/);
  });

  it("splits only the touched repeated run and drops cached values of edited formulas", () => {
    const pkg = openOdfPackage(buildOds());
    const wb = openOdsWorkbook(pkg);
    const edits = new Map([[cellKey(0, 5, 3), "hello  world"], [cellKey(0, 0, 2), "=SUM([.B1:.B2])"], [cellKey(0, 6, 0), "42"]]);
    const text = applyOdsEdits(wb, edits);
    expect(text).toContain('table:number-rows-repeated="4"');
    expect(text).toContain('table:number-rows-repeated="1048569"');
    expect(text).toContain('<table:table-cell table:formula="of:=SUM([.B1:.B2])"/>');
    expect(text).not.toContain('office:value="6"');
    const saved = buildOdfSave(pkg, text, (s) => checkOdsEdits(openOdsWorkbook(s), edits))!;
    const reread = openOdsWorkbook(openOdfPackage(saved));
    const s1 = reread.sheets[0];
    expect(cellAt(s1, 5, 3)?.display).toBe("hello  world");
    expect(cellAt(s1, 6, 0)).toMatchObject({ edit: "42", numeric: true });
    expect(cellAt(s1, 4, 3)?.display).toBe("");
    expect(s1.rows.reduce((n, r) => n + r.count, 0)).toBe(1_048_576);
    expect(s1.rows.find((r) => r.row === 5)!.cells.reduce((n, c) => n + c.count, 0)).toBe(1024);
    expect(cellAt(s1, 0, 0)?.display).toBe("Name");
  });

  it("refuses edits in spreadsheets with tracked changes", () => {
    const body = `<table:tracked-changes><table:cell-content-change table:id="c1"/></table:tracked-changes>${ODS_BODY}`;
    const tracked = openOdfPackage(buildOdf("spreadsheet", contentXml("spreadsheet", body.replace("<table:cell-content-change", "<table:changed-region><table:cell-content-change").replace("/></table:tracked-changes>", "/></table:changed-region></table:tracked-changes>"))));
    expect(tracked.policy.canEdit).toBe(false);
    expect(tracked.policy.refusals.join(" ")).toMatch(/tracked changes/);
  });

  it("reading is linear in sheet size", () => {
    const rows = (n: number) => `<table:table table:name="S"><table:table-column/>${"<table:table-row><table:table-cell office:value-type=\"string\"><text:p>v</text:p></table:table-cell></table:table-row>".repeat(n)}</table:table>`;
    const time = (n: number) => {
      const doc = parseXmlTree(enc.encode(contentXml("spreadsheet", rows(n))));
      let best = Infinity;
      for (let i = 0; i < 5; i++) { const t = performance.now(); readOdsWorkbook(doc, null); best = Math.min(best, performance.now() - t); }
      return best;
    };
    const big = time(16_000);
    const small = time(2_000);
    expect(big).toBeLessThan(Math.max(5, small * 8 * 4));
  });
});

describe("ODP", () => {
  it("renders slides, pictures, shapes and notes", () => {
    const deck = openOdpDeck(openOdfPackage(buildOdp()));
    expect(deck.slides).toHaveLength(2);
    expect(deck.width).toBe(28 * 360000);
    const slide = renderOdpSlide(deck, deck.slides[0]);
    const title = slide.shapes[0];
    expect(title.kind === "shape" && title.plain).toBe("Welcome deck");
    const outline = slide.shapes[1];
    expect(outline.kind === "shape" && outline.text?.paragraphs.map((p) => p.bullet?.text)).toEqual(["•", "•"]);
    expect(odpNotes(deck, deck.slides[0]).text).toBe("Speak slowly");
    const second = renderOdpSlide(deck, deck.slides[1]);
    expect(second.shapes.map((s) => s.kind)).toEqual(["picture", "shape"]);
    expect(odpNotes(deck, deck.slides[1]).editRefusal).toMatch(/no notes area/);
  });

  it("edits text box lines, adding and removing list items", () => {
    const pkg = openOdfPackage(buildOdp());
    const deck = openOdpDeck(pkg);
    const outline = renderOdpSlide(deck, deck.slides[0]).shapes[1];
    const index = outline.kind === "shape" ? outline.body!.index : -1;
    const three = editContainerText(deck, index, "Point one\nPoint 2\nPoint three");
    expect(three.match(/<text:list-item>/g)).toHaveLength(3);
    const deck3 = readOdpDeck(parseXmlTree(enc.encode(three)), null);
    const shape = renderOdpSlide(deck3, deck3.slides[0]).shapes[1];
    expect(shape.kind === "shape" && shape.plain).toBe("Point one\nPoint 2\nPoint three");
    const one = editContainerText(deck3, index, "Only");
    expect(one.match(/<text:list-item>/g)).toHaveLength(1);
    const notes = odpNotes(deck, deck.slides[0]);
    const withNotes = editContainerText(deck, notes.body!.index, "Speak clearly");
    expect(buildOdfSave(pkg, withNotes)).not.toBeNull();
  });

  it("reorders slides keeping each page's source intact", () => {
    const deck = openOdpDeck(openOdfPackage(buildOdp()));
    const moved = readOdpDeck(parseXmlTree(enc.encode(moveOdpSlide(deck, 1, 0))), null);
    expect(moved.slides.map((s) => s.name)).toEqual(["page2", "page1"]);
    expect(moved.doc.text.length).toBe(deck.doc.text.length);
  });
});
