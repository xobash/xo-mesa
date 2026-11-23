/**
 * Header-only image inspection for the image editor: format, pixel size,
 * animation and metadata that a canvas re-encode would drop. Reads only
 * container headers (PNG chunks before IDAT, JPEG segments before SOS, WebP
 * RIFF chunks), so the check is cheap and runs before any decode.
 */

import { formatForExt, imageEditRefusalForExt, type EditableImageFormat } from "./imageEditFormats";

export { formatForExt, imageEditRefusalForExt, type EditableImageFormat };
export type ImageFormat = EditableImageFormat | "gif" | "other";

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
  animated: boolean;
  /** Human-readable names of metadata a re-encode removes. */
  metadata: string[];
  /** More than 8 bits per channel (PNG 16-bit). */
  highBitDepth: boolean;
}

/** Largest image the editor opens. Each full-size RGBA buffer is 4 bytes per
 *  pixel and an edit holds up to three (decoded source, output canvas, encoder
 *  copy), so 40 MP peaks near 480 MB. */
export const IMAGE_EDIT_MAX_PIXELS = 40_000_000;
/** WebKit and Chromium both cap a canvas side at 16384 px or more; stay inside the lower bound. */
export const IMAGE_EDIT_MAX_SIDE = 16_384;

const EXIF = "EXIF metadata (camera, date, location)";
const ICC = "a colour profile (ICC)";
const XMP = "XMP metadata";
const TEXT = "text metadata";

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

function empty(format: ImageFormat): ImageInfo {
  return { format, width: 0, height: 0, animated: false, metadata: [], highBitDepth: false };
}
function addOnce(list: string[], item: string): void {
  if (!list.includes(item)) list.push(item);
}

function inspectPng(b: Uint8Array): ImageInfo {
  const info = empty("png");
  if (b.length < 33 || ascii(b, 12, 4) !== "IHDR") return info;
  info.width = u32be(b, 16);
  info.height = u32be(b, 20);
  info.highBitDepth = b[24] > 8;
  let at = 8;
  while (at + 8 <= b.length) {
    const length = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    if (type === "IDAT" || type === "IEND") break;
    if (type === "acTL") info.animated = true;
    else if (type === "iCCP") addOnce(info.metadata, ICC);
    else if (type === "eXIf") addOnce(info.metadata, EXIF);
    else if (type === "iTXt" && ascii(b, at + 8, 17) === "XML:com.adobe.xmp") addOnce(info.metadata, XMP);
    else if (type === "tEXt" || type === "zTXt" || type === "iTXt") addOnce(info.metadata, TEXT);
    const next = at + 12 + length;
    if (next <= at) break;
    at = next;
  }
  return info;
}

function isJpegFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function inspectJpeg(b: Uint8Array): ImageInfo {
  const info = empty("jpeg");
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) break;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const length = u16be(b, at + 2);
    if (length < 2) break;
    const body = at + 4;
    if (marker === 0xe1 && ascii(b, body, 6) === "Exif\0\0") addOnce(info.metadata, EXIF);
    else if (marker === 0xe1 && ascii(b, body, 28) === "http://ns.adobe.com/xap/1.0/") addOnce(info.metadata, XMP);
    else if (marker === 0xe2 && ascii(b, body, 11) === "ICC_PROFILE") addOnce(info.metadata, ICC);
    else if (marker === 0xfe) addOnce(info.metadata, TEXT);
    else if (isJpegFrame(marker) && body + 5 <= b.length) {
      info.highBitDepth = b[body] > 8;
      info.height = u16be(b, body + 1);
      info.width = u16be(b, body + 3);
    }
    at += 2 + length;
  }
  return info;
}

function inspectWebp(b: Uint8Array): ImageInfo {
  const info = empty("webp");
  let at = 12;
  while (at + 8 <= b.length) {
    const type = ascii(b, at, 4);
    const size = u32le(b, at + 4);
    const data = at + 8;
    if (type === "VP8X" && data + 10 <= b.length) {
      const flags = b[data];
      if (flags & 0x20) addOnce(info.metadata, ICC);
      if (flags & 0x08) addOnce(info.metadata, EXIF);
      if (flags & 0x04) addOnce(info.metadata, XMP);
      if (flags & 0x02) info.animated = true;
      info.width = u24le(b, data + 4) + 1;
      info.height = u24le(b, data + 7) + 1;
    } else if (type === "ANIM" || type === "ANMF") info.animated = true;
    else if (type === "VP8 " && !info.width && data + 10 <= b.length) {
      info.width = (b[data + 6] | (b[data + 7] << 8)) & 0x3fff;
      info.height = (b[data + 8] | (b[data + 9] << 8)) & 0x3fff;
    } else if (type === "VP8L" && !info.width && data + 5 <= b.length && b[data] === 0x2f) {
      const b1 = b[data + 1], b2 = b[data + 2], b3 = b[data + 3], b4 = b[data + 4];
      info.width = 1 + (b1 | ((b2 & 0x3f) << 8));
      info.height = 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10));
    }
    const next = data + size + (size & 1);
    if (next <= at) break;
    at = next;
  }
  return info;
}

export function inspectImage(bytes: Uint8Array): ImageInfo {
  if (bytes.length >= 8 && u32be(bytes, 0) === 0x89504e47 && u32be(bytes, 4) === 0x0d0a1a0a) return inspectPng(bytes);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return inspectJpeg(bytes);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return inspectWebp(bytes);
  if (bytes.length >= 6 && ascii(bytes, 0, 4) === "GIF8") return empty("gif");
  return empty("other");
}

export function mimeForFormat(format: EditableImageFormat): string {
  return `image/${format}`;
}

/** Why the editor refuses these bytes, or null when they can be edited. */
export function imageEditRefusal(ext: string, info: ImageInfo): string | null {
  const byExt = imageEditRefusalForExt(ext);
  if (byExt) return byExt;
  if (info.format !== formatForExt(ext)) return `This file is not a ${ext.toUpperCase()} image, although its name says so. Mesa will not re-encode it.`;
  if (info.animated) return "This image is animated. Editing would keep only its first frame, so Mesa does not edit it.";
  if (!info.width || !info.height) return "Mesa could not read this image's size.";
  if (info.width > IMAGE_EDIT_MAX_SIDE || info.height > IMAGE_EDIT_MAX_SIDE || info.width * info.height > IMAGE_EDIT_MAX_PIXELS) {
    return `This image is ${info.width} × ${info.height} pixels. Mesa edits images up to ${IMAGE_EDIT_MAX_PIXELS / 1_000_000} megapixels and ${IMAGE_EDIT_MAX_SIDE} pixels a side.`;
  }
  return null;
}

/** The overwrite warning: re-encoding cost and every metadata kind found. */
export function imageOverwriteWarning(name: string, info: ImageInfo): string {
  const lines = [`Save over ${name}? Mesa re-encodes the whole image.`];
  if (info.format === "jpeg" || info.format === "webp") lines.push(`${info.format === "jpeg" ? "JPEG" : "WebP"} re-encoding loses some quality every time.`);
  if (info.metadata.length) lines.push(`This file contains ${info.metadata.join(", ")}. Saving removes it.`);
  else lines.push("Any metadata, such as EXIF or a colour profile (ICC), is removed.");
  if (info.highBitDepth) lines.push("Colour depth is reduced to 8 bits per channel.");
  lines.push("Use Save as copy to keep the original unchanged.");
  return lines.join(" ");
}
