/** PDF byte-in/byte-out transforms. Callers convert top-left screen coordinates to bottom-left PDF coordinates. */
import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  PDFFont,
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

import { sanitizePdfBytes, hasPdfEofMarker } from "./pdfBytes";

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(sanitizePdfBytes(bytes), { ignoreEncryption: true });
}

/** Reject encrypted documents before every mutating transform; pdf-lib cannot decrypt them. */
async function loadForEdit(bytes: Uint8Array): Promise<PDFDocument> {
  const doc = await load(bytes);
  if (doc.isEncrypted) {
    throw new Error(
      "This PDF is encrypted (password-protected). Editing it would corrupt the file, so Mesa keeps it read-only."
    );
  }
  return doc;
}

/** Exclude layout characters normalized by pdf-lib from standalone font-encoding checks. */
const TEXT_LAYOUT_CHARS = new Set(["\t", "\n", "\r", "\b", "\f"]);

/**
 * A standard-font instance used purely to ask the real encoder what it accepts.
 * Built on a throwaway document so validating never embeds a stray font into
 * the user's PDF, and cached because the answer is the same for every call.
 */
let encodingProbeFont: Promise<PDFFont> | null = null;
function standardFontProbe(): Promise<PDFFont> {
  if (!encodingProbeFont) {
    encodingProbeFont = PDFDocument.create()
      .then((doc) => doc.embedFont(StandardFonts.Helvetica))
      .catch((e) => {
        encodingProbeFont = null;
        throw e;
      });
  }
  return encodingProbeFont;
}

function describeChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  return `"${ch}" (U+${code.toString(16).toUpperCase().padStart(4, "0")})`;
}

/** Validate text with the selected standard font before mutation; do not maintain a separate character table. */
export async function assertTextEncodable(text: string): Promise<void> {
  const font = await standardFontProbe();
  const unsupported: string[] = [];
  const seen = new Set<string>();
  for (const ch of text) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    if (TEXT_LAYOUT_CHARS.has(ch)) continue;
    try {
      font.encodeText(ch);
    } catch {
      unsupported.push(ch);
    }
  }
  if (!unsupported.length) return;
  const shown = unsupported.slice(0, 6).map(describeChar).join(", ");
  const more =
    unsupported.length > 6 ? `, and ${unsupported.length - 6} more` : "";
  throw new Error(
    `Mesa writes PDF text with the built-in standard fonts, which cover Latin-1 ` +
      `characters only. They cannot render ${shown}${more}. Replace or remove ` +
      `${unsupported.length === 1 ? "that character" : "those characters"} to edit this text.`
  );
}


function withEncodingContext(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (!/cannot encode/i.test(message)) return error;
  return new Error(
    `This PDF contains text the built-in standard fonts cannot render (${message}). ` +
      `Mesa keeps such documents read-only rather than writing a file that would ` +
      `lose those characters.`
  );
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
  const doc = await loadForEdit(bytes);
  const page = doc.getPage(index);
  const next = (((page.getRotation().angle + deltaDeg) % 360) + 360) % 360;
  page.setRotation(degrees(next));
  return doc.save();
}

/** Remove a page (no-op if it's the only page). */
export async function deletePage(bytes: Uint8Array, index: number): Promise<Uint8Array> {
  const doc = await loadForEdit(bytes);
  if (doc.getPageCount() <= 1) return bytes;
  doc.removePage(index);
  return doc.save();
}

/** Reorder existing pages inside the same document to preserve forms, metadata, outlines, and destinations. */
export async function reorderPages(
  bytes: Uint8Array,
  order: number[]
): Promise<Uint8Array> {
  const doc = await loadForEdit(bytes);
  const n = doc.getPageCount();
  const isPermutation =
    order.length === n &&
    new Set(order).size === n &&
    order.every((i) => Number.isInteger(i) && i >= 0 && i < n);
  if (!isPermutation) {
    throw new Error(`Page order must be a permutation of 0..${n - 1}.`);
  }
  const pages = doc.getPages();
  for (let i = n - 1; i >= 0; i--) doc.removePage(i);
  for (const i of order) doc.addPage(pages[i]);
  return doc.save();
}

/** Move a page from one position to another (same-document reattach). */
export async function movePage(
  bytes: Uint8Array,
  from: number,
  to: number
): Promise<Uint8Array> {
  const doc = await loadForEdit(bytes);
  const n = doc.getPageCount();
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return bytes;
  const page = doc.getPage(from);
  doc.removePage(from);
  doc.insertPage(to, page);
  return doc.save();
}

/** Stamp text onto a page at PDF coordinates (bottom-left origin). */
export async function addText(bytes: Uint8Array, s: TextStamp): Promise<Uint8Array> {
  await assertTextEncodable(s.text);
  const doc = await loadForEdit(bytes);
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

/** Replace text visually with an overlay and new text. This does not remove underlying content or redact it. */
export async function replaceText(
  bytes: Uint8Array,
  s: TextReplacement
): Promise<Uint8Array> {
  // Checked before the white-out rectangle is drawn, so a rejected replacement
  // cannot leave a painted-over box behind if the caller ever reuses the doc.
  await assertTextEncodable(s.text);
  const doc = await loadForEdit(bytes);
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
  const doc = await loadForEdit(bytes);
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

  const doc = await loadForEdit(bytes);
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
  const doc = await loadForEdit(bytes);
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
  await assertTextEncodable(value);
  const doc = await loadForEdit(bytes);
  const form = doc.getForm();
  const f = form.getFieldMaybe(name);
  if (!f) return bytes;
  if (f instanceof PDFTextField) f.setText(value);
  else if (f instanceof PDFCheckBox) {
    if (value === "true") f.check();
    else f.uncheck();
  }
  else if (f instanceof PDFDropdown) f.select(value);
  else if (f instanceof PDFRadioGroup) f.select(value);
  try {
    return await doc.save();
  } catch (e) {
    throw withEncodingContext(e);
  }
}
