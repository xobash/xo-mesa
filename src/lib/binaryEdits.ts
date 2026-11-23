import { isImageExt, isSpreadsheetExt, isWordExt } from "./vaultFileKinds";
import { relBase, extOf } from "./vaultPaths";

/** What unsaved in-editor edits are called in prompts: "PDF edits",
 *  "RTF edits", "Word edits", "image edits", "workbook edits", or plain
 *  "edits" for a mix. */
export function unsavedEditsLabel(relPaths: readonly string[]): string {
  const kinds = new Set(relPaths.map((path) => {
    const ext = extOf(relBase(path));
    return ext === "pdf" ? "PDF" : ext === "rtf" ? "RTF" : isWordExt(ext) ? "Word" : isImageExt(ext) ? "image" : isSpreadsheetExt(ext) ? "workbook" : "";
  }));
  const [only] = kinds;
  return kinds.size === 1 && only ? `${only} edits` : "edits";
}
