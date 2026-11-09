import { IN_TAURI, VAULT_FS } from "../lib/vault";
import { copyPdfBytes } from "../lib/pdfBytes";
import { assertValidPdfSnapshot, persistPdfBytes } from "../lib/pdfSave";

export interface PdfEditorSaveJob {
  path: string;
  /** The editor's current bytes, captured after earlier queued edits settled. */
  current: Uint8Array;
  /** The bytes the session last loaded or saved; the on-disk precondition. */
  baseline: Uint8Array;
  /** False once the editor moved to another document or generation. */
  isCurrent: () => boolean;
  onSaved: (snapshot: Uint8Array) => void;
  setStatus: (status: string) => void;
}

/** Save editor bytes through the vault's verified-write filesystem. Every
 *  outcome is reported through `setStatus`; nothing publishes after the
 *  editor moved on. */
export async function savePdfEditorBytes({
  path,
  current,
  baseline,
  isCurrent,
  onSaved,
  setStatus,
}: PdfEditorSaveJob): Promise<void> {
  const snapshot = copyPdfBytes(current);
  // Both buffers are immutable snapshots: edits replace bytesRef rather
  // than mutating it, and the verified writer only reads its precondition.
  // Reusing them avoids two full-document copies on every successful save.
  const expectedCurrentBytes = baseline;
  try {
    await assertValidPdfSnapshot(snapshot);
    if (!isCurrent()) return;
    if (IN_TAURI) {
      // The expected bytes are enforced inside the verified-write
      // transaction (and checked again immediately before commit), so an
      // external rewrite cannot slip between a UI pre-check and the save.
      await persistPdfBytes(path, snapshot, VAULT_FS, { expectedCurrentBytes });
      if (!isCurrent()) return;
      onSaved(snapshot);
      setStatus("Saved.");
    } else {
      setStatus("Editing is read-only in the browser demo.");
    }
  } catch (e) {
    if (!isCurrent()) return;
    if (/changed before the verified write/i.test(String(e))) {
      setStatus(
        "Save blocked: this PDF changed on disk after it was opened. Your edits are still here — reopen the file to load the newer version, or duplicate it to keep both."
      );
    } else {
      setStatus(`Save failed: ${String(e)}`);
    }
  }
}
