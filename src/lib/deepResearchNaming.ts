import { safeBaseName } from "./fsnames";

/** Deterministic, filesystem-safe Deep Research note naming. */

/** Slug used to detect duplicates by title (case/punct-insensitive). */
export function titleSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** A filesystem-safe note base name, never empty, never a reserved device. */
export function safeNoteTitle(title: string): string {
  const base = safeBaseName(title.replace(/[/\\]+/g, "-"));
  return base || "Research";
}

/** A filesystem-safe folder name, falling back to "Research". */
export function safeFolderName(folder: string): string {
  const base = safeBaseName(folder.replace(/[/\\]+/g, "-"));
  return base || "Research";
}
