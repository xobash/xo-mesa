/**
 * Dependency-free PDF byte/pixel helpers.
 *
 * Light consumers can validate bytes without loading pdf-lib.
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

/** Tag Mesa header rejection before byte-based parsing. A failed URL task must be destroyed separately
 * before its worker can be retained; callers never create this tag. */
const NOT_A_PDF = "__mesaNotAPdf";

export function markNotAPdf<T>(err: T): T {
  if (err && typeof err === "object") {
    try {
      (err as Record<string, unknown>)[NOT_A_PDF] = true;
    } catch {
      // Frozen or sealed (pdf.js errors, anything across a structured clone).
      // Tagging is an annotation on a failure that is already being reported;
      // it must never become a second failure thrown on top of the first. An
      // untagged error just means the caller takes the cautious branch and
      // rebuilds its worker.
    }
  }
  return err;
}

/** True only for Mesa's byte-header rejection, not a pdf.js parse failure. */
export function isNotAPdf(err: unknown): boolean {
  return !!(err && typeof err === "object" && (err as Record<string, unknown>)[NOT_A_PDF]);
}

/** Slice to the %PDF header (tolerating leading junk), or throw a clear error. */
export function sanitizePdfBytes(bytes: Uint8Array): Uint8Array {
  const off = findPdfHeader(bytes);
  if (off < 0) {
    throw markNotAPdf(
      new Error(
        "This file isn't a valid PDF — no %PDF header found (it may be corrupted or not actually a PDF)."
      )
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

  // Compare aligned words or unaligned DataView groups, then every tail byte.
  // Both inputs use the same grouping, so endianness does not affect equality.
  const words = a.length >>> 2;
  let word = 0;
  if ((a.byteOffset & 3) === 0 && (b.byteOffset & 3) === 0) {
    const aWords = new Uint32Array(a.buffer, a.byteOffset, words);
    const bWords = new Uint32Array(b.buffer, b.byteOffset, words);
    for (; word < words; word++) {
      if (aWords[word] !== bWords[word]) return false;
    }
  } else {
    const aView = new DataView(a.buffer, a.byteOffset, a.byteLength);
    const bView = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (; word < words; word++) {
      const offset = word * 4;
      if (aView.getUint32(offset) !== bView.getUint32(offset)) return false;
    }
  }
  for (let i = words * 4; i < a.length; i++) {
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
  if (samples > 0 && visible >= Math.max(3, Math.ceil(samples * 0.004))) {
    return false;
  }

  // If the sample grid looks blank, inspect the full pixel buffer before declaring the page blank.
  const pixelCount = Math.min(width * height, Math.floor(pixels.length / 4));
  let fullVisible = 0;
  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    const a = pixels[idx + 3] ?? 255;
    if (a < 8) continue;
    const r = pixels[idx] ?? 255;
    const g = pixels[idx + 1] ?? 255;
    const b = pixels[idx + 2] ?? 255;
    if (r < 245 || g < 245 || b < 245) {
      fullVisible++;
      // Match the coarse probe's minimum so one or two dirty backing pixels
      // cannot hide a genuinely broken paint.
      if (fullVisible >= 3) return false;
    }
  }
  return true;
}
