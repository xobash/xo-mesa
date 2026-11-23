import { CfbError, isCfb, readCfb } from "./cfb";
import { isSpreadsheetExt, isWordExt } from "./vaultFileKinds";
import { isPresentationExt } from "./officeFormats";

// Detects password protection in legacy binary Office files so the details
// view can say why Mesa shows them read-only. Mesa never decrypts RC4.
//   Word: FibBase.fEncrypted (MS-DOC 2.5.2, bit 0x0100 of the flags at 0x0A).
//   Excel: a FilePass record in the workbook globals (MS-XLS 2.4.117, 0x002F).
//   PowerPoint: an EncryptedSummary stream (MS-PPT 2.1.3).
//   Encrypted OOXML: EncryptionInfo + EncryptedPackage (MS-OFFCRYPTO 2.3.4.4).

const MAX_GLOBAL_RECORDS = 4096;
const FILEPASS = 0x002f;
const EOF = 0x000a;

export const LEGACY_ENCRYPTED_REASON =
  "This Office file is password-protected with legacy encryption (RC4 or XOR). Mesa does not decrypt it; the file is read-only here and never changed. To edit it in Mesa, save it from Office as .docx, .xlsx or .pptx.";
export const OOXML_IN_CFB_REASON =
  "This is a password-protected .docx, .xlsx or .pptx file under a different extension. Rename it to its Office extension to open it with its password.";

function excelHasFilePass(stream: Uint8Array): boolean {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let at = 0;
  for (let n = 0; n < MAX_GLOBAL_RECORDS && at + 4 <= stream.length; n++) {
    const type = view.getUint16(at, true);
    if (type === FILEPASS) return true;
    if (type === EOF) return false;
    at += 4 + view.getUint16(at + 2, true);
  }
  return false;
}

/** The reason to show for a password-protected compound file, else `null`.
 *  Encrypted OOXML under its own extension gets no reason here: the Office
 *  views open it with its password. */
export function legacyEncryptionReason(bytes: Uint8Array, ext = ""): string | null {
  if (!isCfb(bytes)) return null;
  try {
    const cfb = readCfb(bytes);
    if (cfb.read("EncryptionInfo") && cfb.read("EncryptedPackage")) {
      return isWordExt(ext) || isSpreadsheetExt(ext) || isPresentationExt(ext) ? null : OOXML_IN_CFB_REASON;
    }
    const word = cfb.read("WordDocument");
    if (word && word.length >= 12 && (new DataView(word.buffer, word.byteOffset).getUint16(10, true) & 0x0100)) return LEGACY_ENCRYPTED_REASON;
    const book = cfb.read("Workbook") ?? cfb.read("Book");
    if (book && excelHasFilePass(book)) return LEGACY_ENCRYPTED_REASON;
    if (cfb.read("EncryptedSummary")) return LEGACY_ENCRYPTED_REASON;
    return null;
  } catch (error) {
    if (error instanceof CfbError) return null;
    throw error;
  }
}
