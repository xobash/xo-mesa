/**
 * In-app PDF editing core.
 *
 * Pure byte-in / byte-out transforms over a PDF, built on pdf-lib (MIT, no
 * native deps). Everything here is framework-agnostic and unit-tested; the
 * React layer just calls these and writes the result back to the vault.
 *
 * PDF user space has its origin at the BOTTOM-LEFT with y increasing upward.
 * The viewer works in top-left screen coordinates, so it converts each pointer
 * event with pdf.js's `viewport.convertToPdfPoint` before calling `addText` /
 * `addHighlight`.
 */
import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  PDFTextField,
  PDFCheckBox,
  PDFDropdown,
  PDFRadioGroup,
} from "pdf-lib";

export interface PdfPageInfo {
  index: number;
  width: number;
  height: number;
  rotation: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface TextStamp {
  page: number;
  x: number;
  y: number;
  text: string;
  size?: number;
  color?: RGB;
}

export interface TextReplacement extends TextStamp {
  width: number;
  height: number;
  background?: RGB;
}

export interface Highlight {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: RGB;
  opacity?: number;
}

export interface InkPoint {
  x: number;
  y: number;
}

export interface InkStroke {
  page: number;
  points: InkPoint[];
  thickness?: number;
  color?: RGB;
  opacity?: number;
}

export type FormFieldType = "text" | "checkbox" | "dropdown" | "radio" | "other";

export interface FormField {
  name: string;
  type: FormFieldType;
  value: string;
  options?: string[];
}

// Byte/pixel helpers live in pdfBytes.ts (no pdf-lib dependency) so light
// consumers like hover thumbnails don't pull pdf-lib into the main bundle.
// Re-exported here so existing `from "./pdf"` imports keep working.
export {
  findPdfHeader,
  sniffFileType,
  sanitizePdfBytes,
  hasPdfEofMarker,
  copyPdfBytes,
  pdfBytesEqual,
  isLikelyBlankPdfPaint,
} from "./pdfBytes";
import { sanitizePdfBytes, hasPdfEofMarker } from "./pdfBytes";

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(sanitizePdfBytes(bytes), { ignoreEncryption: true });
}

export async function assertValidPdfBytes(bytes: Uint8Array): Promise<void> {
  const clean = sanitizePdfBytes(bytes);
  if (!hasPdfEofMarker(clean)) {
    throw new Error("This PDF is missing its %%EOF marker and may be truncated.");
  }
  await load(clean);
}

function toRgb(c?: RGB) {
  const v = c ?? { r: 0, g: 0, b: 0 };
  return rgb(v.r, v.g, v.b);
}

/** Read page geometry without modifying the document. */
export async function readPdfPages(bytes: Uint8Array): Promise<PdfPageInfo[]> {
  const doc = await load(bytes);
  return doc.getPages().map((p, index) => {
    const { width, height } = p.getSize();
    return { index, width, height, rotation: p.getRotation().angle };
  });
}

/** Rotate one page by a multiple of 90°. */
export async function rotatePage(
  bytes: Uint8Array,
  index: number,
  deltaDeg: number
): Promise<Uint8Array> {
  const doc = await load(bytes);
  const page = doc.getPage(index);
  const next = (((page.getRotation().angle + deltaDeg) % 360) + 360) % 360;
  page.setRotation(degrees(next));
  return doc.save();
}

/** Remove a page (no-op if it's the only page). */
export async function deletePage(bytes: Uint8Array, index: number): Promise<Uint8Array> {
  const doc = await load(bytes);
  if (doc.getPageCount() <= 1) return doc.save();
  doc.removePage(index);
  return doc.save();
}

/** Reorder pages to the given permutation of indices. */
export async function reorderPages(
  bytes: Uint8Array,
  order: number[]
): Promise<Uint8Array> {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, order);
  copied.forEach((p) => out.addPage(p));
  return out.save();
}

/** Move a page from one position to another. */
export async function movePage(
  bytes: Uint8Array,
  from: number,
  to: number
): Promise<Uint8Array> {
  const n = (await load(bytes)).getPageCount();
  const order = Array.from({ length: n }, (_, i) => i);
  if (from < 0 || from >= n || to < 0 || to >= n) return bytes;
  order.splice(to, 0, order.splice(from, 1)[0]);
  return reorderPages(bytes, order);
}

/** Stamp text onto a page at PDF coordinates (bottom-left origin). */
export async function addText(bytes: Uint8Array, s: TextStamp): Promise<Uint8Array> {
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.getPage(s.page);
  page.drawText(s.text, {
    x: s.x,
    y: s.y,
    size: s.size ?? 14,
    font,
    color: toRgb(s.color),
  });
  return doc.save();
}

