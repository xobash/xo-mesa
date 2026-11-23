import { describe, expect, it } from "vitest";
import { strToU8 } from "fflate";
import { openOoxmlPackage, type OoxmlPackage } from "../ooxml/ooxmlPackage";
import { buildPackage, relationships } from "../ooxml/fixtures/ooxmlFixtures";
import { buildDeck, deckParts, NOTES_TEXT, SLIDE1_TITLE } from "./fixtures/pptxFixtures";
import { loadDeck, overlayView, xmlOf, type PartView } from "./pptxDeck";
import { renderNotes, renderSlide, type RenderShape } from "./pptxRender";
import { buildPresentationSave, danglingRelationships, openPresentation, untypedParts } from "./pptxSession";
import { deleteSlide, duplicateSlide, moveSlide, reachableParts, type PartChanges } from "./pptxStructure";
import { editTextBody, PptxEditRefusal } from "./pptxTextEdit";
import { encodeXmlPart } from "./xmlTree";
import { firstAlteredEntry, readZipContainer } from "../ooxml/zipContainer";

const decoder = new TextDecoder();

function open(bytes = buildDeck()) {
  return openPresentation(bytes, "pptx");
}

function textEdit(view: PartView, part: string, index: number, text: string): PartChanges {
  const doc = xmlOf(view, part)!;
  return new Map([[part, encodeXmlPart(doc, editTextBody(doc, index, text))]]);
}

function changedParts(before: OoxmlPackage, afterBytes: Uint8Array): { changed: string[]; added: string[]; removed: string[] } {
  const after = openOoxmlPackage(afterBytes);
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [name, bytes] of before.parts) {
    const now = after.parts.get(name);
    if (!now) removed.push(name);
    else if (decoder.decode(now) !== decoder.decode(bytes) || now.length !== bytes.length) changed.push(name);
  }
  const added = [...after.parts.keys()].filter((name) => !before.parts.has(name));
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

