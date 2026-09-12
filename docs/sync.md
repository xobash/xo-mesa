# Device Sync

Mesa syncs your own devices over LAN or Tailscale. Every transfer is
**end-to-end encrypted over TLS** (LocalSend-style), so vault contents and your
sync key are never sent in the clear.

## Security Model

**Transport encryption (TLS).** On first launch each device mints a persistent,
self-signed certificate — its *identity* — stored in the app config directory
(`sync-identity/cert.pem` + `key.pem`). The embedded sync server serves over
HTTPS using that certificate. Because the certificate is self-signed, a normal
CA check would reject it, so the client instead **pins the certificate's SHA-256
fingerprint**:

- **Trust-on-first-use.** The first time you contact a peer, Mesa records the
  fingerprint it presents (from the manifest handshake, before any file data
  moves) and remembers it on that peer.
- **Enforced thereafter.** Every later sync — and every individual file transfer
  within a sync — pins that fingerprint. A mismatch aborts the TLS handshake
  *before* any vault data is sent, which detects an active man-in-the-middle
  (or a device that reinstalled Mesa and got a new certificate).
- **Out-of-band verification.** The Sync panel shows each device's fingerprint
  (yours under *Receive*, each peer's in its card). Compare them across two
  devices to be certain you trusted the right one, exactly like LocalSend.

Handshake signatures are verified normally, so a party holding only a peer's
public certificate cannot impersonate it — possession of the private key is
proven during the handshake.

**Authorization (sync key).** TLS encrypts the channel; the sync key authorizes
*who* may read or write the vault. Every request carries it as a bearer token,
and because the channel is encrypted the token is never exposed on the wire. Use
the same key on every device.

**Why the whole engine runs natively.** The sync client (`sync_fetch_manifest`,
and `sync_run`, which performs the entire sync — local hashing, diff, and every
per-file pull/push — internally) runs in Rust via reqwest, not the webview's
`fetch`. The system webview refuses to reach a self-signed LAN HTTPS peer
(WKWebView App Transport Security; WebView2 mixed-content / Private Network
Access), and only a native client can express handshake-time fingerprint
pinning. File bytes and hashing never round-trip through the webview — which
also matters for speed with large vaults.

`sync_run` is single-flight within one Mesa process. A second request is
rejected while a run is active. This protects the shared cancellation command:
one run cannot clear or receive the cancellation state of another run.

**Master switch.** The **Sync** switch is a hard override. When off, Mesa stops
listening, stops LAN discovery, blocks manual sync, and suppresses scheduled
sync even if saved peers exist.

**Discovery is metadata-only.** While the Sync menu is open or listening is on,
Mesa announces its device name — a LocalSend-style name like "Toasty Lemon",
minted once at first launch (`lib/deviceName.ts`, persisted as
`settings.syncDeviceName`) and editable in the Receive section, so multiple
devices are distinguishable at a glance — plus its LAN address, port, listening status, and
certificate fingerprint over UDP broadcast (port 47887). It never broadcasts the
vault path, sync key, or file contents. A discovery packet is unauthenticated,
so the advertised fingerprint is a convenience for first contact — verify it
out-of-band for certainty.

## Default Flow

The Sync menu is intentionally short by default:

1. Turn on **Sync**.
2. Set one sync key (the same on every device).
3. Turn on **Receive**.
4. Add nearby devices when they appear, or share the short pairing code.
5. Optionally compare the device fingerprints across both machines.

Port, manual addresses, LAN discovery, and scheduled sync remain under the
Advanced disclosure so the default path stays readable.

## Address Handling

- Sync is HTTPS-only; bare addresses (LAN IP, Tailscale name, `host:port`,
  pairing code) resolve to `https://`.
- Manual entries are validated before they become saved devices. Mesa accepts
  IPv4, bracketed IPv6, DNS/Tailscale hostnames, pairing codes, and `http(s)`
  URLs; whitespace, credentials in URLs, malformed hostnames, and ports outside
  `1`–`65535` are rejected with an inline error.
- The listener port is constrained to the same `1`–`65535` range in the UI,
  persisted-settings loader, and store boundary. Invalid values from an older
  settings file heal to the default `8787` before discovery or native startup.
- A peer's stable identity is its certificate fingerprint, not its address, so a
  device keeps its trust even if its IP changes.

## Scheduled Sync

Set `Auto-sync every` to a positive number of minutes to sync all saved peers
while Mesa is open. `0` keeps sync manual. The master sync switch overrides this
schedule. Mesa schedules the next run only after the current run finishes; an
incomplete, cancelled, or file-failed run backs off before trying again so an
offline peer or locked file cannot create a tight failure loop.

The Sync console exposes the current state explicitly: idle, preparing, waiting,
transferring, retrying, offline, incomplete, complete, cancelled, disabled, or
error. The same state is copied into the troubleshooting package, so a failed
sync can be explained without inferring status from raw log lines.

Each peer records:

- pinned certificate fingerprint (trust state)
- last successful sync time
- last checked time
- health state: healthy, error, or unknown
- the last error message, when a sync attempt fails

Sync remains non-destructive: files changed on both devices are saved as conflict
copies rather than overwritten. A second different conflict from the same peer
on the same day gets a numbered sibling (`… (2).md`, `… (3).md`) instead of
replacing the first copy.

**Deletes and renames.** Mesa keeps a hidden, vault-local operation journal
(`.mesa-sync-journal.json`). It is not a vault note and never appears in the
sidebar. Before a sync, Mesa compares its last durable manifest snapshot with
the current vault: a missing file becomes a delete tombstone; a unique missing
file plus a unique new file with the same bytes becomes a rename. This also
recovers an operation made outside Mesa or interrupted between a filesystem
change and the next sync.

Operations are exchanged separately from the file manifest. A peer delete or
rename applies only when the local source still has the exact recorded size and
hash. If local bytes changed, Mesa keeps them, reports a journal conflict, and
does not silently delete or move user content. Ambiguous same-byte copies are
never guessed to be renames. If the original bytes return before a local
delete/rename intent syncs, Mesa retracts that local operation so a restored file
is not immediately removed again. Older peers can still copy files, but do not
carry delete or rename intent until they upgrade.

## Built for Large Vaults

A vault with hundreds or thousands of files syncs comfortably:

- **One TLS session, many transfers.** A single pooled, pinned client carries
  the whole sync; up to 4 files move concurrently. (Older builds opened a fresh
  TLS connection per file, serially — the classic large-vault killer.)
- **Streamed file transfers.** Uploads hash and rewind one open file handle,
  then stream its bytes. Downloads and incoming uploads write private sibling
  files in 64 KiB blocks while calculating the hash. Downloads use a two-block
  queue between the network and disk workers, so a slow disk applies
  backpressure. File bodies never need a complete in-memory copy. The receiver
  checks the declared or manifest size and the expected hash before publication.
  Interrupted transfers remove their partial sibling; existing files remain
  unchanged. If sent bytes differ from the upload hash, the receiver rejects
  them and Mesa can use the existing retry. The PUT limit remains 1 GiB.
- **Streamed, cached, parallel hashing.** Manifests hash files in 64 KiB chunks
  (nothing is loaded whole into memory) through a `(size, mtime)` cache, so
  repeat syncs re-hash only what changed — on both the serving and the
  initiating device. The cache is consulted in one cheap metadata-only pass
  first, then the files that actually need reading are hashed with a
  conservative two-worker application budget so editing, PDF work, and Pi
  remain responsive.
  FNV-1a is a serial recurrence, so a single file's digest cannot be split, but
  whole files are independent and a manifest is thousands of them. On the
  4,094-file / 1.45 GB reference vault a cold manifest is **~3.0 s → 0.6–1.0 s**;
  a warm one is ~20 ms. Digests are byte-identical either way — this changes
  only the order the reads are dispatched in, never the wire format.
- **Timeouts everywhere.** Connect 10 s, stall 60 s, and a per-file total budget
  scaled by size. A dead peer is an error message, not an infinite silent hang.
- **Per-file failure isolation.** One unreadable or failed file is recorded in
  the report and the console; every other file still syncs.
- **Verified, create-only commits.** Every pulled file is checked against its
  manifest hash, written to a unique sibling candidate, and read back before
  publication. Mesa uses the operating system's atomic no-replace rename
  (`RENAME_NOREPLACE` on Linux, `RENAME_EXCL` on macOS, and non-replacing
  `MoveFileExW` on Windows), so FAT/exFAT removable vaults do not require hard
  links. A hard link is only a fallback when that volume reports that exclusive
  rename is unsupported; Mesa fails closed if neither safe primitive works.
  The target is read back again after publication. An identical existing file
  makes a retry succeed without rewriting it; different existing bytes fail
  with no change (`PUT /sync/file` returns `409`). If final read-back fails,
  Mesa reports the failure and preserves the target because portable file-ID
  proof is unavailable; the published candidate was complete and verified
  before it became visible. Pushed files use the same rule on the receiver.
- **Cancellable.** Cancel immediately changes the console to **Stopping** and
  removes a queued sync before native transfer begins. Once a transfer is
  admitted, cancellation is checked during manifest requests, manifest body
  reads, local work admission, retry waits, and upload/download streaming. An
  incomplete candidate is abandoned; a candidate already verified and published
  remains intact. The report marks the run cancelled and lists unfinished work
  so a later sync retries it.
- **Bounded resources.** The content-hash cache is pruned to the current vault
  snapshot and a fixed maximum. Transfer work is admitted in small batches,
  rather than creating one task per queued file. These are application safety
  budgets, not claims of a measured memory leak or native input slowdown.

Streaming preserves the endpoints, TLS pinning, FNV-1a/64 hashes, manifest
format, and conflict names. The TypeScript reference in `src/lib/sync.ts`
therefore requires no transport change. Rust regression tests cover real
loopback HTTP uploads and downloads, bounded receive buffers, interrupted and
truncated bodies, invalid hashes, and create-only publication. Loopback HTTP
tests check streaming mechanics; they do not establish physical-device TLS
acceptance.

## The Sync Console & Troubleshooting Package

The moment a sync starts, an embedded console appears in the Sync window: the
Rust engine streams structured log lines (manifest timings, the diff summary,
every transfer, every warning and failure) plus a live progress bar.

The console shows **both directions**. On the device that initiated the sync it
narrates the whole run; on the device being synced *to*, the embedded server's
`[serve]` lines (manifest served, each file received, every rejection) fill the
same console — open the Sync window on the receiving machine to watch an
incoming sync land. The event bridge registers at vault open, so lines are
collected even while the window is closed and are waiting when you open it.

**Copy troubleshooting package** copies a single markdown blob designed to be
pasted at an LLM or into a bug report: app version and environment, vault file
count, peer + trust state, settings, the full sync report (counts, bytes,
duration, every failed file with its error), and the complete log. Sync keys
are scrubbed (`[redacted]`) and the vault's absolute path is never included.
**Copy log** copies just the raw lines; **Clear** empties the console.
When a run is incomplete, the main sync status names the first failed files
directly. The console also shows a capped failed-file summary with operation and
error details, keeps the full per-file list in the troubleshooting package, and
shows **Retry failed files** when the incomplete run has failed pull, push, or
conflict-copy transfers. Retry still fetches fresh manifests and applies the
journal first, then admits only those failed transfer paths into the job list.
If the incomplete work was a scan or journal failure rather than a transfer
failure, the button says **Retry sync** and runs a normal sync.

## Review different versions

The Sync menu lists dated conflict copies whose original is still in the vault.
Use **Compare** for Markdown or plain text up to 1 MiB per file. Both originals
are shown unchanged, with highlighted line differences and a separate
**Reviewed text** editor. Start with either version, use per-change buttons to
apply the original or conflict side into the reviewed text, edit manually when
needed, then choose **Save reviewed text**. Mesa checks that the original still
matches the reviewed baseline, preserves its text in a unique
`before sync review` sibling, and saves through the verified text queue. The
conflict copy remains. **Keep both** changes no files. For other formats or
larger documents, **Open original** and **Open copy** use the normal viewers.
After a reviewed save, Mesa renames that preserved conflict copy with a
`reviewed` marker. The bytes stay in the vault, but the Sync menu no longer
lists that copy as unresolved.

A failed read, preservation write, or baseline check stops the review save.
If the final save fails, the reviewed buffer remains in save recovery. Reopen a
stale comparison instead of overriding newer disk content. This is an explicit
local text review, not an automatic three-way merge or permission to overwrite
another device. Later syncs still use the create-only conflict-copy protocol.

Outgoing sync reserves one operation before setup, saves pending text first,
and owns one cancellable background-queue admission. Cancelling while the job is
queued settles it immediately and performs no native transfer; after admission,
the native cancellation command stops the in-flight transfer cooperatively.
Obsolete operations cannot publish success over a newer operation. Cancelled or
partially failed runs do not update **Last sync** as a success. Successful
transfers refresh additions without resetting the current tabs, selection or
Research run. A vault switch prevents old transfers from refreshing the new vault.

Discovery retains at most 128 nearby devices and expires entries after 20 seconds.
Asynchronous discovery registration and shutdown are serialized so rapid opening,
closing and settings changes cannot leave duplicate listeners behind.
