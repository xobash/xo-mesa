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
  pdf-lib parse before Mesa accepts bytes as valid. This judges the bytes Mesa
  AUTHORED — the staged temp file and the committed target — at both stages, so
  a bad candidate is caught before and after the commit. It deliberately does
  NOT judge the backup, restore, or rescue copies: those hold the user's
  existing file, byte-for-byte equality already proves the copy is faithful,
  and applying Mesa's format opinion there refused to save an edit *because the
  original displeased the validator*. That was reachable — a PDF carrying more
  than 4 KiB of debris after `%%EOF` (incremental-update leftovers, a server
  footer) parses and edits fine but fails the EOF check, so Mesa opened it,
  edited it, and then failed every save with "Backup PDF write verification
  failed", a message implying a disk fault.
- If the final path reads back truncated, invalid, or mismatched, Mesa restores
  the verified backup instead of leaving a corrupted file in the vault. A
  brand-new file that fails verification is removed, not left as debris.
- If that rollback ALSO fails, the backup is the only surviving copy of the
  user's file, so it is kept as a `rescue` artifact instead of being cleaned
  up, and the error names its path. This is the realistic full-disk case: the
  same condition that makes the committed target read back wrong makes the
  rollback write fail too, and deleting the backup there turned a failed save
  into permanent data loss. The backup is promoted by rename where possible,
  because copying a large file needs space the disk does not have; if no
  rescue copy can be made, the backup is kept under its own name.
- In-flight artifacts are dot-prefixed siblings (`.name.ext.mesa-save-…tmp`,
  `.name.ext.mesa-backup-…tmp`, `.name.ext.mesa-rescue-…tmp`), so the vault
  scan, the file watcher, the sidebar, the graph, and device sync never see
  Mesa's write machinery.
- Crash recovery: when a vault opens, Mesa sweeps for artifacts left behind by
  a crash or power loss mid-save (`src/lib/writeRecovery.ts` decides, purely
  and unit-tested; `recoverWriteArtifacts` in `src/lib/vault.ts` executes). A
  stale backup whose target file is missing is restored — that is the user's
  original file and is never thrown away. Redundant stale artifacts (including
  Rust-side `.mesa-sync-tmp-…` temps) are removed. Artifacts younger than 60
  seconds are left alone in case another Mesa instance is mid-save. A `rescue`
  artifact is restored the same way when its target is missing, but is never
  removed while the target exists: unlike a backup, it sits next to bytes Mesa
  could not verify, so it may still be the user's only good copy.
- Stale-overwrite protection: saving a PDF that another tool has rewritten
  since Mesa opened it is refused with an explanation instead of silently
  destroying the newer on-disk version. The opened-byte expectation is checked
  inside the verified-write transaction and checked again immediately before
  commit, after backup/temp validation. A concurrent rewrite detected before
  Mesa attempts the target commit is preserved exactly; rollback never writes
  the old baseline over a target Mesa has not touched. The unsaved edits stay
  in the editor.
- `persistVerifiedBytes` supports an optimistic-concurrency precondition checked
  before it writes a backup, temp, or target: exact expected current bytes for
  an update, or an expected-missing target for a create. It rechecks the same
  precondition immediately before the commit; a file created or rewritten
  during staging is neither overwritten, restored, nor removed. If atomic
  rename fails, the precondition is checked once more before the fallback
  rewrite. PDF saves and Deep Research use this on every update/create, so
  stale editor/store state cannot authorize an overwrite.
- Device sync writes on the Rust side are atomic too: sibling temp file +
  rename (`sync_core.rs::atomic_write`), so a dropped connection cannot
  truncate a note.

## Text writes never reach a non-text file

The guarantees above are about writing bytes *correctly*. This one is about
never deciding to write the wrong bytes in the first place — the failure mode
they cannot catch, because a verified write of the wrong content verifies
perfectly.

