/**
 * Content-based file type detection from the first bytes of a file.
 *
 * The one magic-byte detector (PDF errors and the fallback viewer). It stays
 * dependency-free and out of the entry chunk: only lazy views import it.
 * Detection reads at most `SNIFF_BYTES`; every scan is bounded by that sample.
 */

/** Bytes a caller should read before calling `detectFileType`. */
export const SNIFF_BYTES = 4096;

/** What a viewer can do with the detected content. */
export type SniffFamily = "zip" | "epub" | "text" | "binary" | "empty";

export interface DetectedType {
  /** Stable machine id, e.g. "png", "zip", "html". */
  id: string;
  /** Noun phrase with article, for sentences: "a PNG image". */
  label: string;
  /** Short name for a details row: "PNG image". */
  name: string;
  family: SniffFamily;
  /** Extensions this content normally carries. */
  exts: readonly string[];
  /** False when the content is generic (plain text, plain ZIP) and many
   *  extensions legitimately carry it. */
  strict: boolean;
}

function type(
  id: string,
  name: string,
  exts: readonly string[],
  family: SniffFamily = "binary",
  strict = true
): DetectedType {
  const article = /^(UTF|unrecognized)/.test(name) ? (name.startsWith("u") ? "an" : "a")
    : /^[aeiou]/i.test(name) || /^(HTML|MP|SVG|XML|RTF|ELF)/.test(name) ? "an" : "a";
  return { id, name, label: `${article} ${name}`, family, exts, strict };
}

const ZIP_FAMILY_EXTS = [
  "zip", "jar", "war", "ear", "apk", "aab", "aar", "ipa", "xpi", "epub", "cbz", "kmz", "whl", "nupkg",
  "vsix", "appx", "msix", "3mf", "usdz", "sketch", "key", "pages", "numbers",
  "docx", "docm", "dotx", "dotm", "xlsx", "xlsm", "xltx", "xltm", "pptx", "pptm", "ppsx", "potx", "vsdx",
  "odt", "ods", "odp", "odg", "ott", "ots", "otp", "otg",
];

const OOXML: Record<string, string> = {
  docx: "Word document", docm: "Word document", dotx: "Word template", dotm: "Word template",
  xlsx: "Excel workbook", xlsm: "Excel workbook", xltx: "Excel template", xltm: "Excel template",
  pptx: "PowerPoint presentation", pptm: "PowerPoint presentation", ppsx: "PowerPoint slide show",
  potx: "PowerPoint template",
  vsdx: "Visio drawing",
};

const ODF: Record<string, [string, string]> = {
  "application/vnd.oasis.opendocument.text": ["OpenDocument text", "odt"],
  "application/vnd.oasis.opendocument.spreadsheet": ["OpenDocument spreadsheet", "ods"],
  "application/vnd.oasis.opendocument.presentation": ["OpenDocument presentation", "odp"],
  "application/vnd.oasis.opendocument.graphics": ["OpenDocument drawing", "odg"],
};

function u16(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>> 0;
}

function ascii(b: Uint8Array, at: number, length: number): string {
  let out = "";
  const end = Math.min(b.length, at + length);
  for (let i = at; i < end; i++) out += String.fromCharCode(b[i]);
  return out;
}

