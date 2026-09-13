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
  fully-verified new file. If rename is unavailable, Mesa can use a verified
  rewrite. Before that rewrite touches an existing target, Mesa promotes the
  verified backup to a `rescue`. Recovery never deletes this rescue beside an
  unverified target. If Mesa cannot make the rescue, the rewrite stops before
  it touches the target.
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
- Crash recovery runs when a vault opens. `src/lib/writeRecovery.ts` makes the
  plan, and `recoverWriteArtifacts` in `src/lib/vault.ts` applies the plan:
  - The vault scan finds the artifacts. `vault_scan` reads every directory to
    make the file listing. The same operation collects the artifacts. Recovery
    does not read the directories a second time.
  - The scan reports "unknown" if it cannot supply a list. The browser demo and
    a shell without the native command both cause this result. Recovery then
    reads the directories itself. Mesa always examines a vault before Mesa
    opens the vault.
  - Recovery runs after the scan. The file listing is therefore older than a
    file that recovery restores. Mesa reads the vault again when recovery
    restores one or more files. A restored file gets an index entry, a search
    entry, and a sidebar row, exactly like every other file.
  - Recovery groups original-holding artifacts by directory and target. If the
    target is missing, recovery selects one candidate. A `rescue` has priority
    over a `backup`. The newest timestamp and ID in the artifact name break
    ties. Recovery keeps all nonselected original-holding artifacts.
  - The target create uses the filesystem create-new operation. This operation
    atomically refuses an existing file, directory, or symbolic link. The
    compatibility fallback also uses create-new. Thus, neither path can
    overwrite a target that appears after discovery.
  - Before recovery uses a backup, it makes and verifies a `rescue` sibling.
    Recovery then creates the target and reads all target bytes back. It removes
    the selected original-holding artifacts only after this final byte-for-byte
    check succeeds. A failed or corrupt write keeps the original artifact and
    the rescue.
  - Recovery leaves a `rescue` in place while its target exists. A non-atomic
    overwrite fallback creates this label before it touches an existing target.
    Recovery removes stale backups with existing targets because no fallback
    can enter its crash window while the original still has a backup label.
    Recovery also removes stale disposable artifacts, including Rust-side
    `.mesa-sync-tmp-…` files.
  - Recovery leaves artifacts younger than 60 seconds in place. If one
    original-holding artifact for a target is fresh, recovery leaves that full
    group in place because another Mesa instance can be writing the target.
    Recovery also preserves an artifact when its modification time cannot be
    read; an unknown age is not proof that another save has finished.
- Stale-overwrite protection: saving a PDF or text file that another tool has
  rewritten since Mesa opened it is refused with an explanation instead of silently
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
  rewrite. PDF saves, editor text saves, and Deep Research use this on every
  update/create, so stale editor/store state cannot authorize an overwrite.
- Device sync writes on the Rust side are non-destructive verified creates
  (`sync_core.rs::commit_verified_create`): incoming bytes are staged in a
  unique sibling and read back, then published only if the manifest-expected
  target is still missing. Publication uses each OS's atomic no-replace rename,
  with a hard-link fallback only when the volume does not support that native
  primitive; FAT/exFAT removable vaults therefore work without hard links. The
  target is read back again. An identical target is an idempotent success; a
  different target is preserved and the transfer fails (server `PUT` returns
  `409`). If final read-back fails, Mesa preserves and reports the target rather
  than risk deleting a concurrent replacement without portable file-identity
  proof. Same-day conflict-name collisions use numbered siblings, and an
  already-identical numbered copy is skipped before transfer.

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
- `textSaveCoordinator` keeps one dirty record per absolute file path. Editing
  one tab cannot cancel another tab's debounce. Writes are serialized, a newer
  revision waits for the in-flight revision, and each successful write advances
  the exact expected disk baseline used by the next verified write. A failure
  stays dirty and retryable. Before a successful text save replaces a prior
  disk version, Mesa records that prior text in bounded local revision history.
  History storage is best-effort and runs after verified-save success: a full
  browser-storage quota cannot report the on-disk save as failed or cause a
  duplicate retry. Revisions are listed newest-first with a deterministic
  tie-breaker, so rapid saves with the same clock timestamp still restore the
  intended local snapshot.
  (20 versions per file, capped by a shared local character budget). Settings
  can restore a revision for the active text file through the same verified
  save queue, so restoration still refuses stale disk baselines.
- Blur, hide, and close flush every dirty path and do no work when the window is
  clean. Vault switch and rename wait for the relevant saves. The main native
  window prevents close until all dirty writes succeed; a failed write leaves
  the window and editor open. `flushableNoteText` still refuses a non-text file.
- `ensureContent` never pulls a non-text file through the text pipeline.
  `readNote` decodes bytes as UTF-8, so caching that for a PDF would hand every
  text consumer a lossy "document"; the activity bridge calls `ensureContent`
  for whatever path an agent touches, which is how a binary could get in.

