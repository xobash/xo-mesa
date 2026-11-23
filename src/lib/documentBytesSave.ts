import { IN_TAURI, urlForPath, VAULT_FS } from "./vault";
import { persistVerifiedBytes, type VerifiedWriteFs } from "./verifiedWrite";

export interface DocumentBytesSave {
  /** Absolute file path. */
  path: string;
  bytes: Uint8Array;
  /** Bytes the editor opened or last saved; `null` requires a new file. */
  expected: Uint8Array | null;
  /** Shown in errors, e.g. "RTF" or "image". */
  kind: string;
  /** Format check of the candidate bytes before they are committed. */
  validate?: (bytes: Uint8Array) => Promise<void> | void;
}

/** A save refused because the file on disk is not what the editor opened. */
export class DocumentChangedOnDiskError extends Error {}

/** Save editor bytes with the opened bytes (or a missing file) as the
 *  on-disk precondition. A changed or newly created target refuses the save
 *  and leaves the caller's edits in place. */
export async function saveDocumentBytes(
  { path, bytes, expected, kind, validate }: DocumentBytesSave,
  fs: VerifiedWriteFs = VAULT_FS,
  desktop = IN_TAURI
): Promise<void> {
  if (!desktop) throw new Error("Editing is read-only in the browser demo.");
  try {
    await persistVerifiedBytes(path, bytes, fs, {
      kind,
      expectedCurrentBytes: expected,
      validate: validate ? async (candidate) => { await validate(candidate); } : undefined,
    });
  } catch (error) {
    if (/changed before the verified write|no longer matches the expected missing state/i.test(String(error))) {
      throw new DocumentChangedOnDiskError(
        expected === null
          ? "A file with that name appeared before the copy was written; nothing was overwritten."
          : `This ${kind} changed on disk after it was opened, so nothing was overwritten. Your edits are still here.`
      );
    }
    throw error;
  }
}

/** Read a document's exact bytes: native fs on desktop, the asset URL in the browser demo. */
export async function readDocumentBytes(path: string, desktop = IN_TAURI): Promise<Uint8Array> {
  if (desktop) return VAULT_FS.readFile(path);
  const response = await fetch(urlForPath(path));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
