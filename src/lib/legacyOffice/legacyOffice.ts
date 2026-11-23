import { LegacyOfficeError, openCompoundFile, type CompoundFile } from "./cfb";
import { readExcelBinary, type LegacyWorkbook } from "./excelBinary";
import { readPowerPointBinary, type LegacyPresentation } from "./pptBinary";
import { readWordBinary, type LegacyWordDocument } from "./wordBinary";
import { legacyOfficeKind, type LegacyOfficeKind } from "../officeFallbackReason";

// One entry point for legacy binary Office files: open the compound file,
// refuse encrypted ones with a plain reason, then read the format the
// extension names. Read-only: nothing here writes or changes the bytes.

export type LegacyOfficeContent =
  | { readonly kind: "word"; readonly document: LegacyWordDocument }
  | { readonly kind: "excel"; readonly workbook: LegacyWorkbook }
  | { readonly kind: "powerpoint"; readonly presentation: LegacyPresentation };

function refuseEncryptedPackage(cfb: CompoundFile): void {
  if (cfb.rootChildren.has("ENCRYPTEDPACKAGE") || cfb.rootChildren.has("ENCRYPTIONINFO")) {
    throw new LegacyOfficeError("encrypted", "This Office file is password-protected (encrypted). Mesa cannot read encrypted files; remove the password in Office, then open it again.");
  }
}

/** Reads a legacy .doc, .xls or .ppt file by its extension. Throws `LegacyOfficeError` with a user-facing message. */
export function openLegacyOffice(bytes: Uint8Array, ext: string): LegacyOfficeContent {
  const kind: LegacyOfficeKind | null = legacyOfficeKind(ext);
  if (!kind) throw new LegacyOfficeError("unsupported", `Mesa does not read .${ext} files as Office documents.`);
  const cfb = openCompoundFile(bytes);
  refuseEncryptedPackage(cfb);
  if (kind === "word") return { kind, document: readWordBinary(cfb) };
  if (kind === "excel") return { kind, workbook: readExcelBinary(cfb) };
  return { kind, presentation: readPowerPointBinary(cfb) };
}

export { LegacyOfficeError };