function startsWith(b: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (b.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
}

/** ZIP subtype from the first local file header, which writers of EPUB, ODF
 *  and Office packages put first. Bounded by the sample. */
function zipSubtype(b: Uint8Array, ext: string): DetectedType {
  const generic = type("zip", "ZIP archive", ZIP_FAMILY_EXTS, "zip", false);
  if (u32(b, 0) !== 0x04034b50) return generic;
  const nameLength = u16(b, 26);
  const extraLength = u16(b, 28);
  const name = ascii(b, 30, Math.min(nameLength, 256));
  if (name === "mimetype" && u16(b, 8) === 0) {
    const mime = ascii(b, 30 + nameLength + extraLength, Math.min(u32(b, 18), 128)).trim();
    if (mime === "application/epub+zip") return type("epub", "EPUB book", ["epub"], "epub");
    const odf = ODF[mime];
    if (odf) return type(odf[1], `${odf[0]} (ZIP package)`, [odf[1], "ott", "ots", "otp"], "zip");
  }
  if (name === "[Content_Types].xml") {
    const known = OOXML[ext];
    return type(known ? ext : "ooxml", `${known ?? "Office Open XML package"} (ZIP package)`, Object.keys(OOXML), "zip");
  }
  if (name === "AndroidManifest.xml") return type("apk", "Android package (ZIP)", ["apk", "aab"], "zip");
  if (name.startsWith("META-INF/")) return type("jar", "Java archive (ZIP)", ["jar", "war", "ear", "aar", "apk", "xpi"], "zip");
  return generic;
}

interface Signature {
  test: (b: Uint8Array) => boolean;
  detected: DetectedType | ((b: Uint8Array) => DetectedType);
}

const SIGNATURES: readonly Signature[] = [
  { test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]), detected: type("png", "PNG image", ["png", "apng"]) },
  { test: (b) => startsWith(b, [0xff, 0xd8, 0xff]), detected: type("jpeg", "JPEG image", ["jpg", "jpeg", "jpe", "jfif"]) },
  { test: (b) => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a", detected: type("gif", "GIF image", ["gif"]) },
  { test: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP", detected: type("webp", "WebP image", ["webp"]) },
  { test: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE", detected: type("wav", "WAV audio", ["wav", "wave"]) },
  { test: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "AVI ", detected: type("avi", "AVI video", ["avi"]) },
  { test: (b) => ascii(b, 0, 4) === "FORM" && /^AIF[FC]$/.test(ascii(b, 8, 4)), detected: type("aiff", "AIFF audio", ["aif", "aiff", "aifc"]) },
  { test: (b) => ascii(b, 4, 4) === "ftyp", detected: (b) => {
    const brand = ascii(b, 8, 4);
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return type("heif", "HEIF image", ["heic", "heif"]);
    if (brand === "avif" || brand === "avis") return type("avif", "AVIF image", ["avif"]);
    if (brand === "qt  ") return type("mov", "QuickTime video", ["mov", "qt"]);
    if (brand.startsWith("M4A") || brand.startsWith("M4B")) return type("m4a", "MPEG-4 audio", ["m4a", "m4b", "mp4"]);
    return type("mp4", "MPEG-4 video", ["mp4", "m4v", "m4a", "mov", "3gp", "3g2"]);
  } },
  { test: (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]), detected: type("mkv", "Matroska or WebM media", ["mkv", "webm", "mka", "mk3d"]) },
  { test: (b) => ascii(b, 0, 4) === "OggS", detected: type("ogg", "Ogg media", ["ogg", "oga", "ogv", "opus", "spx"]) },
  { test: (b) => ascii(b, 0, 4) === "fLaC", detected: type("flac", "FLAC audio", ["flac"]) },
  { test: (b) => ascii(b, 0, 3) === "ID3", detected: type("mp3", "MP3 audio", ["mp3"]) },
  { test: (b) => b[0] === 0xff && b.length > 1 && (b[1] & 0xe0) === 0xe0, detected: type("mpeg-audio", "MPEG audio stream", ["mp3", "mp2", "aac"]) },
  { test: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]) || startsWith(b, [0x50, 0x4b, 0x07, 0x08]), detected: () => type("zip", "ZIP archive", ZIP_FAMILY_EXTS, "zip", false) },
  { test: (b) => startsWith(b, [0x1f, 0x8b]), detected: type("gzip", "gzip archive", ["gz", "tgz", "gzip", "svgz"]) },
  { test: (b) => ascii(b, 0, 3) === "BZh", detected: type("bzip2", "bzip2 archive", ["bz2", "tbz", "tbz2"]) },
  { test: (b) => startsWith(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), detected: type("xz", "XZ archive", ["xz", "txz"]) },
  { test: (b) => startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), detected: type("7z", "7-Zip archive", ["7z"]) },
  { test: (b) => ascii(b, 0, 6) === "Rar!\x1a\x07", detected: type("rar", "RAR archive", ["rar"]) },
  { test: (b) => startsWith(b, [0x28, 0xb5, 0x2f, 0xfd]), detected: type("zstd", "Zstandard archive", ["zst", "zstd"]) },
  { test: (b) => ascii(b, 257, 5) === "ustar", detected: type("tar", "tar archive", ["tar"]) },
  { test: (b) => ascii(b, 0, 16) === "SQLite format 3\0", detected: type("sqlite", "SQLite database", ["sqlite", "sqlite3", "db", "db3"]) },
  // Password-protected OOXML is also a compound file, so the OOXML names match too.
  { test: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), detected: type("cfb", "Microsoft Office compound file (legacy or password-protected)", ["doc", "xls", "ppt", "msg", "msi", "pub", "vsd", "dot", "xlt", "pot", "pps", "docx", "docm", "dotx", "dotm", "xlsx", "xlsm", "xltx", "xltm", "pptx", "pptm", "ppsx", "potx"]) },
  { test: (b) => startsWith(b, [0x7f, 0x45, 0x4c, 0x46]), detected: type("elf", "ELF executable", ["", "so", "o", "elf", "axf"]) },
  { test: (b) => [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(u32(b, 0)) || [0xfeedface, 0xfeedfacf].includes(((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0), detected: type("macho", "Mach-O executable", ["", "dylib", "bundle", "so", "o"]) },
  { test: (b) => startsWith(b, [0xca, 0xfe, 0xba, 0xbe]), detected: type("cafebabe", "Java class or macOS universal binary", ["class", "", "dylib"]) },
  { test: (b) => ascii(b, 0, 2) === "MZ", detected: type("pe", "Windows executable", ["exe", "dll", "sys", "scr", "cpl", "ocx", "efi", "com"]) },
  { test: (b) => startsWith(b, [0x00, 0x61, 0x73, 0x6d]), detected: type("wasm", "WebAssembly module", ["wasm"]) },
  { test: (b) => ascii(b, 0, 4) === "wOFF", detected: type("woff", "WOFF font", ["woff"]) },
  { test: (b) => ascii(b, 0, 4) === "wOF2", detected: type("woff2", "WOFF2 font", ["woff2"]) },
  { test: (b) => ascii(b, 0, 4) === "OTTO", detected: type("otf", "OpenType font", ["otf"]) },
  { test: (b) => startsWith(b, [0x00, 0x01, 0x00, 0x00, 0x00]) || (ascii(b, 0, 4) === "true" && b[4] === 0), detected: type("ttf", "TrueType font", ["ttf", "ttc", "dfont"]) },
  { test: (b) => ascii(b, 0, 4) === "8BPS", detected: type("psd", "Photoshop image", ["psd", "psb"]) },
  { test: (b) => ascii(b, 0, 4) === "II*\0" || ascii(b, 0, 4) === "MM\0*", detected: type("tiff", "TIFF image or camera raw", ["tif", "tiff", "dng", "nef", "cr2", "arw", "orf", "rw2", "pef"]) },
  { test: (b) => startsWith(b, [0x00, 0x00, 0x01, 0x00]) && b.length > 5 && b[4] > 0, detected: type("ico", "Windows icon", ["ico"]) },
  { test: (b) => ascii(b, 0, 2) === "BM" && u32(b, 6) === 0 && u32(b, 2) > 26, detected: type("bmp", "BMP image", ["bmp", "dib"]) },
  { test: (b) => ascii(b, 0, 8) === "bplist00", detected: type("bplist", "binary property list", ["plist", "bplist", "webloc"]) },
  { test: (b) => startsWith(b, [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]), detected: type("hdf5", "HDF5 data file", ["h5", "hdf5", "he5", "nc"]) },
  { test: (b) => ascii(b, 0, 4) === "glTF", detected: type("glb", "binary glTF model", ["glb"]) },
  { test: (b) => ascii(b, 0, 8) === "AT&TFORM", detected: type("djvu", "DjVu document", ["djvu", "djv"]) },
  { test: (b) => ascii(b, 128, 4) === "DICM", detected: type("dicom", "DICOM medical image", ["dcm", "dicom"]) },
];

const PDF = type("pdf", "PDF", ["pdf", "ai"]);

/** Every extension a binary signature claims; a generic match (plain text,
 *  plain ZIP) under one of these names is still a mislabel. */
const SIGNATURE_EXTS: ReadonlySet<string> = new Set(
  [...PDF.exts, ...SIGNATURES.flatMap((s) => (typeof s.detected === "function" ? [] : s.detected.exts))]
    .filter((ext) => ext && !ZIP_FAMILY_EXTS.includes(ext))
);

function hasPdfHeader(b: Uint8Array): boolean {
  if (ascii(b, 0, 4) === "%PDF") return true;
  const end = Math.min(b.length - 5, 1024);
  for (let i = 0; i <= end; i++) {
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 && b[i + 4] === 0x2d) return true;
  }
  return false;
}

/** UTF-8 text without NUL bytes or many control characters. A sequence cut at
 *  the end of the sample is not an error. */
function looksLikeText(b: Uint8Array): boolean {
  let control = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0) return false;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c && c !== 0x1b) control++;
  }
  if (control > b.length / 50) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function textSubtype(b: Uint8Array): DetectedType {
  const start = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  const head = new TextDecoder("utf-8").decode(b.subarray(start, Math.min(b.length, start + 1024))).trimStart();
  if (/^(<!doctype html|<html|<head|<body|<!--)/i.test(head)) return type("html", "HTML page", ["html", "htm", "xhtml", "shtml", "mhtml", "download"], "text");
  if (/^\{\\rtf/.test(head)) return type("rtf", "RTF document", ["rtf"], "text");
  if (/^<svg[\s>]/i.test(head) || (/^<\?xml/i.test(head) && /<svg[\s>]/i.test(head))) return type("svg", "SVG image", ["svg"], "text");
  if (/^<\?xml/i.test(head)) return type("xml", "XML file", [], "text", false);
  if (/^%!/.test(head)) return type("ps", "PostScript file", ["ps", "eps"], "text");
  if (/^[[{]/.test(head)) return type("json", "JSON or text", [], "text", false);
  return type("text", "plain text", [], "text", false);
}

/** Detect content type from magic bytes. Reads at most `SNIFF_BYTES`. */
export function detectFileType(bytes: Uint8Array, ext = ""): DetectedType {
  const b = bytes.subarray(0, SNIFF_BYTES);
  if (b.length === 0) return type("empty", "empty file", [], "empty", false);
  if (hasPdfHeader(b)) return PDF;
  if (startsWith(b, [0xfe, 0xff]) || startsWith(b, [0xff, 0xfe])) return type("utf16", "UTF-16 text", [], "text", false);
  for (const signature of SIGNATURES) {
    if (!signature.test(b)) continue;
    const detected = typeof signature.detected === "function" ? signature.detected(b) : signature.detected;
    return detected.id === "zip" ? zipSubtype(b, ext.toLowerCase()) : detected;
  }
  if (looksLikeText(b)) return textSubtype(b);
  return type("unknown", "unrecognized binary file", [], "binary", false);
}

/** True when the name promises one format and the bytes are another, such as
 *  a `.pdf` that is really a saved HTML error page. */
export function isExtensionMismatch(detected: DetectedType, ext: string): boolean {
  const lower = ext.toLowerCase();
  if (detected.family === "empty" || detected.id === "unknown") return false;
  if (detected.strict) return !detected.exts.includes(lower);
  if (detected.exts.includes(lower)) return false;
  return SIGNATURE_EXTS.has(lower);
}

/** Best-effort sentence fragment ("an HTML page") for error messages. */
export function sniffFileType(bytes: Uint8Array): string {
  return detectFileType(bytes).label;
}
