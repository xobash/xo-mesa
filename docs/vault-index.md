# Vault index and document working set

Mesa reuses Markdown metadata and compressed document bodies between vault opens.
The vault files remain authoritative. The index lives in local IndexedDB storage
under `mesa-vault-index`; it is a disposable copy, not a backup or a sync format.
No service or network connection is needed.

## Local storage budget

The index is governed by one 256 MB budget across all remembered vaults, not a
separate allowance per vault. After an index save, Mesa removes the oldest
disposable snapshots until the profile is within that budget. Diagnostics shows
the current approximate payload and snapshot count. **Clear local cache**
removes only these disposable indexes; it does not change vault files, notes,
or settings.

## Startup and invalidation

Each open lists current files and validates cached Markdown against native SHA-256
content fingerprints, batched at up to 128 paths per call. Hashing streams source
bytes through a 64 KiB native buffer. A warm open still reads bytes from disk;
it avoids transferring unchanged decoded bodies and rebuilding their metadata.
Size and modification time alone never authorize reuse.

Misses are read and encoded in groups of at most 64 documents and approximately
4 MiB of source bytes. An oversized document runs alone. The complete note model
is published before the initial graph frame. Cached image targets are resolved
against the current file listing, so image additions and moves remain visible.
Non-Markdown search text continues to load after the workspace becomes usable.

External changes and edits update the shared cache. Saved edits are checked
against their current revision before compaction. A cancelled vault generation
cannot publish its work into the new vault. On the next open, changed bytes rebuild
only their affected entries; deleted paths are absent from the new snapshot.

## Memory and editing

The cache retains compressed text and small search/task records. Decoded strings
use a least-recently-used pool capped at **8 × 1,024 × 1,024 JavaScript characters**.
A document larger than that is decoded for its caller but is not admitted to the
pool. UTF-8 handles normal text; exact UTF-16 encoding preserves unfinished
surrogate pairs. A decode never silently substitutes or truncates cached text.

This is a decoded-cache limit, not a total application memory cap. Compressed
corpus size, note/task metadata, active editors, undo history, unsaved buffers,
worker copies and in-flight batches consume additional memory. PDF and other
binary document engines retain their own lifecycle and budgets. Non-Markdown
search admission limits also remain separate.

Edits use copy-on-write buckets instead of copying or decoding the entire cache.
Older search snapshots retain their values. Compaction runs in bounded worker
batches after a short coalescing delay. Task collection consumes pre-parsed task
records for unchanged indexed notes and reparses live edits by revision.

## Search

A conservative trigram Bloom filter rejects documents that cannot contain the
query before decoding them. Exact matching, Unicode behavior, counts, snippets,
ranking and result limits still use the shared search engine.

The search surface uses one worker. It sends the compressed corpus initially,
then only changed revisions and deletions. Superseded passes cannot publish stale
results. The worker keeps prefix-narrowing candidates internally. Closing the
surface terminates its worker; unavailable or failed workers use the sliced
compatibility scan.

Compression trades memory for decoding work. Selective or absent queries can skip
most documents; common terms can require more total processing than a fully
resident text corpus. The worker keeps that decoding off the UI thread. The
fallback cannot guarantee the same responsiveness for a single huge document.

## Persistence and recovery

Each record includes integrity protection for its compressed body, candidate
filter, metadata and tasks. Missing, incompatible or corrupt records are rebuilt.
Unavailable storage, quota errors and blocked database opens do not prevent vault
loading. Encoding worker errors and timeouts fall back to exact local encoding.

Persistence retains at most four vault roots and at most 128 MiB of estimated
compressed and metadata payload per snapshot. Documents above 32 Mi characters
are not persisted. Database overhead is additional. Removing a vault from recent
vaults deletes its index and invalidates pending saves without touching vault files.
The cache is local but not encrypted by Mesa; protect the application profile as
well as the vault if the notes are sensitive. Verified file writes, conflict
preconditions and crash recovery remain the save boundary.

## Verification and measurement

- `npm test -- documentWorkingSet vaultIndex indexCodec indexSearch tasks search`
  covers exact text, eviction, snapshot edits, reuse, invalidation, failures and
  search/task parity.
- `npm run test:index` executes the actual worker with edits, deletions, Unicode
  and cancellation through a Node message bridge.
- `npm run bench:index` compares plain and indexed caches in three alternating
  isolated processes. It uses 1,600 synthetic documents, visits every document,
  forces GC, and measures retained JS heap plus ArrayBuffers and 2,000 cache edits.
  This intentionally compressible fixture demonstrates the architecture; it is
  not a representative-vault promise or native app memory measurement.
- `/scripts/index-acceptance.html` on the development server opens the browser
  demo and exposes reuse, search-worker and decoded-pool counters. Exercise edits,
  immediate navigation, reopen, search and tasks through the application UI.
- The top-bar Diagnostics window shows the live decoded working-set size,
  indexed/plain cache mode, still-indexing count, and name-only large-file
  count for the active renderer.

Native macOS and physical Windows startup/input performance require separate
measurements. Browser and Node results do not establish those acceptance claims.
