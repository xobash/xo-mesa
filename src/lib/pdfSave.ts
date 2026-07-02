import { assertValidPdfBytes } from "./pdf";
import { persistVerifiedBytes, type VerifiedWriteFs } from "./verifiedWrite";

export type PdfSaveFs = VerifiedWriteFs;

/**
 * Persist a PDF with post-write verification and automatic restore.
 *
 * Mesa has seen cases where a write path leaves a PDF truncated on disk. This
 * helper treats "write succeeded" as untrusted until the bytes are read back,
 * reparsed as a PDF, and matched byte-for-byte with the intended payload.
 */
export async function persistPdfBytes(
  filePath: string,
  snapshot: Uint8Array,
  fs: PdfSaveFs
): Promise<void> {
  await persistVerifiedBytes(filePath, snapshot, fs, {
    kind: "PDF",
    validate: async (bytes) => {
      await assertValidPdfBytes(bytes);
    },
  });
}
