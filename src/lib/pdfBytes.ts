/**
 * Dependency-free PDF byte/pixel helpers.
 *
 * Split out of `pdf.ts` so light consumers (hover thumbnails via
 * `pdfThumb.ts`) can validate/sanitize PDF bytes without statically pulling
 * pdf-lib into the main bundle. The full editing core in `pdf.ts` re-exports
 * everything here, so `import { sanitizePdfBytes } from "./pdf"` still works.
 */

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const PDF_EOF = [0x25, 0x25, 0x45, 0x4f, 0x46]; // "%%EOF"

/**
 * Find the byte offset of the "%PDF-" header within the first `limit` bytes.
 * Some real-world PDFs carry a BOM or stray leading bytes before the header,
 * which makes strict parsers throw "No PDF header found"; locating it lets us
 * slice to a clean start. Returns -1 if there's no header (not a PDF).
 */
export function findPdfHeader(bytes: Uint8Array, limit = 4096): number {
  const end = Math.min(bytes.length - PDF_HEADER.length, limit);
  for (let i = 0; i <= end; i++) {
    let match = true;
    for (let j = 0; j < PDF_HEADER.length; j++) {
      if (bytes[i + j] !== PDF_HEADER[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Best-effort guess at what a non-PDF file actually is, from its magic bytes —
 * so the error can say "this looks like an HTML page" rather than just "bad PDF".
 */
export function sniffFileType(bytes: Uint8Array): string {
  const h = bytes.subarray(0, 16);
  const is = (sig: number[]) => sig.every((b, i) => h[i] === b);
  const text = new TextDecoder("latin1").decode(h).trim();
  if (is([0x25, 0x50, 0x44, 0x46])) return "a PDF";
  if (is([0x50, 0x4b, 0x03, 0x04]) || is([0x50, 0x4b, 0x05, 0x06]))
    return "a ZIP or Office file (.docx/.xlsx/.zip)";
  if (is([0x89, 0x50, 0x4e, 0x47])) return "a PNG image";
  if (is([0xff, 0xd8, 0xff])) return "a JPEG image";
  if (is([0x47, 0x49, 0x46, 0x38])) return "a GIF image";
  if (is([0x1f, 0x8b])) return "a gzip archive";
  if (is([0x25, 0x21])) return "a PostScript file";
  if (/^(<!doctype html|<html|<head|<!--)/i.test(text)) return "an HTML page";
  if (/^<\?xml/i.test(text)) return "an XML file";
  if (/^[[{]/.test(text)) return "JSON or text";
  if (bytes.length === 0) return "an empty file";
  return "an unrecognized / possibly corrupted file";
}

/** Slice to the %PDF header (tolerating leading junk), or throw a clear error. */
export function sanitizePdfBytes(bytes: Uint8Array): Uint8Array {
  const off = findPdfHeader(bytes);
  if (off < 0) {
    throw new Error(
      "This file isn't a valid PDF — no %PDF header found (it may be corrupted or not actually a PDF)."
    );
  }
  return off === 0 ? bytes : bytes.subarray(off);
}

export function hasPdfEofMarker(bytes: Uint8Array): boolean {
  const start = Math.max(0, bytes.length - 4096);
  for (let i = bytes.length - PDF_EOF.length; i >= start; i--) {
    let match = true;
    for (let j = 0; j < PDF_EOF.length; j++) {
      if (bytes[i + j] !== PDF_EOF[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

export function copyPdfBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice(0);
}

export function pdfBytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Detect a pdf.js render that completed but produced a visually blank page.
 * This catches the bad first-paint failure mode where the canvas is sized like
 * the PDF page but only contains a white/transparent backing fill.
 */
export function isLikelyBlankPdfPaint(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): boolean {
  if (width <= 0 || height <= 0 || pixels.length < 4) return true;
  const cols = Math.min(32, width);
  const rows = Math.min(32, height);
  let samples = 0;
  let visible = 0;
  for (let y = 0; y < rows; y++) {
    const py = Math.min(height - 1, Math.floor((y + 0.5) * height / rows));
    for (let x = 0; x < cols; x++) {
      const px = Math.min(width - 1, Math.floor((x + 0.5) * width / cols));
      const idx = (py * width + px) * 4;
      const a = pixels[idx + 3] ?? 255;
      if (a < 8) continue;
      samples++;
      const r = pixels[idx] ?? 255;
      const g = pixels[idx + 1] ?? 255;
      const b = pixels[idx + 2] ?? 255;
      if (r < 245 || g < 245 || b < 245) visible++;
    }
  }
  if (samples === 0) return true;
  return visible < Math.max(3, Math.ceil(samples * 0.004));
}
