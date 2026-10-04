# Device Sync

Mesa syncs your own devices over LAN or Tailscale. Every transfer is
encrypted in transit with TLS (LocalSend-style), so vault contents and your
sync key are never sent in the clear.
The receiver listens on all attached IPv4 and IPv6 networks, including
Tailscale interfaces when available. The sync key and TLS checks apply to
every incoming connection.
Discovery advertises protocol version 2.0; both devices need a build that
supports the key-proof handshake.

## Path and request safety

Sync paths are vault-relative only. Mesa rejects traversal, platform drive
prefixes, alternate-data-stream syntax, Windows-forbidden characters and
control characters, reserved Windows device names (including superscript
digit forms), and trailing dots or spaces. Vault scans report unsupported
names and case-insensitive collisions as incomplete, with the affected paths;
sync stops before planning deletes. Mesa leaves the original files untouched.
Sync also rejects
paths whose existing parent or target resolves through a symlink or junction
outside the selected vault. Missing destinations are checked through their
canonical parent before a verified commit.

On macOS and Linux, sync traverses vault directories with no-follow directory
handles. File reads, manifest hashing, incoming journal moves, conflict-copy
probes, staging, and publication use the held parent handle. A
directory replaced after validation cannot redirect those operations through
a new symlink. Windows still uses path-based transfer checks; native reparse
point and ancestor-replacement acceptance remains open there.

The activity bridge accepts at most 1 MiB of metadata per request. File GET
responses use bounded streaming with backpressure; file PUTs remain capped at
1 GiB and are staged with bounded chunks and final byte/hash verification.
Missing nested folders are created one component at a time under a held vault
directory on macOS and Linux. A rejected path or oversized request
does not modify the vault.

## Security Model

Receive serves the currently open vault. Switching vaults stops the old
listener before the new vault becomes active, then starts a listener for the
new vault if Receive was on. Changing the key or port while receiving also
restarts the listener with the new setting.
Conflict copies use the saved peer name when available; an address-safe label
is used for unnamed peers.

**Transport encryption (TLS).** On first launch each device mints a persistent,
self-signed certificate — its *identity* — stored in the app config directory
(`sync-identity/cert.pem` + `key.pem`). The embedded sync server serves over
HTTPS using that certificate. Because the certificate is self-signed, a normal
CA check would reject it, so the client instead **pins the certificate's SHA-256
fingerprint**:

- **Trust-on-first-use.** The first time you contact a peer, Mesa observes its
  certificate fingerprint during a TLS challenge. The peer must prove it knows
  the sync key before Mesa requests a manifest or transfers a file. Mesa then
  remembers and pins that certificate for authenticated requests.
- **Enforced thereafter.** Every later sync — and every individual file transfer
  within a sync — pins that fingerprint. A mismatch aborts the TLS handshake
  *before* any credential or vault data is sent, which detects an active man-in-the-middle
  (or a device that reinstalled Mesa and got a new certificate).
