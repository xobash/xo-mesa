import type { ByteSource } from "./byteSource";
import { readZipEntry, type ZipListing } from "./zipView";

// Password-protected OpenDocument files (ODF 1.2 Part 3, 3.8) keep their
// manifest readable and list `manifest:encryption-data` for each encrypted
// part. Mesa does not decrypt them; it says so instead of showing scrambled
// entries without a reason.

const ODF_EXTS = /^(odt|ods|odp|odg|ott|ots|otp|otg)$/i;
const MANIFEST = "META-INF/manifest.xml";

export const ODF_ENCRYPTED_REASON =
  "This OpenDocument file is password-protected. Mesa does not decrypt OpenDocument files, so its contents stay unreadable here; the file is read-only and never changed.";

/** The reason to show when `listing` is an encrypted OpenDocument package, else `null`. */
export async function odfEncryptionReason(ext: string, source: ByteSource, listing: ZipListing): Promise<string | null> {
  if (!ODF_EXTS.test(ext)) return null;
  const manifest = listing.entries.find((e) => e.name === MANIFEST && !e.directory);
  if (!manifest) return null;
  try {
    const text = new TextDecoder("utf-8").decode(await readZipEntry(source, manifest));
    return /<(?:[\w.-]+:)?encryption-data[\s/>]/.test(text) ? ODF_ENCRYPTED_REASON : null;
  } catch {
    return null;
  }
}
