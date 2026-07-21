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
- `persistVerifiedBytes` supports an optimistic-concurrency precondition checked
  before it writes a backup, temp, or target: exact expected current bytes for
  an update, or an expected-missing target for a create. Deep Research uses
  this on every reviewed operation, so a stale store cache or a file created
  after review cannot authorize an overwrite.
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

Mesa cannot stop an external process from writing bad bytes to disk. What it
can do — and does — is make sure that write is always recoverable:

- `src-tauri/resources/mesa-activity.ts` (the bundled Pi extension that also
  powers living-graph read/write reporting) intercepts Pi's `tool_call` event,
  which fires *before* a built-in `read`/`write`/`edit` tool runs. On a
  `write`/`edit` against a file that already exists, it synchronously copies
  the file's current on-disk bytes to a dot-prefixed sibling snapshot before
  the tool proceeds. This is best-effort and never blocks or alters the tool
  call — same "observe, never gate" contract as the activity reporting it
  shares a hook with.
- Naming/retention is a pure, unit-tested contract in `src/lib/agentBackup.ts`
  (`.name.ext.mesa-pi-snapshot-<epoch-ms>-<rand>.bak`) — dot-prefixed, so the
  same scan/watch/sync skip rules that hide Mesa's own write artifacts hide
  these too. It is a deliberately distinct scheme from
  `verifiedWrite.ts`'s `mesa-(save|backup)-…tmp` names: `writeRecovery.ts`'s
  crash-recovery sweep assumes a stale backup is redundant once its target
  exists, which is true for Mesa's own atomic writes but not for a Pi-write
  snapshot (the target existing says nothing about whether those bytes are
  trustworthy) — the two schemes must never collide.
- `pruneAgentSnapshots` in `src/lib/vault.ts` sweeps the vault at open (right
  alongside `recoverWriteArtifacts`) and removes anything past the retention
  window: at most 5 snapshots kept per file, and none older than 14 days
  regardless of count.
- Snapshots are never restored automatically — that stays a deliberate action
  so Mesa never silently discards a Pi edit the user actually wanted.
  `findLatestAgentSnapshot`/`restoreLatestAgentSnapshot` in `src/lib/vault.ts`
  locate and restore the newest snapshot for a file; the restore write itself
  goes through `persistVerifiedBytes`, so the *recovery* gets Mesa's normal
  backup/atomic-rename/read-back guarantees even though the original
  corrupting write did not. `PdfView` surfaces this as a "Restore previous
  version" button whenever the PDF it has open turns out not to be valid.

## Scope

- Mesa's own writes (note saves, PDF saves, file duplication, drag-and-drop
  imports, zip extraction) are covered by the verified-write guarantees above.
  Deletes and renames initiated by the user in the UI are ordinary filesystem
  operations (rename copies-then-deletes via the verified path).
- Writes made by the embedded Pi agent's own tools are covered by the
  snapshot-and-restore safety net in the section above, not by
  `persistVerifiedBytes` (Mesa's code never touches those bytes on the way to
  disk, so it cannot verify or roll them back the same way).
