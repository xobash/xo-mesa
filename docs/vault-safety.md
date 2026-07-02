# Vault Safety

Mesa treats in-vault writes as untrusted until the file reads back with the
exact bytes Mesa intended to write, and commits them atomically so a crash can
never leave a half-written file where a note or PDF used to be.

## Guarantees

- Every vault write (note saves, PDF saves, file duplication, drag-and-drop
  imports, zip extraction) goes through one verified-write primitive
  (`src/lib/verifiedWrite.ts`).
- The sequence for an overwrite: write + verify a sibling backup of the
  original bytes → write + verify (and validate) the candidate bytes to a
  sibling temp file → atomically rename the verified temp over the target →
  read the target back byte-for-byte one final time. There is no instant at
  which the target holds partial bytes: it is either the old file or the
  fully-verified new file. If rename is unavailable, Mesa falls back to a
  rewrite that is still read-back verified and backup-protected.
- PDF saves additionally require a `%PDF-` header, `%%EOF` marker, and a full
  pdf-lib parse before Mesa accepts bytes as valid — at every stage, not just
  the final one.
- If the final path reads back truncated, invalid, or mismatched, Mesa restores
  the verified backup instead of leaving a corrupted file in the vault. A
  brand-new file that fails verification is removed, not left as debris.
- In-flight artifacts are dot-prefixed siblings (`.name.ext.mesa-save-…tmp`,
  `.name.ext.mesa-backup-…tmp`), so the vault scan, the file watcher, the
  sidebar, the graph, and device sync never see Mesa's write machinery.
- Crash recovery: when a vault opens, Mesa sweeps for artifacts left behind by
  a crash or power loss mid-save (`src/lib/writeRecovery.ts` decides, purely
  and unit-tested; `recoverWriteArtifacts` in `src/lib/vault.ts` executes). A
  stale backup whose target file is missing is restored — that is the user's
  original file and is never thrown away. Redundant stale artifacts (including
  Rust-side `.mesa-sync-tmp-…` temps) are removed. Artifacts younger than 60
  seconds are left alone in case another Mesa instance is mid-save.
- Stale-overwrite protection: saving a PDF that another tool has rewritten
  since Mesa opened it is refused with an explanation instead of silently
  destroying the newer on-disk version. The unsaved edits stay in the editor.
- Device sync writes on the Rust side are atomic too: sibling temp file +
  rename (`sync_core.rs::atomic_write`), so a dropped connection cannot
  truncate a note.

## External changes while a PDF is open

- If a clean (unedited) PDF changes on disk, the viewer reloads the new bytes
  automatically and clears the now-stale undo history.
- If the PDF has unsaved edits, Mesa keeps the edits visible, says so in the
  status line, and blocks saving until the file is reopened — nothing on disk
  is clobbered and nothing in the editor is lost.
- Mesa's own save echoing back through the file watcher is recognized by byte
  equality and ignored (undo history survives saves).
- Hover thumbnails are invalidated when a PDF changes on disk.

## Scope

- This covers every write Mesa itself performs inside the vault. Deletes and
  renames initiated by the user in the UI are ordinary filesystem operations
  (rename copies-then-deletes via the verified path).
