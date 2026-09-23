import {
  persistVerifiedBytes,
  type VerifiedWriteFs,
  type VerifiedWriteOptions,
} from "./verifiedWrite";

export type PdfSaveFs = VerifiedWriteFs;
export type PdfSaveOptions = Pick<VerifiedWriteOptions, "expectedCurrentBytes">;

type PdfEditModule = typeof import("./pdf");
let pdfEditModulePromise: Promise<PdfEditModule> | null = null;

function loadPdfEditModule(): Promise<PdfEditModule> {
  if (!pdfEditModulePromise) {
    pdfEditModulePromise = import("./pdf").catch((error) => {
      pdfEditModulePromise = null;
      throw error;
    });
  }
  return pdfEditModulePromise;
}

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
  fs: PdfSaveFs,
  options: PdfSaveOptions = {}
): Promise<void> {
  await persistVerifiedBytes(filePath, snapshot, fs, {
    kind: "PDF",
    expectedCurrentBytes: options.expectedCurrentBytes,
    validate: async (bytes) => {
      const { assertValidPdfBytes } = await loadPdfEditModule();
      await assertValidPdfBytes(bytes);
    },
  });
}
