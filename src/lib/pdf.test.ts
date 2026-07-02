import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  readPdfPages,
  rotatePage,
  deletePage,
  movePage,
  reorderPages,
  addText,
  replaceText,
  addHighlight,
  addInkStroke,
  addBlankPage,
  getFormFields,
  setFormField,
  assertValidPdfBytes,
  copyPdfBytes,
  findPdfHeader,
  hasPdfEofMarker,
  isLikelyBlankPdfPaint,
  pdfBytesEqual,
  sanitizePdfBytes,
  sniffFileType,
} from "./pdf";

/** Build a fresh N-page PDF; each page tagged so we can track reordering. */
async function makePdf(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const page = doc.addPage([200, 300]);
    page.drawText(`PAGE_${i}`, { x: 20, y: 250, size: 12, font });
  }
  return doc.save();
}

describe("pdf editing core", () => {
  it("reads page geometry", async () => {
    const info = await readPdfPages(await makePdf(3));
    expect(info).toHaveLength(3);
    expect(info[0]).toMatchObject({ index: 0, width: 200, height: 300, rotation: 0 });
  });

  it("rotates a page by 90 and wraps at 360", async () => {
    let bytes = await rotatePage(await makePdf(1), 0, 90);
    expect((await readPdfPages(bytes))[0].rotation).toBe(90);
    bytes = await rotatePage(bytes, 0, 270);
    expect((await readPdfPages(bytes))[0].rotation).toBe(0);
  });

  it("deletes a page but never the last one", async () => {
    const two = await deletePage(await makePdf(3), 1);
    expect(await readPdfPages(two)).toHaveLength(2);
    const one = await deletePage(await deletePage(two, 0), 0);
    expect(await readPdfPages(one)).toHaveLength(1); // refused to go to 0
  });

  it("reorders and moves pages", async () => {
    const r = await reorderPages(await makePdf(3), [2, 0, 1]);
    expect(await readPdfPages(r)).toHaveLength(3);
    const m = await movePage(await makePdf(3), 0, 2);
    expect(await readPdfPages(m)).toHaveLength(3);
  });

  it("stamps text and highlights without corrupting the doc", async () => {
    let bytes = await addText(await makePdf(1), {
      page: 0,
      x: 30,
      y: 100,
      text: "Reviewed",
      size: 16,
      color: { r: 0.8, g: 0, b: 0 },
    });
    bytes = await addHighlight(bytes, {
      page: 0,
      x: 20,
      y: 90,
      width: 120,
      height: 18,
    });
    expect(await readPdfPages(bytes)).toHaveLength(1);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("persists pencil ink strokes without corrupting the doc", async () => {
    const bytes = await addInkStroke(await makePdf(1), {
      page: 0,
      points: [
        { x: 20, y: 120 },
        { x: 40, y: 140 },
        { x: 70, y: 132 },
      ],
      thickness: 3,
      color: { r: 0.85, g: 0.12, b: 0.12 },
    });
    expect(await readPdfPages(bytes)).toHaveLength(1);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("replaces visible text by covering the old run and drawing the new one", async () => {
    const bytes = await replaceText(await makePdf(1), {
      page: 0,
      x: 20,
      y: 246,
      width: 60,
      height: 14,
      text: "UPDATED",
      size: 12,
      color: { r: 0, g: 0, b: 1 },
    });
    expect(await readPdfPages(bytes)).toHaveLength(1);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("appends a blank page", async () => {
    const bytes = await addBlankPage(await makePdf(1), 400, 400);
    const info = await readPdfPages(bytes);
    expect(info).toHaveLength(2);
    expect(info[1]).toMatchObject({ width: 400, height: 400 });
  });

  it("reads and fills form fields", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const form = doc.getForm();
    const tf = form.createTextField("fullName");
    tf.addToPage(page, { x: 20, y: 200, width: 160, height: 20 });
    const cb = form.createCheckBox("agree");
    cb.addToPage(page, { x: 20, y: 160, width: 14, height: 14 });
    const start = await doc.save();

    let fields = await getFormFields(start);
    expect(fields.map((f) => f.name).sort()).toEqual(["agree", "fullName"]);

    let bytes = await setFormField(start, "fullName", "Ada Lovelace");
    bytes = await setFormField(bytes, "agree", "true");
    fields = await getFormFields(bytes);
    expect(fields.find((f) => f.name === "fullName")!.value).toBe("Ada Lovelace");
    expect(fields.find((f) => f.name === "agree")!.value).toBe("true");
  });

  it("locates the %PDF header and tolerates leading junk", async () => {
    const good = await makePdf(1);
    expect(findPdfHeader(good)).toBe(0);

    // prepend stray bytes (BOM-like) before the header
    const junk = new Uint8Array([0xef, 0xbb, 0xbf, 0x0a]);
    const dirty = new Uint8Array(junk.length + good.length);
    dirty.set(junk, 0);
    dirty.set(good, junk.length);
    expect(findPdfHeader(dirty)).toBe(junk.length);

    // sanitize lets a dirty-but-real PDF parse again
    const info = await readPdfPages(dirty);
    expect(info).toHaveLength(1);
  });

  it("copies and compares PDF byte snapshots without sharing mutable storage", async () => {
    const original = await makePdf(1);
    const copy = copyPdfBytes(original);

    expect(pdfBytesEqual(original, copy)).toBe(true);
    copy[0] = 0;
    expect(original[0]).not.toBe(0);
    expect(pdfBytesEqual(original, copy)).toBe(false);
  });

  it("validates full parseability before bytes are saved", async () => {
    const original = await makePdf(1);
    await expect(assertValidPdfBytes(original)).resolves.toBeUndefined();
    expect(hasPdfEofMarker(original)).toBe(true);

    const truncated = original.slice(0, Math.max(0, original.length - 80));
    expect(hasPdfEofMarker(truncated)).toBe(false);
    await expect(assertValidPdfBytes(truncated)).rejects.toThrow();
  });

  it("throws a clear error on a non-PDF", () => {
    const notPdf = new TextEncoder().encode("<html>nope</html>");
    expect(findPdfHeader(notPdf)).toBe(-1);
    expect(() => sanitizePdfBytes(notPdf)).toThrow(/isn't a valid PDF/i);
  });

  it("sniffs what a non-PDF actually is", () => {
    expect(sniffFileType(new TextEncoder().encode("<!DOCTYPE html><html>"))).toMatch(
      /HTML/i
    );
    expect(sniffFileType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toMatch(/ZIP/i);
    expect(sniffFileType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toMatch(/PNG/i);
    expect(sniffFileType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toMatch(/PDF/i);
  });

  it("detects blank pdf.js paint output", () => {
    const blank = new Uint8ClampedArray(20 * 20 * 4).fill(255);
    expect(isLikelyBlankPdfPaint(blank, 20, 20)).toBe(true);

    const marked = new Uint8ClampedArray(blank);
    for (let y = 8; y < 13; y++) {
      for (let x = 8; x < 13; x++) {
        const idx = (y * 20 + x) * 4;
        marked[idx] = 20;
        marked[idx + 1] = 20;
        marked[idx + 2] = 20;
        marked[idx + 3] = 255;
      }
    }
    expect(isLikelyBlankPdfPaint(marked, 20, 20)).toBe(false);
  });
});
