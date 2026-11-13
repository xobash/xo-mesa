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

/** Textual files that open in the editable note editor (vs. the read-only code
 *  viewer). Markdown and plain text are editable; code/data files are viewed. */
export function isEditableTextExt(ext: string): boolean {
  return /^(md|markdown|txt|text)$/i.test(ext);
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
  file: { ext: string; isMarkdown?: boolean },
  cachedContent: string | undefined
): string | null {
  if (cachedContent === undefined) return null;
  if (!isTextualVaultFile(file)) return null;
  return cachedContent;
}

/** Refresh text only for existing cache entries after an external modification. */
export function needsCachedTextRefresh(
  file: { ext: string; isMarkdown?: boolean },
  cachedContent: string | undefined
): boolean {
  if (cachedContent === undefined) return false;
  return isTextualVaultFile(file);
}

/** Image files we can display in a viewer. */
export function isImageExt(ext: string): boolean {
  return /^(png|jpe?g|gif|webp|bmp|avif|ico)$/i.test(ext);
}
/** How a file should be rendered in the main pane. */
export type FileKind =
  | "text"
  | "image"
  | "video"
  | "pdf"
  | "rtf"
  | "html"
  | "other";
export function fileKind(ext: string): FileKind {
  // html before the generic text check so it renders, not shows source
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown" || isTextExt(ext)) return "text";
  if (isImageExt(ext) || ext === "svg") return "image";
  if (/^(mp4|webm|ogg|ogv|mov|m4v)$/i.test(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (ext === "rtf") return "rtf";
  return "other";
}
