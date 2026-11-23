import { describe, expect, it } from "vitest";
import { parseRtfDocument, rtfBytesFromSource, rtfSourceFromBytes, type RtfDocument, type RtfFormat } from "./rtfDocument";
import { buildRtfEdit, type RtfEditUnit } from "./rtfEdit";

const TEXTEDIT = [
  "{\\rtf1\\ansi\\ansicpg1252\\cocoartf2761",
  "\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;\\f1\\fswiss\\fcharset0 Helvetica-Bold;}",
  "{\\colortbl;\\red255\\green255\\blue255;\\red251\\green0\\blue7;}",
  "{\\*\\expandedcolortbl;;\\cssrgb\\c100000\\c0\\c0;}",
  "\\paperw11900\\paperh16840\\margl1440\\margr1440\\vieww11520\\viewh8400\\viewkind0",
  "\\pard\\tx566\\tx1133\\pardirnatural\\partightenfactor0",
  "",
  "\\f0\\fs24 \\cf0 Hello \\f1\\b world\\f0\\b0 . Caf\\'e9 \\uc0\\u8212  done\\",
  "\\cf2 Red line\\",
  "{\\field{\\*\\fldinst{HYPERLINK \"https://example.com\"}}{\\fldrslt \\cf0 link}}",
  "\\pard\\qc tail}",
].join("\n");

const WORD = [
  "{\\rtf1\\adeflang1025\\ansi\\ansicpg1252\\uc1\\adeff31507\\deff0\\stshfdbch31505\\stshfloch31506",
  "{\\fonttbl{\\f0\\fbidi \\froman\\fcharset0\\fprq2{\\*\\panose 02020603050405020304}Times New Roman;}",
  "{\\f39\\fbidi \\froman\\fcharset238\\fprq2 Times New Roman CE;}}",
  "{\\colortbl;\\red0\\green0\\blue0;\\red0\\green0\\blue255;}",
  "{\\stylesheet{\\ql \\li0\\ri0\\widctlpar\\wrapdefault\\aspalpha\\faauto\\adjustright\\rin0\\lin0\\itap0 \\rtlch\\fcs1 \\af31507\\afs24\\alang1025 \\ltrch\\fcs0 \\f31506\\fs24\\lang1033\\langfe1033\\cgrid\\langnp1033\\langfenp1033 \\snext0 \\sqformat \\spriority0 Normal;}}",
  "{\\*\\rsidtbl \\rsid1203432}{\\*\\generator Microsoft Word 16.0;}{\\info{\\author A}{\\creatim\\yr2026\\mo1\\dy2}}",
  "\\paperw12240\\paperh15840\\margl1440\\margr1440\\sectd \\ltrsect\\linex0\\sectdefaultcl\\sftnbj",
  "\\pard\\plain \\ltrpar\\ql \\li0\\ri0\\sa160\\sl259\\slmult1\\widctlpar\\wrapdefault\\aspalpha\\aspnum\\faauto\\adjustright\\rin0\\lin0\\itap0 \\rtlch\\fcs1 \\af31507\\afs22\\alang1025 \\ltrch\\fcs0 \\f0\\fs22\\lang1033\\langfe1033\\cgrid\\langnp1033\\langfenp1033 {\\rtlch\\fcs1 \\af31507 \\ltrch\\fcs0 \\insrsid1203432 First paragraph with }{\\rtlch\\fcs1 \\ab\\af31507 \\ltrch\\fcs0 \\b\\insrsid1203432 bold}{\\rtlch\\fcs1 \\af31507 \\ltrch\\fcs0 \\insrsid1203432  and \\u8220\\'93quotes\\u8221\\'94.",
  "\\par }{\\rtlch\\fcs1 \\af31507 \\ltrch\\fcs0 \\insrsid1203432 {\\*\\shppict{\\pict{\\*\\picprop}\\pngblip 89504e47}}{\\nonshppict{\\pict\\wmetafile8 0100}}Second.",
  "\\par }{\\*\\themedata 504b0304}{\\*\\latentstyles\\lsdstimax376{\\lsdlockedexcept \\lsdqformat1 Normal;}}}",
].join("\r\n");