/**
 * Replace visible text by painting over its bounding box, then drawing the new
 * text. PDF content streams do not expose a universal "edit this glyph run"
 * primitive, so this is the same durable visual replacement workflow used by
 * many lightweight PDF annotators.
 */
export async function replaceText(
  bytes: Uint8Array,
  s: TextReplacement
): Promise<Uint8Array> {
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.getPage(s.page);
  const pad = Math.max(1.5, (s.size ?? s.height) * 0.12);
  page.drawRectangle({
    x: s.x - pad,
    y: s.y - pad,
    width: Math.max(1, s.width + pad * 2),
    height: Math.max(1, s.height + pad * 2),
    color: toRgb(s.background ?? { r: 1, g: 1, b: 1 }),
    opacity: 1,
  });
  page.drawText(s.text, {
    x: s.x,
    y: s.y + Math.max(0, s.height - (s.size ?? s.height)) * 0.35,
    size: s.size ?? Math.max(8, s.height * 0.82),
    font,
    color: toRgb(s.color),
    maxWidth: Math.max(1, s.width + pad),
  });
  return doc.save();
}

/** Draw a translucent rectangle — a highlight / redaction marker. */
export async function addHighlight(bytes: Uint8Array, h: Highlight): Promise<Uint8Array> {
  const doc = await load(bytes);
  const page = doc.getPage(h.page);
  page.drawRectangle({
    x: h.x,
    y: h.y,
    width: h.width,
    height: h.height,
    color: toRgb(h.color ?? { r: 1, g: 0.92, b: 0.23 }),
    opacity: h.opacity ?? 0.35,
  });
  return doc.save();
}

/** Persist a freehand pencil stroke as PDF line segments. */
export async function addInkStroke(bytes: Uint8Array, s: InkStroke): Promise<Uint8Array> {
  const points = s.points.filter(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y)
  );
  if (!points.length) return bytes;

  const doc = await load(bytes);
  const page = doc.getPage(s.page);
  const color = toRgb(s.color);
  const thickness = Math.max(0.5, s.thickness ?? 2);
  const opacity = s.opacity ?? 0.95;

  if (points.length === 1) {
    page.drawCircle({
      x: points[0].x,
      y: points[0].y,
      size: thickness / 2,
      color,
      opacity,
    });
    return doc.save();
  }

  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1];
    const end = points[i];
    page.drawLine({
      start,
      end,
      thickness,
      color,
      opacity,
    });
  }

  // Round off the visible endpoints so short strokes do not look clipped.
  const capSize = thickness / 2;
  for (const point of [points[0], points[points.length - 1]]) {
    page.drawCircle({
      x: point.x,
      y: point.y,
      size: capSize,
      color,
      opacity,
    });
  }

  return doc.save();
}

/** Append a blank page (defaults to US Letter). */
export async function addBlankPage(
  bytes: Uint8Array,
  width = 612,
  height = 792
): Promise<Uint8Array> {
  const doc = await load(bytes);
  doc.addPage([width, height]);
  return doc.save();
}

function fieldType(f: unknown): FormFieldType {
  if (f instanceof PDFTextField) return "text";
  if (f instanceof PDFCheckBox) return "checkbox";
  if (f instanceof PDFDropdown) return "dropdown";
  if (f instanceof PDFRadioGroup) return "radio";
  return "other";
}

/** List fillable form fields with their current values. */
export async function getFormFields(bytes: Uint8Array): Promise<FormField[]> {
  const doc = await load(bytes);
  const form = doc.getForm();
  return form.getFields().map((f) => {
    const type = fieldType(f);
    let value = "";
    let options: string[] | undefined;
    if (f instanceof PDFTextField) value = f.getText() ?? "";
    else if (f instanceof PDFCheckBox) value = f.isChecked() ? "true" : "false";
    else if (f instanceof PDFDropdown) {
      value = f.getSelected()[0] ?? "";
      options = f.getOptions();
    } else if (f instanceof PDFRadioGroup) {
      value = f.getSelected() ?? "";
      options = f.getOptions();
    }
    return { name: f.getName(), type, value, options };
  });
}

/** Set a single form field's value (string; "true"/"false" for checkboxes). */
export async function setFormField(
  bytes: Uint8Array,
  name: string,
  value: string
): Promise<Uint8Array> {
  const doc = await load(bytes);
  const form = doc.getForm();
  const f = form.getFieldMaybe(name);
  if (!f) return bytes;
  if (f instanceof PDFTextField) f.setText(value);
  else if (f instanceof PDFCheckBox) value === "true" ? f.check() : f.uncheck();
  else if (f instanceof PDFDropdown) f.select(value);
  else if (f instanceof PDFRadioGroup) f.select(value);
  return doc.save();
}
