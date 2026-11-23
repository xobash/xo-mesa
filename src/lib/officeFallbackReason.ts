// Reasons shown by the lazy fallback view for office formats Mesa does not
// edit in place, and the legacy binary Office extensions it reads read-only.

export type LegacyOfficeKind = "word" | "excel" | "powerpoint";

/** Legacy binary Office (OLE compound file) kind by extension, or `null`. */
export function legacyOfficeKind(ext: string): LegacyOfficeKind | null {
  const lower = ext.toLowerCase();
  if (lower === "doc" || lower === "dot") return "word";
  if (lower === "xls" || lower === "xlt") return "excel";
  if (lower === "ppt" || lower === "pps" || lower === "pot") return "powerpoint";
  return null;
}

/** Extension of the editable copy Mesa writes for a legacy kind. */
export const LEGACY_COPY_EXT: Readonly<Record<LegacyOfficeKind, string>> = { word: "docx", excel: "xlsx", powerpoint: "pptx" };

/** Why a known office format only gets the details, contents and bytes view. */
export function officeFallbackReason(ext: string): string | null {
  const lower = ext.toLowerCase();
  const legacy = legacyOfficeKind(lower);
  if (legacy) {
    return `This is an older binary Office file (.${lower}). Mesa shows its content read-only and never changes this file. To edit it, make an editable .${LEGACY_COPY_EXT[legacy]} copy.`;
  }
  return null;
}