const WORDPAD = [
  "{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat\\deflang1033{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}}",
  "{\\*\\generator Riched20 10.0.19041}\\viewkind4\\uc1 ",
  "\\pard\\sa200\\sl276\\slmult1\\f0\\fs22\\lang9 Plain WordPad text\\par",
  "{\\pntext\\f0 1.\\tab}{\\*\\pn\\pnlvlbody\\pnf0\\pnindent0\\pnstart1\\pndec{\\pntxta.}}",
  "\\fi-360\\li720\\sa200\\sl276\\slmult1 Numbered item\\par",
  "\\pard\\sa200\\sl276\\slmult1\\i Italic\\i0  end\\par",
  "}",
  "\u0000",
].join("\r\n");

/** The content as an edit sequence, the shape the editor reads from its DOM. */
function units(doc: RtfDocument): RtfEditUnit[] {
  return doc.units.map((u) => (u.kind === "char" ? { kind: "char", ch: u.ch, fmt: u.fmt } : u.kind === "par" ? { kind: "par" } : { kind: "atom", id: u.id }));
}
const text = (doc: RtfDocument) => doc.units.map((u) => (u.kind === "char" ? u.ch : u.kind === "par" ? "¶" : u.text || u.label)).join("");
const chars = (s: string, fmt: RtfFormat): RtfEditUnit[] => [...s].map((ch) => ({ kind: "char", ch, fmt }));

describe.each([["TextEdit", TEXTEDIT], ["Word", WORD], ["WordPad", WORDPAD]])("%s RTF", (_name, source) => {
  it("is editable and round-trips byte for byte when unchanged", () => {
    const doc = parseRtfDocument(source);
    expect(doc.readOnlyReason).toBeNull();
    expect(buildRtfEdit(doc, units(doc))).toBeNull();
    expect(rtfSourceFromBytes(rtfBytesFromSource(source))).toBe(source);
  });

  it("changes only the edited text and keeps every header group", () => {
    const doc = parseRtfDocument(source);
    const next = units(doc);
    const at = next.findIndex((u) => u.kind === "char" && /[A-Za-z]/.test(u.ch));
    const fmt = (next[at] as { fmt: RtfFormat }).fmt;
    next.splice(at, 1, ...chars("Ünï{c}\\", fmt));
    const out = buildRtfEdit(doc, next)!;
    const removed = doc.units.find((u) => u.kind === "char" && /[A-Za-z]/.test(u.ch))!;
    expect(out.slice(0, removed.start)).toBe(source.slice(0, removed.start));
    expect(out.endsWith(source.slice(removed.end))).toBe(true);
    for (const group of source.match(/\{\\(fonttbl|colortbl|stylesheet|info)[^]*?\}\}?/g) ?? []) expect(out).toContain(group);
    const reparsed = parseRtfDocument(out);
    expect(text(reparsed)).toBe(text(doc).replace(/[A-Za-z]/, "Ünï{c}\\"));
  });
});

