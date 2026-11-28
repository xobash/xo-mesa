import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { buildOdf, buildOdp, buildOds, buildOdt, contentXml, ODS_BODY } from "./fixtures/odfFixtures";
import { buildOdfSave, openOdfPackage, openSavedOdfPackage } from "./odfPackage";
import { applyOdtEdit, openOdtDocument, readOdtDocument } from "./odtDocument";
import { applyOdsEdits, cellAt, cellKey, checkOdsEdits, odsCellRefusal, openOdsWorkbook, readOdsWorkbook } from "./odsSheet";
import { createOdpSlideRenderer, editContainerText, moveOdpSlide, odpNotes, openOdpDeck, readOdpDeck, renderOdpSlide } from "./odpDeck";
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

describe("ODF save hand-over", () => {
  it("hands over the package the save check opened, for that byte array only", () => {
    const pkg = openOdfPackage(buildOdt());
    const doc = openOdtDocument(pkg);
    let checked: ReturnType<typeof openOdfPackage> | null = null;
    const bytes = buildOdfSave(pkg, applyOdtEdit(doc, { kind: "text", paragraph: 0, text: "New title" }), (saved) => { checked = saved; })!;
    const adopted = openSavedOdfPackage(bytes);
    expect(adopted).toBe(checked);
    expect(adopted.original).toBe(bytes);
    expect(openOdtDocument(adopted).paragraphs[0].plain).toBe("New title");
    // An equal copy, and the opened file itself, are read from their own bytes.
    const copy = openSavedOdfPackage(bytes.slice());
    expect(copy).not.toBe(checked);
    expect(copy.content.text).toBe(adopted.content.text);
    expect(openSavedOdfPackage(pkg.original)).not.toBe(pkg);
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

  it("gives every paragraph its display runs, table cells included", () => {
    const doc = odt();
    const cells = doc.blocks.flatMap((b) => (b.kind === "table" ? b.rows.flat(2) : []));
    expect(cells.map((index) => doc.runs[index].map((r) => r.text).join(""))).toEqual(["A1", "B1"]);
    for (const block of doc.blocks) if (block.kind === "paragraph") expect(block.runs).toBe(doc.runs[block.index]);
    expect(doc.runs).toHaveLength(doc.paragraphs.length);
  });

  it("reads a model from the one before it without changing the result", () => {
    const comparable = (model: ReturnType<typeof odt>) => ({
      paragraphs: model.paragraphs.map((p) => ({ items: p.items, plain: p.plain, refusal: p.refusal, start: p.el.start, end: p.el.end })),
      paragraphStyle: model.paragraphStyle, runs: model.runs, blocks: model.blocks,
    });
    const tracked = '<text:tracked-changes><text:changed-region text:id="c1"><text:insertion/></text:changed-region></text:tracked-changes>'
      + '<text:p>Before</text:p><text:p>A <text:change-start text:change-id="c1"/>new<text:change-end text:change-id="c1"/> word</text:p><text:p>After <text:span text:style-name="T1">it</text:span></text:p>';
    for (const [body, trackedChanges] of [[undefined, false], [tracked, true]] as const) {
      const pkg = openOdfPackage(buildOdt(body));
      const first = readOdtDocument(pkg.content, pkg.styles, trackedChanges);
      const last = first.paragraphs.length - 1;
      const edits = [
        applyOdtEdit(first, { kind: "text", paragraph: 0, text: "A longer first paragraph" }),
        applyOdtEdit(first, { kind: "text", paragraph: last, text: "" }),
        applyOdtEdit(first, { kind: "format", paragraph: 0, start: 0, end: 3, prop: "bold" }),
      ];
      for (const text of edits) {
        const doc = parseXmlTree(enc.encode(text));
        const fresh = readOdtDocument(doc, pkg.styles, trackedChanges);
        const carried = readOdtDocument(doc, pkg.styles, trackedChanges, first);
        expect(comparable(carried)).toEqual(comparable(fresh));
        for (const p of carried.paragraphs) expect(carried.doc.text.slice(p.el.start, p.el.end)).toMatch(/^<text:[ph][ >/]/);
      }
      // A text edit keeps the run arrays of the other paragraphs; a new style or another styles part keeps none of them.
      const typed = parseXmlTree(enc.encode(edits[0]));
      const afterText = readOdtDocument(typed, pkg.styles, trackedChanges, first);
      expect(afterText.runs.map((runs, i) => runs === first.runs[i])).toEqual(first.runs.map((_, i) => i !== 0));
      const afterFormat = readOdtDocument(parseXmlTree(enc.encode(edits[2])), pkg.styles, trackedChanges, first);
      expect(afterFormat.runs.some((runs, i) => runs === first.runs[i])).toBe(false);
      expect(readOdtDocument(typed, null, trackedChanges, first).runs.some((runs, i) => runs === first.runs[i])).toBe(false);
    }
  });

  it("reads one paragraph, not every paragraph, after an edit in a long document", () => {
    const body = Array.from({ length: 6000 }, (_, i) => `<text:p>Paragraph ${i} with <text:span text:style-name="T1">styled words</text:span> and a tail of prose.</text:p>`).join("");
    const pkg = openOdfPackage(buildOdt(body));
    const first = readOdtDocument(pkg.content, pkg.styles, false);
    const doc = parseXmlTree(enc.encode(applyOdtEdit(first, { kind: "text", paragraph: 3000, text: "typed" })));
    const best = (previous: typeof first | null) => {
      let ms = Infinity;
      for (let i = 0; i < 5; i++) { const t = performance.now(); readOdtDocument(doc, pkg.styles, false, previous); ms = Math.min(ms, performance.now() - t); }
      return ms;
    };
    // Measured at 10,000 paragraphs: 36 ms without the model before, 12 ms with it.
    expect(best(first)).toBeLessThan(Math.max(4, best(null) * 0.7));
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

  it("keeps the model of every slide an edit did not change", () => {
    const pages = Array.from({ length: 6 }, (_, i) => `<draw:page draw:name="page${i}" draw:master-page-name="Default">`
      + `<draw:frame presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>Title ${i}</text:p></draw:text-box></draw:frame>`
      + `<draw:custom-shape svg:x="6cm" svg:y="5cm" svg:width="4cm" svg:height="3cm"><text:p>Shape</text:p></draw:custom-shape></draw:page>`).join("");
    const pkg = openOdfPackage(buildOdp(pages));
    const deck = openOdpDeck(pkg);
    const render = createOdpSlideRenderer();
    const before = render(deck);
    expect(before).toEqual(deck.slides.map((s) => renderOdpSlide(deck, s)));

    const title2 = before[2].shapes[0];
    const typed = readOdpDeck(parseXmlTree(enc.encode(editContainerText(deck, title2.kind === "shape" ? title2.body!.index : -1, "A much longer title for slide two"))), pkg.styles);
    const after = render(typed);
    expect(after).toEqual(typed.slides.map((s) => renderOdpSlide(typed, s)));
    expect(after.map((model, i) => model === before[i])).toEqual([true, true, false, true, true, true]);
    // Text boxes after the edited slide still point at their own containers.
    const title5 = after[5].shapes[0];
    expect(typed.containers[title5.kind === "shape" ? title5.body!.index : -1]).toBe(typed.slides[5].el.children[0].children[0]);

    // A move changes which containers a slide owns; a new opened package gets its own renderer.
    const moved = readOdpDeck(parseXmlTree(enc.encode(moveOdpSlide(typed, 0, 5))), pkg.styles);
    expect(render(moved)).toEqual(moved.slides.map((s) => renderOdpSlide(moved, s)));
    expect(render(typed)).toEqual(typed.slides.map((s) => renderOdpSlide(typed, s)));
  });

  it("reorders slides keeping each page's source intact", () => {
    const deck = openOdpDeck(openOdfPackage(buildOdp()));
    const moved = readOdpDeck(parseXmlTree(enc.encode(moveOdpSlide(deck, 1, 0))), null);
    expect(moved.slides.map((s) => s.name)).toEqual(["page2", "page1"]);
    expect(moved.doc.text.length).toBe(deck.doc.text.length);
  });
});