- **Out-of-band verification.** The Sync panel shows each device's fingerprint
  (yours under *Receive*, each peer's in its card). Compare them across two
  devices to be certain you trusted the right one, exactly like LocalSend.

Handshake signatures are verified normally, so a party holding only a peer's
public certificate cannot impersonate it — possession of the private key is
proven during the handshake.

**Authorization (sync key).** TLS encrypts the channel; the sync key authorizes
vault access. Before requesting metadata or files, Mesa performs a fresh
SPAKE2 exchange using the Ed25519 group. The server confirms the resulting
session secret with an HMAC bound to the client nonce and observed TLS
certificate. The proof is not an offline verifier for the shared key. The
client then uses the certificate-bound bearer credential over pinned TLS;
the shared key itself is never transmitted. Compare certificate fingerprints
out of band before trusting a new device.

Use the same generated key on every device. **Generate key** creates 32 secure
random bytes encoded as 64 lowercase hexadecimal characters. Both native and
frontend validation reject other formats and obvious repeated patterns. This
heuristic cannot prove randomness; do not invent a memorable key. Five identity
probes or failed authentications from one IPv4 address or IPv6 /64 pause
requests from that source for one minute. SPAKE2 prevents passive offline
key guessing; active guesses remain subject to this limit.

The key and optional peer keys are saved in the operating system's credential store on
desktop (Keychain on macOS, Credential Manager on Windows, Secret Service on
Linux). Mesa moves keys from older browser settings only after the credential
store confirms a saved copy. If the store is unavailable, Mesa keeps the old
copy for recovery and reports the failure; newly entered keys remain in memory
until they can be saved. Browser demo keys last only for that session. Remove
the shared key from every device when a former peer must lose access.

**Why the whole engine runs natively.** The sync client (`sync_fetch_manifest`,
and `sync_run`, which performs the entire sync — local hashing, diff, and every
per-file pull/push — internally) runs in Rust via reqwest, not the webview's
`fetch`. The system webview refuses to reach a self-signed LAN HTTPS peer
(WKWebView App Transport Security; WebView2 mixed-content / Private Network
Access), and only a native client can express handshake-time fingerprint
pinning. File bytes and hashing never round-trip through the webview — which
also matters for speed with large vaults.

The LAN listener does not opt into browser cross-origin access. It emits no
`Access-Control-Allow-Origin` or Private Network Access headers, and it does
not answer unauthenticated preflights. Mesa's native reqwest client needs none
of those headers. This keeps arbitrary web origins from treating the private
network sync service as a browser API while preserving LAN and Tailscale sync.

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
2. Select **Generate key** and copy the key to each device.
3. Turn on **Receive**.
4. Add nearby devices when they appear, or share the short pairing code.
5. Compare the device fingerprints across both machines before trusting a new device.

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

After a complete sync, each device records the files that had identical bytes
on both sides. If only one side later edits a file from that shared version,
Mesa transfers the edit with a conditional replacement and keeps the previous
bytes in `.mesa-trash`. If both sides edit it, or no shared version is recorded,
Mesa keeps a conflict copy. A second different conflict from the same peer
on the same day gets a numbered sibling (`… (2).md`, `… (3).md`) instead of
replacing the first copy.

**Deletes and renames.** Mesa keeps a hidden, vault-local operation journal
(`.mesa-sync-journal.json`). It is not a vault note and never appears in the
sidebar. Before a sync, Mesa compares its last durable manifest snapshot with
the current vault: a missing file becomes a delete tombstone; a unique missing
file plus a unique new file with the same bytes becomes a rename. This also
recovers an operation made outside Mesa or interrupted between a filesystem
change and the next sync.

Operations are exchanged separately from the file manifest. Current peers
deliver operations before the final file manifest is compared, then refresh the
receiver's manifest. This prevents a device that initiates a delete from
pulling the receiver's old path back in that same run. A scan with any
unreadable path is explicitly incomplete: Mesa stops that sync and retains its
last complete journal baseline rather than treating omissions as deletions.
A peer delete or
rename applies only when the local source still has the exact recorded size and
hash. If local bytes changed, Mesa keeps them, reports a journal conflict, and
does not silently delete or move user content. Ambiguous same-byte copies are
never guessed to be renames. If the original bytes return after a local delete,
Mesa records a causally ordered restore operation instead of merely retracting
the tombstone, so a peer that has already received the delete can recover it.
Matching bytes removed by a peer operation
go to the normal per-folder `.mesa-trash` recovery storage and can be restored
through Mesa's recovery UI.

Every peer must advertise journal version 1 and sync protocol version 2, and serve the journal
endpoint. Missing or unsupported journal data stops sync before file transfers.
Network, authorization, and invalid journal responses also stop sync
before file transfers. The local baseline is not transmitted; a large idle
vault therefore does not fill the journal exchange. Both directions enforce a
32 MiB streaming bound for operation backlogs and report an exceeded limit.

Removing a saved device retires all journal identities associated with its
certificate, including identities from earlier vault sessions. Mesa
remembers the removed fingerprint across vaults and applies retirement before
the next sync or listener start in each vault. Incoming journal exchanges
associate their key-authenticated sender identity; gossip cannot reactivate a
retired participant. Re-add the device and explicitly sync to reactivate it.
Journals created before device association may contain unidentified participants.
If Mesa cannot identify the device being removed, removal stops with an
explanation; sync with that device once to establish the association. Mesa
never guesses which offline participant to retire. A permanently unavailable,
unidentified device still requires journal recovery; its acknowledgement
requirement is retained.
Retirement does not revoke the shared sync key or delete any vault files.

Mesa serializes journal mutation, incoming application, and durable save for a
vault. Each journal shares direct and gossiped acknowledgements with known
peers. Mesa compacts an operation only after every known participant has
acknowledged it, so an offline device still receives the operation when it
returns. The receiver also bounds concurrent TLS connections and aborts a
handshake that does not finish promptly; a slow or hostile peer cannot create
unbounded server work.

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
  Each file uses streaming SHA-256;
  whole files are independent and a manifest is thousands of them. On the
  4,094-file / 1.45 GB reference vault a cold manifest is **~3.0 s → 0.6–1.0 s**;
  a warm one is ~20 ms. Digests are byte-identical either way — this changes
  only the order the reads are dispatched in, never the wire format.
- **Timeouts everywhere.** Connect 10 s, stall 60 s, and a per-file total budget
  scaled by size. A dead peer is an error message, not an infinite silent hang.
- **Per-file failure isolation.** One unreadable or failed file is recorded in
  the report and the console; every other file still syncs.
- **Verified commits.** Every pulled file is checked against its
  manifest hash, written to a unique sibling candidate, and read back before
  publication. Mesa uses the operating system's atomic no-replace rename
  (`RENAME_NOREPLACE` on Linux, `RENAME_EXCL` on macOS, and non-replacing
  `MoveFileExW` on Windows), so FAT/exFAT removable vaults do not require hard
  links. A hard link is only a fallback when that volume reports that exclusive
  rename is unsupported; Mesa fails closed if neither safe primitive works.
  A conditional edit moves the exact expected old bytes into `.mesa-trash`
  before publishing the new candidate. The target is read back after
  publication. An identical existing file
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

Streaming preserves the endpoints, TLS pinning, SHA-256 hashes, manifest
format, and conflict names. Rust regression tests cover real
loopback HTTP uploads and downloads, bounded receive buffers, interrupted and
truncated bodies, invalid hashes, conditional replacement, and create-only
publication. Loopback HTTP
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
another device. Later syncs use the recorded common version for conditional
one-sided updates and keep divergent changes as conflict copies.

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

## Protocol upgrades and research recovery

Current manifests require `journalVersion: 2` and `syncProtocolVersion: 3`.
All content identities, transfer checks, conditional replacements, and
journal delete/rename guards use 64-character SHA-256 digests. Update both
devices; older peers are refused before file transfers. Local version-one
journals upgrade from live or retained recovery bytes, clear weak common-version
baselines, and retain the old record if required originals are unavailable.
Do not discard recovery files to bypass an upgrade error.

Native sync takes a shared vault-access lease. A reviewed research apply
holds exclusive access through publication and recovery, so Mesa does not
sync a partially applied proposal. After a crash, recovery runs before a
new transfer. External applications are outside this coordination boundary.
