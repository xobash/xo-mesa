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

// Exact in-memory buffers already parsed by assertValidPdfSnapshot. Callers
// must not mutate a buffer after validating it.
const validatedSnapshots = new WeakSet<Uint8Array>();

/** Parse a save snapshot once; persistPdfBytes does not parse that same buffer again. */
export async function assertValidPdfSnapshot(snapshot: Uint8Array): Promise<void> {
  const { assertValidPdfBytes } = await loadPdfEditModule();
  await assertValidPdfBytes(snapshot);
  validatedSnapshots.add(snapshot);
}

/** Read back, parse, and byte-compare saved PDF output before reporting success.
 * Bytes read back from disk are always parsed. */
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
      if (validatedSnapshots.has(bytes)) return;
      const { assertValidPdfBytes } = await loadPdfEditModule();
      await assertValidPdfBytes(bytes);
    },
  });
}