describe("RTF model", () => {
  it("reads formatting, colours, fields and paragraph styles", () => {
    const doc = parseRtfDocument(TEXTEDIT);
    expect(text(doc)).toBe("Hello world. Café — done¶Red line¶linktail");
    const w = doc.units.find((u) => u.kind === "char" && u.ch === "w")!;
    expect(w.fmt).toMatchObject({ b: true, f: 1, fs: 24 });
    const r = doc.units.find((u) => u.kind === "char" && u.ch === "R")!;
    expect(doc.colors[r.fmt.cf]).toBe("rgb(251, 0, 7)");
    expect(doc.paragraphs.at(-1)?.align).toBe("center");
    expect(doc.fonts.get(1)?.name).toBe("Helvetica-Bold");
  });

  it("shows Word pictures as objects and decodes Windows-1252 fallbacks once", () => {
    const doc = parseRtfDocument(WORD);
    expect(text(doc)).toBe("First paragraph with bold and “quotes”.¶[picture]Second.¶");
  });

  it.each([
    ["{\\rtf1 a\\cell b}", "table"],
    ["{\\rtf1 a\\page b}", "page breaks"],
    ["{\\rtf1\\ansi\\ansicpg1251 \\'e0}", "code page 1251"],
    ["{\\rtf1 café}", "raw 8-bit"],
    ["{\\rtf1 {open}", "not balanced"],
    ["plain text", "not an RTF"],
    ["{\\rtf1 {\\fonttbl{\\f1\\fcharset128 MS Mincho;}}\\f1 \\'82\\'a0}", "charset 128"],
  ])("opens %s read-only with a reason", (source, reason) => {
    expect(parseRtfDocument(source).readOnlyReason).toContain(reason);
  });

  it("keeps an embedded picture's bytes when text around it changes, and removes it whole when deleted", () => {
    const doc = parseRtfDocument(WORD);
    const pict = WORD.slice(WORD.indexOf("{\\*\\shppict"), WORD.indexOf("{\\nonshppict"));
    const next = units(doc);
    const s = next.findIndex((u) => u.kind === "char" && u.ch === "S");
    (next[s] as { ch: string }).ch = "Z";
    const edited = buildRtfEdit(doc, next)!;
    expect(edited).toContain(pict);
    expect(text(parseRtfDocument(edited))).toContain("[picture]Zecond.");
    const withoutPicture = units(doc).filter((u) => u.kind !== "atom");
    const out = buildRtfEdit(doc, withoutPicture)!;
    expect(out).not.toContain("pngblip");
    expect(out).toContain("{\\nonshppict{\\pict\\wmetafile8 0100}}");
    expect(text(parseRtfDocument(out))).toBe(text(doc).replace("[picture]", ""));
  });

  it("applies bold to a range and splits a paragraph without touching other paragraphs", () => {
    const doc = parseRtfDocument(WORDPAD);
    const next = units(doc);
    const plain = next.findIndex((u) => u.kind === "char" && u.ch === "P");
    for (let k = plain; k < plain + 5; k++) {
      const unit = next[k] as { fmt: RtfFormat };
      unit.fmt = { ...unit.fmt, b: true };
    }
    next.splice(plain + 5, 0, { kind: "par" });
    const out = buildRtfEdit(doc, next)!;
    const reparsed = parseRtfDocument(out);
    expect(text(reparsed)).toBe(text(doc).replace("Plain WordPad", "Plain¶ WordPad"));
    const p = reparsed.units.find((u) => u.kind === "char" && u.ch === "P")!;
    const w = reparsed.units.find((u) => u.kind === "char" && u.ch === "W")!;
    expect([p.fmt.b, w.fmt.b, p.fmt.fs]).toEqual([true, false, 22]);
    expect(out).toContain("\\pard\\sa200\\sl276\\slmult1\\i Italic\\i0  end\\par");
    expect(reparsed.paragraphs[0]).toMatchObject({ sa: 200 });
  });

  it("deleting a paragraph break keeps the formatting state that follows", () => {
    const source = "{\\rtf1 one\\par \\b two\\par three}";
    const doc = parseRtfDocument(source);
    const next = units(doc);
    next.splice(next.findIndex((u) => u.kind === "par"), 1);
    const out = buildRtfEdit(doc, next)!;
    expect(out).toBe("{\\rtf1 one\\b two\\par three}");
    expect(parseRtfDocument(out).units.at(-1)!.fmt.b).toBe(true);
  });

  it("never joins a delimiter-less control word to following text", () => {
    const source = "{\\rtf1 x\\b\\par old}";
    const doc = parseRtfDocument(source);
    const out = buildRtfEdit(doc, units(doc).filter((u) => u.kind !== "par"))!;
    expect(text(parseRtfDocument(out))).toBe("xold");
  });

  it("types into an empty document at the end of the body", () => {
    const doc = parseRtfDocument("{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\f0\\fs20 }");
    const out = buildRtfEdit(doc, chars("Hi", { ...doc.endFmt, b: true }))!;
    expect(out).toBe("{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\f0\\fs20 {\\b Hi}}");
  });

  it("refuses to build an edit for a read-only document", () => {
    const doc = parseRtfDocument("{\\rtf1 a\\cell b}");
    expect(() => buildRtfEdit(doc, [])).toThrow(/read-only/);
  });
});
