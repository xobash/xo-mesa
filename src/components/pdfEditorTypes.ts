export interface PdfEditorOptions {
  enabled?: boolean;
  extractText?: boolean;
  /** Extract fillable form fields (a full pdf-lib parse on the main thread).
   *  Off by default so the read-only viewer never pays for it; the editor
   *  turns it on when entering edit mode. */
  formFields?: boolean;
  /** Changes when the file changes on disk (e.g. its mtime). A change makes
   *  the hook re-check the disk bytes: our own save echo is ignored, a clean
   *  document adopts the new bytes, and unsaved edits are preserved. */
  reloadToken?: number;
}

export interface PdfApplyOptions {
  pages?: number[];
  structural?: boolean;
}

export type PdfTransform = (current: Uint8Array) => Promise<Uint8Array>;
