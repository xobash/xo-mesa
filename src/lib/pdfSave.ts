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

/** Read back, parse, and byte-compare saved PDF output before reporting success. */
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
