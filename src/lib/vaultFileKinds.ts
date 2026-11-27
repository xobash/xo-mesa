import type { VaultFile } from "../types";
import { linkKey } from "./fsnames";
import { relBase } from "./vaultPaths";

// Extension classes and text-file eligibility for vault files.

/** Text-renderable files we can open in the editor/preview/code viewer. */
export function isTextExt(ext: string): boolean {
  return /^(md|markdown|txt|text|csv|tsv|json|jsonc|ya?ml|html?|xml|svg|css|scss|less|js|jsx|ts|tsx|mjs|cjs|log|toml|ini|conf|cfg|properties|env|sh|bash|zsh|bat|cmd|ps1|psm1|py|rb|go|rs|c|h|hpp|cc|cpp|java|kt|php|sql)$/i.test(
    ext
  );
}

/** Prose files: the editor offers Markdown highlighting, Live preview and the
 *  outline. Every other text file is edited as source code. */
export function isEditableTextExt(ext: string): boolean {
  return /^(md|markdown|txt|text)$/i.test(ext);
}

/** Bytes read from the start of an unknown-extension file to decide whether it is text. */
export const TEXT_SNIFF_BYTES = 8192;
/** Bound on remembered sniff results (Power of 10: no unbounded growth). */
const MAX_SNIFFED_TEXT_PATHS = 4096;
// Absolute paths whose bounded prefix this session found to be UTF-8 text.
// Open-time only: vault-scale rules (index, graph, counts) never consult it.
const sniffedTextPaths = new Set<string>();

/** Length of `bytes` without a multi-byte UTF-8 sequence cut off at the end. */
function completeUtf8Length(bytes: Uint8Array): number {
  const n = bytes.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const b = bytes[n - back];
    if ((b & 0xc0) === 0x80) continue; // continuation byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? n - back : n;
  }
  return n;
}

/** True when a file prefix is valid UTF-8 with no NUL byte. When `complete` is
 *  false the prefix may end inside a multi-byte character. */
export function looksLikeUtf8Text(bytes: Uint8Array, complete: boolean): boolean {
  const length = complete ? bytes.length : completeUtf8Length(bytes);
  if (bytes.subarray(0, length).includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    return true;
  } catch {
    return false;
  }
}

/** Remember that an opened file sniffed as text, so it can be read and saved as text. */
export function rememberSniffedText(path: string): void {
  sniffedTextPaths.delete(path);
  sniffedTextPaths.add(path);
  if (sniffedTextPaths.size > MAX_SNIFFED_TEXT_PATHS) {
    const oldest = sniffedTextPaths.values().next().value;
    if (oldest !== undefined) sniffedTextPaths.delete(oldest);
  }
}

/** Carry a sniff result across a rename. */
export function moveSniffedText(from: string, to: string): void {
  if (!sniffedTextPaths.delete(from)) return;
  rememberSniffedText(to);
}

/** Forget every sniff result. Tests only: results are keyed by absolute path,
 *  so a vault switch needs no reset. */
export function clearSniffedText(): void {
  sniffedTextPaths.clear();
}

export function isSniffedText(path: string | undefined): boolean {
  return path !== undefined && sniffedTextPaths.has(path);
}

/** An "other" file that has not been sniffed yet needs a prefix check at open. */
export function needsTextSniff(file: { ext: string; path: string; isMarkdown?: boolean }): boolean {
  return !isTextualVaultFile(file) && fileKind(file.ext) === "other" && !isSniffedText(file.path);
}

/** Open-time text rule: the vault-scale rule plus files sniffed as text when opened.
 *  Reads, saves and save recovery use it; indexing and the graph do not. */
export function isOpenableTextFile(file: { ext: string; isMarkdown?: boolean; path?: string }): boolean {
  return isTextualVaultFile(file) || isSniffedText(file.path);
}

/** How the main pane renders a file, including sniffed text. */
export function documentKind(file: { ext: string; path: string }): FileKind {
  const kind = fileKind(file.ext);
  return kind === "other" && isSniffedText(file.path) ? "text" : kind;
}
/** Shared text-pipeline eligibility predicate. Binary editing uses byte-oriented persistence. */
export function isTextualVaultFile(file: {
  ext: string;
  isMarkdown?: boolean;
}): boolean {
  return !!file.isMarkdown || isTextExt(file.ext) || /^rtf$/i.test(file.ext);
}

/** Resolve a vault link to a real text file without making a new Markdown note.
 * Exact relative paths win. A bare name then prefers Markdown and falls back
 * to another editable text file, such as `.txt`. */
export function resolveTextVaultLink(
  files: readonly VaultFile[],
  target: string
): VaultFile | undefined {
  let normalized = target.split("|")[0]?.split("#")[0]?.trim().replace(/\\/g, "/") ?? "";
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep a malformed percent escape literal. It can still be a real name.
  }
  if (!normalized) return undefined;
  const lower = linkKey(normalized);
  const exact = files.find(
    (file) => isTextualVaultFile(file) && linkKey(file.relPath) === lower
  );
  if (exact) return exact;
  const base = relBase(lower);
  const matches = files.filter(
    (file) => isTextualVaultFile(file) && linkKey(file.name) === base
  );
  return matches.find((file) => file.isMarkdown) ?? matches[0];
}

/** Return cached text only for eligible text files; null means skip.
 * An absent cache entry is not an empty document, while a cached empty string is valid content. */
export function flushableNoteText(
  file: { ext: string; isMarkdown?: boolean; path?: string },
  cachedContent: string | undefined
): string | null {
  if (cachedContent === undefined) return null;
  if (!isOpenableTextFile(file)) return null;
  return cachedContent;
}

/** Refresh text only for existing cache entries after an external modification. */
export function needsCachedTextRefresh(
  file: { ext: string; isMarkdown?: boolean; path?: string },
  cachedContent: string | undefined
): boolean {
  if (cachedContent === undefined) return false;
  return isOpenableTextFile(file);
}

/** Excel Open XML workbooks and templates (macro-enabled ones open read-only until confirmed). Legacy .xls uses the file details view; .ods opens in the OpenDocument view. */
export function isSpreadsheetExt(ext: string): boolean {
  return /^(xlsx|xlsm|xltx|xltm)$/i.test(ext);
}

/** Image files we can display in a viewer. */
export function isImageExt(ext: string): boolean {
  return /^(png|jpe?g|gif|webp|bmp|avif|ico)$/i.test(ext);
}
/** Word packages the Word view opens (legacy `.doc` stays in the details view). */
export function isWordExt(ext: string): boolean {
  return /^(docx|docm|dotx|dotm)$/i.test(ext);
}

export type FileKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "rtf"
  | "html"
  | "spreadsheet"
  | "other";
/** How a file should be rendered in the main pane. */
export function fileKind(ext: string): FileKind {
  // html before the generic text check so it renders, not shows source
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown" || isTextExt(ext)) return "text";
  if (isImageExt(ext)) return "image";
  // .ogg stays video: <video> also plays audio-only Ogg, and the player
  // switches to the audio layout when the file has no picture.
  if (/^(mp4|webm|ogg|ogv|mov|m4v)$/i.test(ext)) return "video";
  if (/^(mp3|wav|m4a|aac|flac|oga|opus)$/i.test(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (ext === "rtf") return "rtf";
  if (isSpreadsheetExt(ext)) return "spreadsheet";
  return "other";
}
