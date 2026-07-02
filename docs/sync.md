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

**Master switch.** The **Sync** switch is a hard override. When off, Mesa stops
listening, stops LAN discovery, blocks manual sync, and suppresses scheduled
sync even if saved peers exist.

**Discovery is metadata-only.** While the Sync menu is open or listening is on,
Mesa announces its device name, LAN address, port, listening status, and
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
- A peer's stable identity is its certificate fingerprint, not its address, so a
  device keeps its trust even if its IP changes.

## Scheduled Sync

Set `Auto-sync every` to a positive number of minutes to sync all saved peers
while Mesa is open. `0` keeps sync manual. The master sync switch overrides this
timer.

Each peer records:

- pinned certificate fingerprint (trust state)
- last successful sync time
- last checked time
- health state: healthy, error, or unknown
- the last error message, when a sync attempt fails

Sync remains non-destructive: files changed on both devices are saved as conflict
copies rather than overwritten. Deleting a file on one device does not delete it
on others — a two-way hash sync treats "missing here" as "send it back", which
is the safe choice for notes. Delete on every device to retire a file.

## Built for Large Vaults

A vault with hundreds or thousands of files syncs comfortably:

- **One TLS session, many transfers.** A single pooled, pinned client carries
  the whole sync; up to 4 files move concurrently. (Older builds opened a fresh
  TLS connection per file, serially — the classic large-vault killer.)
- **Streamed, cached hashing.** Manifests hash files in 64 KiB chunks (nothing
  is loaded whole into memory) through a `(size, mtime)` cache, so repeat syncs
  re-hash only what changed — on both the serving and the initiating device.
- **Timeouts everywhere.** Connect 10 s, stall 60 s, and a per-file total budget
  scaled by size. A dead peer is an error message, not an infinite silent hang.
- **Per-file failure isolation.** One unreadable or failed file is recorded in
  the report and the console; every other file still syncs.
- **Verified, atomic writes.** Every pulled file is checked against its
  manifest hash before being written via temp-file + rename; every pushed file
  carries its hash so the receiver can reject a corrupted body (and it writes
  atomically too). A dropped connection can never leave a truncated note.
- **Cancellable.** The console's Cancel stops after the transfers in flight.

## The Sync Console & Troubleshooting Package

The moment a sync starts, an embedded console appears in the Sync window: the
Rust engine streams structured log lines (manifest timings, the diff summary,
every transfer, every warning and failure) plus a live progress bar.

**Copy troubleshooting package** copies a single markdown blob designed to be
pasted at an LLM or into a bug report: app version and environment, vault file
count, peer + trust state, settings, the full sync report (counts, bytes,
duration, every failed file with its error), and the complete log. Sync keys
are scrubbed (`[redacted]`) and the vault's absolute path is never included.
**Copy log** copies just the raw lines; **Clear** empties the console.