Regression net: `isTextualVaultFile` / `flushableNoteText` / `writeNote`
fail-closed in `src/lib/vault.test.ts`; queue and lifecycle behavior in
`src/lib/textSaveCoordinator.test.ts` and `src/lib/textWriteContract.test.ts`.

Two operations that LOOK like text operations are held to the same rule:

- **Rename** is a byte move, never a re-encode. `renameVaultFile`
  (`src/lib/vault.ts`) performs one atomic OS rename — the same primitive the
  verified-write pipeline trusts for its commit step — and refuses to
  overwrite an existing target. Case-only renames use a same-folder temporary
  hop so case-insensitive filesystems can still change spelling without
  treating the destination as an overwrite. The store's `renameNote` uses it
  for every file type and preserves the file's real extension. Markdown note renames
  also update inbound wiki and Markdown links that resolve to the old note
  through verified text writes, preserving aliases, headings, balanced
  parenthesized Markdown destinations, URL-encoded spaces, and relative path
  style where the existing link used one. Link repair skips embeds, fenced
  code, and inline code examples. Each rename builds one note resolver and
  reuses it for all inbound references in that operation. If an inbound-link
  write sees a concurrent external edit, the rename remains byte-safe and Mesa
  reports the partial link update instead of overwriting the edited file. Its previous
  implementation read the file as text, wrote the text under the new name,
  and removed the original; for a binary the text read yields "" by design,
  so renaming a PDF replaced it with an empty markdown file. Pinned by
  `src/lib/renameNote.test.ts`.
- **Delete** is recoverable. Mesa moves files and folders into a hidden
  `.mesa-trash/` recovery area on the same vault volume and removes them from
  the workspace only after that move succeeds. A locked file, permission error,
  unavailable volume, or occupied recovery destination fails closed and leaves
  the workspace state unchanged. The recovery area is dot-prefixed, so normal
  vault scan, watch, graph, and sync paths ignore it. Settings includes a
  recovery storage view that lists hidden files and whole deleted folders.
  Folder deletions restore as one folder entry, not as a pile of individual
  nested files. Restore moves the entry back to its original path, or to the
  next unique sibling when that path is already occupied. Manual restore is
  owned by the store: it flushes pending text saves first, then moves the
  recovered entry and refreshes the vault from that single path. Sync journal
  reconciliation retracts any unsynced local delete/rename operation whose
  original bytes are present again, so a restored file is not immediately
  removed by Mesa's own pending operation log.
- **Undo never crosses a document boundary.** The editor swaps notes into one
  long-lived CodeMirror view; if the swap is undoable, one extra Cmd+Z after
  switching notes reverts the swap itself and the previous note's text is
  saved over the current note. A note switch now replaces the editor state
  (fresh history) and a same-note external refresh is dispatched outside the
  history, so undo can neither cross files nor resurrect stale pre-watcher
  text. Pinned by `src/components/editorUndoBoundary.test.tsx`.

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
- If an external text refresh cannot read the changed file, Mesa keeps the
  cached text and reports the read failure. It never treats that failure as a
  real empty document or uses it as a save baseline.

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
  Deletes and renames initiated by the user in the UI are filesystem moves:
  delete moves to hidden Mesa recovery storage, and rename uses one
  byte-preserving OS rename and refuses overwrite.
- Writes made by the embedded Pi agent's own tools never go through
  `persistVerifiedBytes` (Mesa's code never touches those bytes on the way to
  disk, so it cannot verify or roll them back the same way). Binary files are
  protected by blocking those writes outright — see the section above. Text
  writes by Pi proceed unverified, exactly as any other external editor's do.

## Save feedback and interrupted navigation

The status bar reports pending, saving and failed **text** changes independently
of transient import or scan messages. These indicators describe the text-save
queue; PDF editing retains its own save state. Failed text writes remain available
under save recovery. The native main-window close guard waits for verified text
writes and rechecks for edits that arrive before the final close request.

Vault selection ignores stale folder checks. An interrupted scan keeps the old
workspace, clears the loading state and restores its watcher. A retryable notice
identifies the unavailable target. A refused text flush leaves the current vault
open rather than abandoning its unsaved edits.

Settings are validated on load and preserve unknown fields from newer versions.
An unreadable settings value remains intact until an explicit save; that save first
preserves the raw value under `mesa:settings:recovery`. If preservation fails, Mesa
refuses replacement. Failed persistence shows **Settings need attention** with
**Retry settings**. Settings changes still apply to the current session.

When overlapping vault switches fail, the existing editor remains active and
its file watcher is restored, including failures before the newer scan starts.

## Disposable vault index

The local [vault index](vault-index.md) stores compressed copies and metadata in
application storage. It never writes vault files and is never a recovery source
for a failed save. Missing or invalid records rebuild from the vault. Verified
writes and their original-byte preconditions remain authoritative.