- `isTextualVaultFile` (`src/lib/vault.ts`) is the one definition of "Mesa may
  read and write this file as text": markdown, `isTextExt`, and rtf. The read
  side (`selectFile` deciding whether to load a file's content) and every write
  side ask that same question, so they cannot disagree about what a file is.
- `writeNote` fails closed on anything else. It is the last checkpoint every
  text write passes through, so no caller — present or future — can reach the
  disk with a text-encoded overwrite of a PDF, image, or archive. Binary
  editing has its own byte-level path (`pdfSave.ts` → `persistVerifiedBytes`).
- The crash-safety flush (window blur / hide / quit) writes only what
  `flushableNoteText` allows: never a non-text file, and never a file whose
  text Mesa has not actually loaded. "No cached text" means *unknown*, never
  *empty document* — a note whose opening read is still in flight is not a note
  the user just cleared. An empty **cached** string is a real edit and is
  written normally.
- `ensureContent` never pulls a non-text file through the text pipeline.
  `readNote` decodes bytes as UTF-8, so caching that for a PDF would hand every
  text consumer a lossy "document"; the activity bridge calls `ensureContent`
  for whatever path an agent touches, which is how a binary could get in.

Regression net: `isTextualVaultFile` / `flushableNoteText` / `writeNote`
fail-closed in `src/lib/vault.test.ts`; the call sites in `store.ts` in
`src/lib/textWriteContract.test.ts`.

## External changes while a PDF is open

- If a clean (unedited) PDF changes on disk, the viewer reloads the new bytes
  automatically and clears the now-stale undo history.
- If the PDF has unsaved edits, Mesa keeps the edits visible, says so in the
  status line, and blocks saving until the file is reopened — nothing on disk
  is clobbered and nothing in the editor is lost.
- Async edit/history/save work is scoped to the PDF path that started it. A
  late transform from a previously selected PDF is discarded and cannot
  replace the current PDF's in-memory bytes.
- Mesa's own save echoing back through the file watcher is recognized by byte
  equality and ignored (undo history survives saves).
- Hover thumbnails are invalidated when a PDF changes on disk.

## Writes Mesa does not make itself: the embedded Pi agent

Everything above covers writes Mesa's own code performs. It does not cover
Pi: the embedded agent runs as a real, unsandboxed native process
(`src-tauri/src/terminal.rs`, cwd = the vault folder) driven by whatever
provider/model the user configured in the terminal. When Pi's own `write` or
`edit` tool touches a file, the bytes land on disk straight from that
external process — never through `persistVerifiedBytes` — so a bad tool call,
a hand-rolled extraction script, or a model mistake can overwrite a vault file
with none of the guarantees above. Binary files like PDFs are the most
visible casualty, since a text-oriented tool is the least equipped to
round-trip them safely, but the gap is general: any file Pi's tools touch is
exposed.

Mesa cannot stop an external process from writing good bytes. What it can do —
and does — is remove the opportunity to write bad ones:

- `src-tauri/resources/mesa-activity.ts` (the bundled Pi extension that also
  powers living-graph read/write reporting) intercepts Pi's `tool_call` event,
  which fires *before* a built-in tool runs. When the tool is a content write
  (`write`/`edit`/`apply_patch`) and the target path has a binary extension,
  the extension returns `{ block: true, reason }` and the write never happens.
- The decision is a pure, unit-tested contract in `src/lib/agent.ts`
  (`piBinaryWriteBlock` / `PI_BLOCKED_BINARY_EXTENSIONS`). The extension is
  compiled into the Rust binary via `include_str!` and cannot import from
  `src/lib`, so it hand-mirrors the list, the predicate, and the reason string;
  `harnessContract.test.ts` compares the two copies and fails on any drift.
- The `reason` string is the model's only feedback, so it states the constraint
  and both routes that do work: a format-aware tool via `bash` (qpdf,
  ImageMagick, a Python library), or Mesa's own editor. Without that, a capable
  agent simply retries the same corrupting write with different content.
- `bash` is never blocked. The agent can still transform binary files with real
  format-aware tools — only the text-encoder path is closed.
- Text files are untouched by this rule. Pi editing notes is the intended
  workflow and round-trips safely; formats that merely look like documents
  (`.rtf`, `.svg`, `.csv`, `.json`, `.xml`) are text and stay writable.

Reads are never blocked, and non-binary writes still get no verified-write
coverage — Mesa's code never touches those bytes on the way to disk. The
guarantee here is specifically that Pi cannot destroy a binary file.

### Removed: Pi-write snapshots

Earlier versions took a defensive `.name.ext.mesa-pi-snapshot-…bak` copy before
every Pi write and offered a "Restore previous version" button. That net did
not work in the case it existed for, because it kept the wrong copy: restore
returned the *newest* snapshot, which after a second Pi write is already the
corrupted state, and the count cap (newest 5 per file) evicted the one pristine
pre-corruption copy once an agent wrote the same file six times. It was removed
in favour of the block above — prevention, rather than a recovery point that
was usually already poisoned.

Existing `.mesa-pi-snapshot-…bak` files are left on disk untouched: for a file
corrupted before the block landed, the oldest such sibling may be the last good
copy. They are dot-prefixed, so scan/watch/sync ignore them.

## Scope

- Mesa's own writes (note saves, PDF saves, file duplication, drag-and-drop
  imports, zip extraction) are covered by the verified-write guarantees above.
  Deletes and renames initiated by the user in the UI are ordinary filesystem
  operations (rename copies-then-deletes via the verified path).
- Writes made by the embedded Pi agent's own tools never go through
  `persistVerifiedBytes` (Mesa's code never touches those bytes on the way to
  disk, so it cannot verify or roll them back the same way). Binary files are
  protected by blocking those writes outright — see the section above. Text
  writes by Pi proceed unverified, exactly as any other external editor's do.