function shapeTexts(shapes: readonly RenderShape[]): string[] {
  return shapes.flatMap((s) => (s.kind === "shape" && s.text ? [s.text.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n")] : []));
}

function overridesPointAtParts(bytes: Uint8Array): void {
  const pkg = openOoxmlPackage(bytes);
  const types = decoder.decode(pkg.parts.get("[Content_Types].xml")!);
  for (const match of types.matchAll(/PartName="\/([^"]+)"/g)) expect(pkg.parts.has(match[1]), match[1]).toBe(true);
  expect(danglingRelationships(pkg).size).toBe(0);
  expect(untypedParts(pkg).size).toBe(0);
}

describe("presentation viewer model", () => {
  it("reads slide order, size, hidden slides, notes and layout inheritance", () => {
    const { deck, pkg } = open();
    expect(deck.width).toBe(12_192_000);
    expect(deck.slides.map((s) => s.part)).toEqual([1, 2, 3, 4].map((n) => `ppt/slides/slide${n}.xml`));
    expect(deck.slides.map((s) => s.hidden)).toEqual([false, false, false, true]);
    const first = renderSlide(pkg, deck, deck.slides[0]);
    expect(shapeTexts(first.shapes)).toEqual([SLIDE1_TITLE, "Revenue up 12%\nCosts flat\nHiring & growth"]);
    const title = first.shapes[0];
    // Position comes from the layout placeholder; size and colour from the master title style.
    expect(title.kind === "shape" && title.box.y).toBe(365_125);
    expect(title.kind === "shape" && title.text?.paragraphs[0].runs[0].size).toBe(4400);
    expect(title.kind === "shape" && title.text?.paragraphs[0].runs[0].font).toBe("Calibri Light");
    const body = first.shapes[1];
    expect(body.kind === "shape" && body.text?.paragraphs.map((p) => p.bullet?.text)).toEqual(["•", "–", "•"]);
    expect(body.kind === "shape" && body.text?.paragraphs[0].runs[0].bold).toBe(true);
    expect(first.background).toEqual({ color: "#ffffff" });
    expect(renderNotes(pkg, deck.slides[0]).text).toBe(NOTES_TEXT);
    expect(renderNotes(pkg, deck.slides[1]).body).toBeNull();
  });

  it("gives text with no colour anywhere the theme text colour, not the app's", () => {
    const { deck, pkg } = open();
    const body = renderSlide(pkg, deck, deck.slides[0]).shapes[1];
    // Neither the run, the layout nor the master body style names a colour, so
    // PowerPoint draws it in tx1 (dk1 = windowText 000000). Leaving it unset
    // let the slide inherit Mesa's light UI text colour on a white slide.
    expect(body.kind === "shape" && body.text?.paragraphs[0].runs[1].color).toBe("#000000");
  });

  it("draws pictures from the package and labels charts and video instead of omitting them", () => {
    const { deck, pkg } = open();
    const picture = renderSlide(pkg, deck, deck.slides[1]).shapes.find((s) => s.kind === "picture");
    expect(picture).toMatchObject({ image: "ppt/media/image1.png", label: null });
    const third = renderSlide(pkg, deck, deck.slides[2]).shapes;
    expect(third.find((s) => s.kind === "placeholder")).toMatchObject({ label: "Chart (not displayed)" });
    expect(third.find((s) => s.kind === "picture")).toMatchObject({ image: "ppt/media/image1.png", label: "Video" });
    const box = renderSlide(pkg, deck, deck.slides[1]).shapes.find((s) => s.kind === "shape");
    // accent1 4472C4 at lumMod 20% / lumOff 80%.
    expect(box?.kind === "shape" && box.fill).toEqual({ color: "#dae3f3" });
  });
});

describe("presentation saves", () => {
  it("writes nothing when nothing changed, including a same-text edit", () => {
    const { pkg } = open();
    expect(buildPresentationSave(pkg, new Map())).toBeNull();
    const same = textEdit(pkg, "ppt/slides/slide1.xml", 0, SLIDE1_TITLE);
    expect(buildPresentationSave(pkg, same)).toBeNull();
  });

  it("a text edit changes only that slide part and keeps run properties", () => {
    const { pkg } = open();
    const changes = textEdit(pkg, "ppt/slides/slide1.xml", 1, "Revenue up 15%\nCosts flat\nHiring & growth");
    const bytes = buildPresentationSave(pkg, changes)!;
    expect(changedParts(pkg, bytes)).toEqual({ changed: ["ppt/slides/slide1.xml"], added: [], removed: [] });
    const xml = decoder.decode(openOoxmlPackage(bytes).parts.get("ppt/slides/slide1.xml")!);
    expect(xml).toContain('<a:r><a:rPr lang="en-US" b="1"/><a:t>Revenue </a:t></a:r><a:r><a:rPr lang="en-US"/><a:t>up 15%</a:t></a:r>');
    expect(xml).toContain("<a:t>Hiring &amp; growth</a:t>");
    const original = decoder.decode(pkg.parts.get("ppt/slides/slide1.xml")!);
    expect(xml.length - original.length).toBe(0);
  });

  it("a new paragraph copies the previous paragraph's properties and text is escaped", () => {
    const { pkg } = open();
    const changes = textEdit(pkg, "ppt/slides/slide1.xml", 1, "Revenue up 12%\nCosts flat\nA <b> & c\nHiring & growth");
    const xml = decoder.decode(changes.get("ppt/slides/slide1.xml")!);
    expect(xml).toContain('<a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US" i="1"/><a:t>A &lt;b&gt; &amp; c</a:t></a:r><a:endParaRPr lang="en-US" i="1"/></a:p>');
  });

  it("deleting paragraphs keeps at least the edited ones and removes only those lines", () => {
    const { pkg } = open();
    const xml = decoder.decode(textEdit(pkg, "ppt/slides/slide1.xml", 1, "Revenue up 12%").get("ppt/slides/slide1.xml")!);
    expect(xml).not.toContain("Costs flat");
    expect(xml).not.toContain("Hiring");
    expect(xml).toContain("<a:t>Revenue </a:t>");
  });

  it("a notes edit changes only the notes part", () => {
    const { pkg, deck } = open();
    const notes = renderNotes(pkg, deck.slides[0]);
    const bytes = buildPresentationSave(pkg, textEdit(pkg, notes.body!.part, notes.body!.index, "Mention hiring and costs."))!;
    expect(changedParts(pkg, bytes)).toEqual({ changed: ["ppt/notesSlides/notesSlide1.xml"], added: [], removed: [] });
    const reopened = open(bytes);
    expect(renderNotes(reopened.pkg, reopened.deck.slides[0]).text).toBe("Mention hiring and costs.");
  });

  it("refuses text with line breaks or fields, with a reason", () => {
    const body = '<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>One</a:t></a:r><a:br/><a:r><a:t>Two</a:t></a:r></a:p></p:txBody></p:sp>';
    const parts = deckParts();
    parts["ppt/slides/slide4.xml"] = (parts["ppt/slides/slide4.xml"] as string).replace("<p:grpSpPr/>", `<p:grpSpPr/>${body}`);
    const { pkg, deck } = open(buildPackage(parts));
    const shape = renderSlide(pkg, deck, deck.slides[3]).shapes.find((s) => s.kind === "shape" && s.plain === "One Two");
    expect(shape?.kind === "shape" && shape.editRefusal).toMatch(/line break/);
    expect(() => textEdit(pkg, "ppt/slides/slide4.xml", 0, "x")).toThrow(PptxEditRefusal);
  });
});

describe("slide structure edits", () => {
  it("reordering changes only presentation.xml", () => {
    const { pkg, deck } = open();
    const bytes = buildPresentationSave(pkg, moveSlide(pkg, deck, 0, 2))!;
    expect(changedParts(pkg, bytes)).toEqual({ changed: ["ppt/presentation.xml"], added: [], removed: [] });
    expect(open(bytes).deck.slides.map((s) => s.part.match(/\d+/)![0])).toEqual(["2", "3", "1", "4"]);
  });

  it("deleting a slide removes its entry, relationship, part, notes and override, and nothing shared", () => {
    const { pkg, deck } = open();
    const bytes = buildPresentationSave(pkg, deleteSlide(pkg, deck, 0))!;
    const diff = changedParts(pkg, bytes);
    expect(diff.removed).toEqual([
      "ppt/notesSlides/_rels/notesSlide1.xml.rels", "ppt/notesSlides/notesSlide1.xml",
      "ppt/slides/_rels/slide1.xml.rels", "ppt/slides/slide1.xml",
    ]);
    expect(diff.changed).toEqual(["[Content_Types].xml", "ppt/_rels/presentation.xml.rels", "ppt/presentation.xml"]);
    expect(diff.added).toEqual([]);
    overridesPointAtParts(bytes);
    const reopened = open(bytes);
    expect(reopened.deck.slides.map((s) => s.part)).toEqual([2, 3, 4].map((n) => `ppt/slides/slide${n}.xml`));
    expect(reachableParts(reopened.pkg).has("ppt/notesMasters/notesMaster1.xml")).toBe(true);
  });

  it("deleting a slide drops its chart and media but keeps a picture another slide uses", () => {
    const { pkg, deck } = open();
    const bytes = buildPresentationSave(pkg, deleteSlide(pkg, deck, 2))!;
    const { removed } = changedParts(pkg, bytes);
    expect(removed).toEqual(["ppt/charts/chart1.xml", "ppt/media/media1.mp4", "ppt/slides/_rels/slide3.xml.rels", "ppt/slides/slide3.xml"]);
    overridesPointAtParts(bytes);
  });

  it("refuses deletes that would leave references dangling", () => {
    const linked = deckParts({
      "ppt/slides/_rels/slide4.xml.rels": relationships([
        { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
        { id: "rId9", type: "slide", target: "slide1.xml" },
      ]),
    });
    const a = open(buildPackage(linked));
    expect(() => deleteSlide(a.pkg, a.deck, 0)).toThrow(/Another slide links/);
    const shows = open(buildDeck({}, '<p:custShowLst><p:custShow name="Short" id="0"><p:sldLst><p:sld r:id="rId2"/></p:sldLst></p:custShow></p:custShowLst>'));
    expect(() => deleteSlide(shows.pkg, shows.deck, 0)).toThrow(/custom show/);
    const sections = open(buildDeck({}, '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"/></p:ext></p:extLst>'));
    expect(() => deleteSlide(sections.pkg, sections.deck, 0)).toThrow(/sections/);
    expect(() => moveSlide(sections.pkg, sections.deck, 0, 1)).toThrow(/sections/);
  });

  it("duplicates a slide with its own notes page right after the original", () => {
    const { pkg, deck } = open();
    const changes = duplicateSlide(pkg, deck, 0);
    const bytes = buildPresentationSave(pkg, changes)!;
    const diff = changedParts(pkg, bytes);
    expect(diff.added).toEqual([
      "ppt/notesSlides/_rels/notesSlide2.xml.rels", "ppt/notesSlides/notesSlide2.xml",
      "ppt/slides/_rels/slide5.xml.rels", "ppt/slides/slide5.xml",
    ]);
    expect(diff.removed).toEqual([]);
    overridesPointAtParts(bytes);
    const reopened = open(bytes);
    expect(reopened.deck.slides.map((s) => s.part)).toEqual(["ppt/slides/slide1.xml", "ppt/slides/slide5.xml", "ppt/slides/slide2.xml", "ppt/slides/slide3.xml", "ppt/slides/slide4.xml"]);
    expect(reopened.deck.slides[1]).toMatchObject({ notesPart: "ppt/notesSlides/notesSlide2.xml", sldId: 260 });
    expect(reopened.deck.slides[0].notesPart).toBe("ppt/notesSlides/notesSlide1.xml");
    expect(reopened.pkg.parts.get("ppt/slides/slide5.xml")).toEqual(pkg.parts.get("ppt/slides/slide1.xml"));
    const notesRels = decoder.decode(reopened.pkg.parts.get("ppt/notesSlides/_rels/notesSlide2.xml.rels")!);
    expect(notesRels).toContain('Target="../slides/slide5.xml"');
  });

  it("refuses to duplicate a slide whose parts cannot be shared", () => {
    const { pkg, deck } = open();
    expect(() => duplicateSlide(pkg, deck, 2)).toThrow(/chart part/);
  });

  it("chained edits on an overlay save as one consistent package", () => {
    const { pkg, deck } = open();
    const first = moveSlide(pkg, deck, 3, 0);
    const view = overlayView(pkg, first);
    const second = deleteSlide(view, loadDeck(view, deck.presentationPart), 3);
    const bytes = buildPresentationSave(pkg, new Map([...first, ...second]))!;
    overridesPointAtParts(bytes);
    expect(open(bytes).deck.slides.map((s) => s.part.match(/\d+/)![0])).toEqual(["4", "1", "2"]);
  });
});

describe("presentation capability gate", () => {
  it("allows editing with warnings for charts and refuses macro-enabled or signed files", () => {
    const plain = open();
    expect(plain.policy.canEdit).toBe(true);
    expect(plain.policy.warnings.join(" ")).toMatch(/charts/);
    expect(openPresentation(buildDeck(), "pptm").policy).toMatchObject({ canEdit: false });
    const signed = open(buildDeck({ "_xmlsignatures/sig1.xml": "<Signature/>" }));
    expect(signed.policy.canEdit).toBe(false);
    expect(signed.policy.refusals.join(" ")).toMatch(/digitally signed/);
  });

  it("refuses a package that is not a presentation", () => {
    const parts = deckParts();
    parts["[Content_Types].xml"] = (parts["[Content_Types].xml"] as string).replace("presentation.main+xml", "nothing+xml");
    expect(() => open(buildPackage(parts))).toThrow(/not a PowerPoint presentation/);
    expect(() => open(strToU8("not a zip"))).toThrow();
  });

  it("opens and saves with a picture that fails its checksum, copying it untouched", () => {
    const bytes = buildDeck();
    const entry = readZipContainer(bytes).entries.find((e) => e.name === "ppt/media/image1.png")!;
    const corrupt = bytes.slice();
    new DataView(corrupt.buffer).setUint32(entry.localStart + 14, entry.crc ^ 1, true);
    new DataView(corrupt.buffer).setUint32(entry.centralStart + 16, entry.crc ^ 1, true);
    const opened = open(corrupt);
    expect(opened.deck.slides).toHaveLength(4);
    expect(() => opened.pkg.parts.get("ppt/media/image1.png")).toThrow(/checksum/);
    const saved = buildPresentationSave(opened.pkg, textEdit(opened.pkg, "ppt/slides/slide1.xml", 0, "Renamed"))!;
    expect(firstAlteredEntry(opened.pkg.container, readZipContainer(saved), (name) => name === "ppt/slides/slide1.xml")).toBeNull();
  });

  it("loads a deck in time linear in its slide count", () => {
    const deck = (count: number) => {
      const parts = deckParts();
      const ids: string[] = [];
      const rels = [{ id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" }];
      for (let i = 1; i <= count; i++) {
        parts[`ppt/slides/many${i}.xml`] = parts["ppt/slides/slide4.xml"];
        parts[`ppt/slides/_rels/many${i}.xml.rels`] = parts["ppt/slides/_rels/slide4.xml.rels"];
        rels.push({ id: `rId${i + 100}`, type: "slide", target: `slides/many${i}.xml` });
        ids.push(`<p:sldId id="${1000 + i}" r:id="rId${i + 100}"/>`);
      }
      parts["ppt/presentation.xml"] = (parts["ppt/presentation.xml"] as string).replace(/<p:sldIdLst>.*<\/p:sldIdLst>/, `<p:sldIdLst>${ids.join("")}</p:sldIdLst>`);
      parts["ppt/_rels/presentation.xml.rels"] = relationships(rels);
      return buildPackage(parts);
    };
    const large = deck(800);
    const small = deck(100);
    const time = (run: () => void) => { const t = performance.now(); run(); return performance.now() - t; };
    let best = Infinity;
    let bestSmall = Infinity;
    // Interleaved, best of five; the 4x bound separates linear from quadratic work.
    for (let round = 0; round < 5; round++) {
      best = Math.min(best, time(() => expect(open(large).deck.slides).toHaveLength(800)));
      bestSmall = Math.min(bestSmall, time(() => { for (let i = 0; i < 8; i++) open(small); }));
    }
    expect(best).toBeLessThan(bestSmall * 4);
  }, 60_000);
});
