// Embedded peer-to-peer sync — LocalSend-style, end-to-end encrypted.
//
// Two halves live here:
//
// **Server.** A small HTTPS server bound to the device network interfaces so other devices on your
// LAN or Tailscale network can reach it. The transport is TLS: on first run
// each device mints a persistent self-signed certificate (its "identity") and
// serves over HTTPS. A nonce-bound HMAC proof of the sync key precedes every
// client manifest or file request. Requests are handled by a small worker pool, manifest hashes are
// streamed + cached (see `sync_core::HashCache`), and writes are verified,
// create-if-missing commits so a dropped connection or racing writer can
// never truncate or overwrite a note.
// Every protected request carries `Authorization: Bearer <HMAC(key, cert)>`.
// The shared sync key is never sent to an unauthenticated first-contact peer. Endpoints:
//   GET  /sync/manifest                  -> {"files":[{"rel","size","hash"}]}
//   GET  /sync/file?rel=<path>           -> raw bytes
//   PUT  /sync/file?rel=<path>[&hash=h]  -> write bytes (verified when h given)
// Content hashes are SHA-256; older protocols are rejected before transfer.
//
// **Client engine.** `sync_run` performs an entire two-way sync natively:
// remote manifest over pinned TLS, local manifest (streamed, cached, never
// through the webview), diff, then bounded-concurrency transfers over ONE
// pooled client. Every file failure is
// collected (never aborts the rest), every step emits `sync://log` +
// `sync://progress` events for the in-app console, all requests have
// timeouts, and pulled bytes are verified against the manifest hash before an
// verified create. The client pins the peer's SHA-256 certificate fingerprint —
// trust-on-first-use, then enforced — which detects an active MITM at the
// handshake, before any vault data moves.
//
// Pure logic (hashing, walking, diff, conflict names, verified commits, wire
// helpers) lives in `sync_core.rs` — dependency-light and unit-tested with
// `cargo test`, mirrored by the reference implementations in src/lib/sync.ts.

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper::{
    Method as HyperMethod, Request as HyperRequest, Response as HyperResponse, StatusCode,
};
use hyper_util::rt::TokioIo;
use rcgen::CertifiedKey;
use ring::{
    hmac,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use socket2::{Domain, Protocol, Socket, Type};
use spake2::{Ed25519Group, Identity as PakeIdentity, Password, Spake2};
use tauri::{Emitter, Manager};
use tokio::net::TcpListener;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio_rustls::TlsAcceptor;
use tokio_util::io::ReaderStream;

use crate::sync_core;
use crate::sync_core::ManifestEntry;

const DISCOVERY_PORT: u16 = 47887;
const DISCOVERY_EVENT: &str = "sync://discovered";
const LOG_EVENT: &str = "sync://log";
const PROGRESS_EVENT: &str = "sync://progress";
/// Server worker threads: enough that a slow manifest build or big file
/// transfer never blocks the rest of a sync.
const SERVER_WORKERS: usize = 4;
/// Bound TLS handshakes and HTTP connections separately from file-transfer
/// concurrency.  A peer that opens sockets and sends no request must not grow
/// a task per connection or consume all server workers.
const SERVER_CONNECTION_LIMIT: usize = 8;
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Concurrent file transfers during `sync_run`. Multiplexed over one pooled
/// client, so this is N in-flight requests over a handful of reused
/// connections — not N TLS handshakes.
const TRANSFER_CONCURRENCY: usize = 4;
const TRANSFER_QUEUE_LIMIT: usize = 8;
/// Hard cap for a single PUT body (defense against a hostile peer).
const MAX_PUT_BYTES: usize = 1 << 30; // 1 GiB
/// Activity is UI metadata, not a file-transfer channel. Keep a hostile peer
/// from making the server retain an unbounded request body.
const MAX_ACTIVITY_BYTES: usize = 1 << 20;

struct ServerState {
    running: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
    port: u16,
    token: String,
    vault: PathBuf,
}

struct DiscoveryState {
    running: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct DiscoveryPacket {
    #[serde(rename = "mesaDiscovery")]
    mesa_discovery: bool,
    version: String,
    name: String,
    host: String,
    port: u16,
    protocol: String,
    listening: bool,
    fingerprint: String,
}

fn state() -> &'static Mutex<Option<ServerState>> {
    static S: OnceLock<Mutex<Option<ServerState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

fn require_sync_key(key: &str) -> Result<(), String> {
    if key.len() == 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && key
            .as_bytes()
            .chunks_exact(2)
            .collect::<std::collections::HashSet<_>>()
            .len()
            >= 16
        && key.bytes().collect::<std::collections::HashSet<_>>().len() >= 12
    {
        Ok(())
    } else {
        Err("Use a generated sync key: 64 lowercase hexadecimal characters with no repeated or short pattern. Copy the same generated key to each device.".into())
    }
}

fn discovery_state() -> &'static Mutex<Option<DiscoveryState>> {
    static S: OnceLock<Mutex<Option<DiscoveryState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// Process-wide content-hash cache shared by the server (manifest requests)
/// and the client engine (local manifest). Keyed by (path, size, mtime), so
/// only changed files are ever re-hashed.
fn hash_cache() -> &'static Mutex<sync_core::HashCache> {
    static S: OnceLock<Mutex<sync_core::HashCache>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(sync_core::HashCache::new()))
}

/// Cooperative cancel flag for the running `sync_run`, set by `sync_cancel`.
fn cancel_flag() -> &'static AtomicBool {
    static S: OnceLock<AtomicBool> = OnceLock::new();
    S.get_or_init(|| AtomicBool::new(false))
}

fn cancelled() -> bool {
    cancel_flag().load(Ordering::Acquire)
}
fn cancelled_error() -> String {
    "cancelled".to_string()
}

fn cancel_notify() -> &'static tokio::sync::Notify {
    static S: OnceLock<tokio::sync::Notify> = OnceLock::new();
    S.get_or_init(tokio::sync::Notify::new)
}

/// Wait without polling: `sync_cancel` wakes all pending network and channel
/// operations immediately, while the atomic flag keeps the signal durable.
async fn wait_for_cancel() {
    loop {
        let notified = cancel_notify().notified();
        if cancelled() {
            return;
        }
        notified.await;
    }
}

/// The cancel flag is process-wide because `sync_cancel` is a Tauri command
/// shared by every renderer. Keep the engine single-flight as well: otherwise
/// a second `sync_run` would clear the first run's cancellation request, and a
/// cancel from either run could stop the other run mid-transfer.
fn sync_running() -> &'static AtomicBool {
    static S: OnceLock<AtomicBool> = OnceLock::new();
    S.get_or_init(|| AtomicBool::new(false))
}

pub(crate) struct SyncRunGuard;

impl SyncRunGuard {
    pub(crate) fn acquire() -> Result<Self, String> {
        sync_running()
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| Self)
            .map_err(|_| {
                "sync already in progress — wait for it to finish or cancel it".to_string()
            })
    }
}

impl Drop for SyncRunGuard {
    fn drop(&mut self) {
        sync_running().store(false, Ordering::Release);
    }
}

// === Console log / progress events =======================================
//
// Every Tauri event is a JS source string eval'd on the app UI thread, and on
// Windows wry forces a `RedrawWindow` after each one (see the Tauri webview
// event-dispatch path). One event per file would turn a sync into
// a UI-thread storm there: the initiator emits one `sync://log` PLUS one
// `sync://progress` per transferred file, and a *receiving* device emits one
// `[serve] received …` line per PUT — thousands of forced repaints during a
// first full-vault sync, each serialized against `WM_KEYDOWN` while the user
// keeps editing. So both events are COALESCED through one process-global
// flusher, exactly like the terminal output pump (`terminal.rs`): callers only
// stage a line / the latest progress and wake a condvar; a single flusher thread
// batches `sync://log` into one array event per window and collapses
// `sync://progress` to its latest value. Idle costs zero wakeups (condvar, no
// polling — so no background CPU), and `flush_sync_events` forces an immediate
// drain at sync end so the final report line and "done" progress land without
// the flush-window lag. The reduction is a property of the workload's file
// count, not the OS, so it is pinned deterministically in `tests` rather than by
// a live Windows event count.

/// Coalescing window. ~2 frames — a progress bar and a scrolling console cannot
/// show more than this, and a full-vault transfer collapses to one event per
/// window instead of one per file.
const SYNC_EVENT_FLUSH_MS: u64 = 33;

/// One console line, serialized to the exact `{ ts, level, msg }` shape
/// `SyncLogEntry` in `src/lib/sync.ts` expects. `sync://log` now carries a JSON
/// ARRAY of these (a batch); the frontend accepts a lone object too.
#[derive(Serialize)]
struct SyncLogLine {
    ts: u64,
    level: String,
    msg: String,
}

/// Pending events awaiting the next flush. Pure (no `AppHandle`) so its drain
/// semantics are unit-testable without a live Tauri app.
struct SyncOutbox {
    logs: Vec<SyncLogLine>,
    progress: Option<serde_json::Value>,
    /// Set by `flush_sync_events` to force an immediate drain (sync finished).
    flush_now: bool,
}

impl SyncOutbox {
    fn new() -> Self {
        SyncOutbox {
            logs: Vec::new(),
            progress: None,
            flush_now: false,
        }
    }

    fn has_pending(&self) -> bool {
        !self.logs.is_empty() || self.progress.is_some()
    }

    /// Take everything staged, in order (logs) / latest-wins (progress), and
    /// clear the immediate-drain request.
    fn drain(&mut self) -> (Vec<SyncLogLine>, Option<serde_json::Value>) {
        self.flush_now = false;
        (std::mem::take(&mut self.logs), self.progress.take())
    }
}

struct SyncEmitter {
    app: tauri::AppHandle,
    state: Mutex<SyncOutbox>,
    cv: Condvar,
}

/// The process-global emitter, spawned once on first use. The flusher thread is
/// a daemon that blocks on the condvar; it is intentionally never joined (like
/// the terminal flushers) — it holds no vault handle or child process, so the
/// process exit reclaims it.
fn sync_emitter(app: &tauri::AppHandle) -> Arc<SyncEmitter> {
    static E: OnceLock<Arc<SyncEmitter>> = OnceLock::new();
    E.get_or_init(|| {
        let emitter = Arc::new(SyncEmitter {
            app: app.clone(),
            state: Mutex::new(SyncOutbox::new()),
            cv: Condvar::new(),
        });
        let flusher = emitter.clone();
        let _ = std::thread::Builder::new()
            .name("mesa-sync-emitter".into())
            .spawn(move || sync_flusher_loop(&flusher));
        emitter
    })
    .clone()
}

fn sync_flusher_loop(e: &SyncEmitter) {
    loop {
        let (logs, progress) = {
            let mut st = e.state.lock().unwrap();
            // Zero-cost sleep until a caller stages the first item of a burst.
            while !st.has_pending() && !st.flush_now {
                st = e.cv.wait(st).unwrap();
            }
            // Hold the window open for the FULL coalescing delay so the rest of
            // the burst accumulates into one batch — but cut it short the moment
            // a caller requests an immediate drain (sync end). A plain `emit_*`
            // notify wakes `wait_timeout` early; we must NOT treat that as the
            // window closing, or a fast burst would flush every one or two lines
            // and defeat the batching. So loop on a fixed deadline: an early
            // wake just re-waits the remaining time; only a real timeout or
            // `flush_now` ends the window.
            let deadline = Instant::now() + Duration::from_millis(SYNC_EVENT_FLUSH_MS);
            while !st.flush_now {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                let (guard, timed) = e.cv.wait_timeout(st, deadline - now).unwrap();
                st = guard;
                if timed.timed_out() {
                    break;
                }
            }
            st.drain()
        };
        if !logs.is_empty() {
            let _ = e.app.emit(LOG_EVENT, &logs);
        }
        if let Some(progress) = progress {
            let _ = e.app.emit(PROGRESS_EVENT, progress);
        }
    }
}

fn emit_log(app: &tauri::AppHandle, level: &str, msg: impl Into<String>) {
    let e = sync_emitter(app);
    {
        let mut st = e.state.lock().unwrap();
        st.logs.push(SyncLogLine {
            ts: sync_core::now_ms(),
            level: level.to_string(),
            msg: msg.into(),
        });
    }
    e.cv.notify_one();
}

fn emit_progress(app: &tauri::AppHandle, phase: &str, done: usize, total: usize, rel: &str) {
    let e = sync_emitter(app);
    {
        let mut st = e.state.lock().unwrap();
        st.progress =
            Some(serde_json::json!({ "phase": phase, "done": done, "total": total, "rel": rel }));
    }
    e.cv.notify_one();
}

/// Force the coalescer to drain now instead of waiting out the flush window.
/// Called at the end of a sync so the final report line and "done" progress are
/// not delayed. Anything staged is always drained within one window regardless,
/// so this is a latency optimization, never a correctness requirement.
fn flush_sync_events(app: &tauri::AppHandle) {
    let e = sync_emitter(app);
    {
        let mut st = e.state.lock().unwrap();
        st.flush_now = true;
    }
    e.cv.notify_one();
}

// === Misc helpers =========================================================

/// Best-effort LAN IP detection. The UDP "connect" trick sends no packets; it
/// asks the OS which local interface it would use for an outbound route.
fn local_lan_ip() -> Result<String, String> {
    use std::net::UdpSocket;
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    sock.connect("8.8.8.8:80").map_err(|e| e.to_string())?;
    let ip = sock.local_addr().map_err(|e| e.to_string())?.ip();
    Ok(ip.to_string())
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type HyperBody = http_body_util::combinators::BoxBody<Bytes, BoxError>;

fn hyper_response(code: StatusCode, body: impl Into<Bytes>) -> HyperResponse<HyperBody> {
    let body = Full::new(body.into())
        .map_err(|never| match never {})
        .boxed();
    let mut resp = HyperResponse::new(body);
    *resp.status_mut() = code;
    resp
}

fn hyper_json(body: String) -> HyperResponse<HyperBody> {
    let mut resp = hyper_response(StatusCode::OK, body);
    resp.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json"),
    );
    resp
}

fn hyper_auth_ok(req: &HyperRequest<Incoming>, token: &str) -> bool {
    req.headers()
        .get(hyper::header::AUTHORIZATION)
        .is_some_and(|value| {
            value
                .to_str()
                .map(|value| crate::bearer::matches(value, token))
                .unwrap_or(false)
        })
}

// A credential is scoped to the server certificate. First contact may trust
// the wrong certificate, but it must never reveal the reusable shared key.
fn scoped_sync_credential(key: &str, fingerprint: &str) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, key.as_bytes());
    hex_bytes(hmac::sign(&key, format!("mesa-sync-cert-v1:{fingerprint}").as_bytes()).as_ref())
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn nonce() -> Result<[u8; 32], String> {
    let mut value = [0u8; 32];
    SystemRandom::new()
        .fill(&mut value)
        .map_err(|_| "Could not create sync challenge.".to_string())?;
    Ok(value)
}

fn server_proof(key: &str, challenge: &[u8; 32], fingerprint: &str) -> hmac::Tag {
    let secret = hmac::Key::new(hmac::HMAC_SHA256, key.as_bytes());
    let mut message = b"mesa-sync-server-v1:".to_vec();
    message.extend_from_slice(challenge);
    message.extend_from_slice(fingerprint.as_bytes());
    hmac::sign(&secret, &message)
}

fn verify_server_proof(key: &str, challenge: &[u8; 32], fingerprint: &str, proof: &[u8]) -> bool {
    let secret = hmac::Key::new(hmac::HMAC_SHA256, key.as_bytes());
    let mut message = b"mesa-sync-server-v1:".to_vec();
    message.extend_from_slice(challenge);
    message.extend_from_slice(fingerprint.as_bytes());
    hmac::verify(&secret, &message, proof).is_ok()
}

fn parse_identity_request(query: &str) -> Option<([u8; 33], [u8; 32])> {
    let (message, nonce) = query.strip_prefix("pake=")?.split_once("&nonce=")?;
    Some((parse_hex::<33>(message)?, parse_hex::<32>(nonce)?))
}
fn make_identity_proof(
    key: &str,
    message: &[u8],
    challenge: &[u8; 32],
    fingerprint: &str,
) -> Result<IdentityProof, String> {
    let (state, reply) = Spake2::<Ed25519Group>::start_b(
        &Password::new(key.as_bytes()),
        &PakeIdentity::new(b"mesa-sync-client-v3"),
        &PakeIdentity::new(b"mesa-sync-server-v3"),
    );
    let session = state.finish(message).map_err(|_| "invalid key exchange")?;
    Ok(IdentityProof {
        message: hex_bytes(&reply),
        proof: hex_bytes(server_proof(&hex_bytes(&session), challenge, fingerprint).as_ref()),
    })
}

fn parse_hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != N * 2 {
        return None;
    }
    let mut result = [0u8; N];
    for (index, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(result)
}

#[derive(Serialize, Deserialize)]
struct IdentityProof {
    message: String,
    proof: String,
}

#[derive(Default)]
struct AuthLimiter(Mutex<HashMap<IpAddr, (u8, Instant)>>);

impl AuthLimiter {
    fn bucket(peer: IpAddr) -> IpAddr {
        match peer {
            IpAddr::V4(_) => peer,
            IpAddr::V6(address) => {
                let mut octets = address.octets();
                octets[8..].fill(0);
                IpAddr::V6(octets.into())
            }
        }
    }

    fn blocked_locked(attempts: &mut HashMap<IpAddr, (u8, Instant)>, peer: IpAddr) -> bool {
        match attempts.get(&peer).copied() {
            Some((count, since)) if count >= 5 && since.elapsed() < Duration::from_secs(60) => true,
            Some((_, since)) if since.elapsed() >= Duration::from_secs(60) => {
                attempts.remove(&peer);
                false
            }
            _ => false,
        }
    }

    fn blocked(&self, peer: IpAddr) -> bool {
        let Ok(mut attempts) = self.0.lock() else {
            return true;
        };
        Self::blocked_locked(&mut attempts, Self::bucket(peer))
    }

    fn record_locked(attempts: &mut HashMap<IpAddr, (u8, Instant)>, peer: IpAddr, valid: bool) {
        if valid {
            attempts.remove(&peer);
            return;
        }
        if attempts.len() >= 4096 && !attempts.contains_key(&peer) {
            attempts.retain(|_, (_, since)| since.elapsed() < Duration::from_secs(60));
            if attempts.len() >= 4096 {
                if let Some(oldest) = attempts
                    .iter()
                    .min_by_key(|(_, (_, since))| since)
                    .map(|(peer, _)| *peer)
                {
                    attempts.remove(&oldest);
                }
            }
        }
        let entry = attempts.entry(peer).or_insert((0, Instant::now()));
        entry.0 = entry.0.saturating_add(1);
    }

    fn record(&self, peer: IpAddr, valid: bool) {
        let Ok(mut attempts) = self.0.lock() else {
            return;
        };
        Self::record_locked(&mut attempts, Self::bucket(peer), valid);
    }

    fn admit_identity(&self, peer: IpAddr) -> bool {
        let Ok(mut attempts) = self.0.lock() else {
            return false;
        };
        let peer = Self::bucket(peer);
        if Self::blocked_locked(&mut attempts, peer) {
            return false;
        }
        Self::record_locked(&mut attempts, peer, false);
        true
    }
}

#[cfg(test)]
mod auth_limit_tests {
    use super::{require_sync_key, AuthLimiter};
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn five_failures_block_one_peer_without_blocking_others() {
        let limiter = AuthLimiter::default();
        let first = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1));
        let second = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 2));
        for _ in 0..5 {
            assert!(!limiter.blocked(first));
            limiter.record(first, false);
        }
        assert!(limiter.blocked(first));
        assert!(!limiter.blocked(second));
        limiter.record(second, false);
        limiter.record(second, true);
        assert!(!limiter.blocked(second));
    }

    #[test]
    fn identity_probes_are_limited_and_ipv6_uses_a_shared_prefix() {
        let limiter = AuthLimiter::default();
        let first = IpAddr::V6("2001:db8:1:2::1".parse::<Ipv6Addr>().unwrap());
        let same_prefix = IpAddr::V6("2001:db8:1:2::2".parse::<Ipv6Addr>().unwrap());
        let other_prefix = IpAddr::V6("2001:db8:1:3::1".parse::<Ipv6Addr>().unwrap());
        for _ in 0..5 {
            assert!(limiter.admit_identity(first));
        }
        assert!(!limiter.admit_identity(same_prefix));
        assert!(limiter.admit_identity(other_prefix));
    }

    #[test]
    fn a_full_limiter_still_records_new_peers() {
        let limiter = AuthLimiter::default();
        for number in 0..4096u16 {
            limiter.record(
                IpAddr::V4(Ipv4Addr::new(198, 18, (number >> 8) as u8, number as u8)),
                false,
            );
        }
        let newest = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 1));
        for _ in 0..5 {
            limiter.record(newest, false);
        }
        assert!(limiter.blocked(newest));
        assert_eq!(limiter.0.lock().unwrap().len(), 4096);
    }

    #[test]
    fn sync_key_requires_32_bytes_of_lowercase_hex() {
        assert!(require_sync_key(
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
        )
        .is_ok());
        assert!(require_sync_key(&"a".repeat(64)).is_err());
        assert!(require_sync_key(&"01234567".repeat(8)).is_err());
        for key in [
            "A".repeat(64),
            "g".repeat(64),
            "a".repeat(63),
            "a".repeat(65),
        ] {
            assert!(require_sync_key(&key).is_err());
        }
    }
}

fn receive_error_status(error: &sync_core::ReceiveError) -> StatusCode {
    match error {
        sync_core::ReceiveError::TooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
        sync_core::ReceiveError::HashMismatch { .. } => StatusCode::UNPROCESSABLE_ENTITY,
        sync_core::ReceiveError::Read(_) | sync_core::ReceiveError::SizeMismatch { .. } => {
            StatusCode::BAD_REQUEST
        }
        sync_core::ReceiveError::Write(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[cfg(not(unix))]
fn open_sync_file_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(path)
}

async fn handle_hyper(
    mut req: HyperRequest<Incoming>,
    root: Arc<PathBuf>,
    token: Arc<String>,
    app: tauri::AppHandle,
    peer: IpAddr,
    auth_limiter: Arc<AuthLimiter>,
) -> HyperResponse<HyperBody> {
    let method = req.method().clone();
    if method == HyperMethod::GET && req.uri().path() == "/sync/identity" {
        if !auth_limiter.admit_identity(peer) {
            return hyper_response(StatusCode::TOO_MANY_REQUESTS, "too many attempts");
        }
        let Some((message, challenge)) = parse_identity_request(req.uri().query().unwrap_or(""))
        else {
            return hyper_response(StatusCode::BAD_REQUEST, "invalid key exchange");
        };
        let identity = match get_identity(&app) {
            Ok(identity) => identity,
            Err(_) => {
                return hyper_response(StatusCode::INTERNAL_SERVER_ERROR, "identity unavailable")
            }
        };
        return match make_identity_proof(&token, &message, &challenge, &identity.fingerprint) {
            Ok(proof) => hyper_json(serde_json::to_string(&proof).expect("serializable proof")),
            Err(_) => hyper_response(StatusCode::BAD_REQUEST, "invalid key exchange"),
        };
    }
    if auth_limiter.blocked(peer) {
        return hyper_response(StatusCode::TOO_MANY_REQUESTS, "too many attempts");
    }
    let fingerprint = match get_identity(&app) {
        Ok(identity) => identity.fingerprint,
        Err(_) => return hyper_response(StatusCode::INTERNAL_SERVER_ERROR, "identity unavailable"),
    };
    let authorized = hyper_auth_ok(&req, &scoped_sync_credential(&token, &fingerprint));
    auth_limiter.record(peer, authorized);
    if !authorized {
        emit_log(
            &app,
            "warn",
            format!(
                "[serve] rejected {} {} — bad or missing sync key",
                method,
                req.uri()
            ),
        );
        return hyper_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    if method == HyperMethod::OPTIONS {
        return hyper_response(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }

    let _access = match crate::vaulttransaction::access(&root).await {
        Ok(guard) => guard,
        Err(error) => return hyper_response(StatusCode::CONFLICT, error),
    };

    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();

    if path == "/activity" && method == HyperMethod::POST {
        let mut body = Vec::new();
        while let Some(frame) = req.body_mut().frame().await {
            let frame = match frame {
                Ok(frame) => frame,
                Err(_) => return hyper_response(StatusCode::BAD_REQUEST, "read error"),
            };
            if let Some(bytes) = frame.data_ref() {
                if body.len().saturating_add(bytes.len()) > MAX_ACTIVITY_BYTES {
                    return hyper_response(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "activity body too large",
                    );
                }
                body.extend_from_slice(bytes);
            }
        }
        match String::from_utf8(body) {
            Ok(body) => {
                let _ = app.emit("activity", body);
                return hyper_response(StatusCode::OK, "ok");
            }
            Err(_) => return hyper_response(StatusCode::BAD_REQUEST, "read error"),
        }
    }

    if path == "/sync/manifest" && method == HyperMethod::GET {
        let started = Instant::now();
        let manifest_root = root.as_ref().clone();
        let (entries, skipped) = match tokio::task::spawn_blocking(move || {
            let mut cache = hash_cache()
                .lock()
                .map_err(|_| "cache poisoned".to_string())?;
            Ok::<_, String>(sync_core::build_manifest(&manifest_root, &mut cache))
        })
        .await
        {
            Ok(Ok(manifest)) => manifest,
            Ok(Err(error)) => return hyper_response(StatusCode::INTERNAL_SERVER_ERROR, error),
            Err(error) => {
                return hyper_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            }
        };
        if !skipped.is_empty() {
            for (rel, err) in &skipped {
                emit_log(
                    &app,
                    "warn",
                    format!("[serve] manifest incomplete at {rel}: {err}"),
                );
            }
            // A partial manifest is not a safe sync baseline.  Returning an
            // explicit failure prevents both current and older peers from
            // interpreting omitted paths as deletion or rename intent.
            return hyper_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "vault scan incomplete; fix the listed path and retry",
            );
        }
        if let Err(error) = sync_core::reconcile_complete_journal(&root, &entries, &skipped) {
            emit_log(
                &app,
                "warn",
                format!("[serve] journal reconciliation failed: {error}"),
            );
        }
        emit_log(
            &app,
            "info",
            format!(
                "[serve] manifest served — {} files in {}ms",
                entries.len(),
                started.elapsed().as_millis()
            ),
        );
        return hyper_json(sync_core::manifest_to_json(&entries));
    }

    if path == "/sync/journal" && method == HyperMethod::GET {
        return match sync_core::load_journal(&root) {
            Ok(journal) => match sync_core::journal_wire_bytes(&journal)
                .map(|bytes| String::from_utf8(bytes).expect("JSON is UTF-8"))
            {
                Ok(body) => hyper_json(body),
                Err(error) => hyper_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("journal encode failed: {error}"),
                ),
            },
            Err(error) => hyper_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("journal unavailable: {error}"),
            ),
        };
    }

    if path == "/sync/journal" && method == HyperMethod::PUT {
        // The shared sync key authenticates incoming requests. This identity
        // associates their journal participant with the saved peer for retirement;
        // it is not a substitute for the client's TLS server pin.
        let sender_fingerprint = req
            .headers()
            .get("x-mesa-fingerprint")
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .map(str::to_ascii_lowercase);
        // Journal operations are control-plane data, not ordinary vault files.
        // Apply them while the receiver owns the request so an initiator's
        // delete cannot be immediately reintroduced by the receiver's stale
        // manifest during that same sync.
        let mut body = Vec::new();
        while let Some(frame) = req.body_mut().frame().await {
            let frame = match frame {
                Ok(frame) => frame,
                Err(_) => return hyper_response(StatusCode::BAD_REQUEST, "could not read journal"),
            };
            if let Some(bytes) = frame.data_ref() {
                if body.len().saturating_add(bytes.len()) > sync_core::MAX_JOURNAL_WIRE_BYTES {
                    return hyper_response(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "journal exceeds the 32 MiB exchange limit",
                    );
                }
                body.extend_from_slice(bytes);
            }
        }
        let incoming: sync_core::SyncJournal = match serde_json::from_slice(&body) {
            Ok(journal) => journal,
            Err(_) => return hyper_response(StatusCode::BAD_REQUEST, "invalid sync journal"),
        };
        let root_for_apply = root.as_ref().clone();
        let result = tokio::task::spawn_blocking(move || {
            sync_core::validate_journal(&incoming, "peer journal")
                .map_err(|error| error.to_string())?;
            if let Some(fingerprint) = sender_fingerprint {
                sync_core::bind_journal_peer(
                    &root_for_apply,
                    &fingerprint,
                    &incoming.device,
                    false,
                )
                .map_err(|error| error.to_string())?;
            }
            sync_core::apply_incoming_journal(&root_for_apply, &incoming)
                .map_err(|error| error.to_string())
        })
        .await;
        return match result {
            Ok(Ok((journal, outcomes))) => {
                for outcome in outcomes {
                    match outcome.result {
                        Ok(sync_core::JournalApply::Applied | sync_core::JournalApply::AlreadyApplied) => emit_log(&app, "info", format!("[serve] applied peer journal operation {}", outcome.operation.id)),
                        Ok(sync_core::JournalApply::Conflict) => emit_log(&app, "warn", format!("[serve] preserved local bytes for conflicting peer journal operation {}", outcome.operation.id)),
                        Err(error) => emit_log(&app, "warn", format!("[serve] peer journal operation {} failed: {error}", outcome.operation.id)),
                    }
                }
                sync_core::journal_wire_bytes(&journal)
                    .map(|bytes| String::from_utf8(bytes).expect("JSON is UTF-8"))
                    .map(hyper_json)
                    .unwrap_or_else(|error| {
                        hyper_response(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!("journal encode failed: {error}"),
                        )
                    })
            }
            Ok(Err(error)) => hyper_response(StatusCode::CONFLICT, error),
            Err(error) => hyper_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
    }

    if path == "/sync/base" && method == HyperMethod::PUT {
        let Some(sender) = req
            .headers()
            .get("x-mesa-fingerprint")
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .map(str::to_ascii_lowercase)
        else {
            return hyper_response(StatusCode::BAD_REQUEST, "missing peer identity");
        };
        let mut body = Vec::new();
        while let Some(frame) = req.body_mut().frame().await {
            let frame = match frame {
                Ok(frame) => frame,
                Err(_) => {
                    return hyper_response(StatusCode::BAD_REQUEST, "could not read sync base")
                }
            };
            if let Some(bytes) = frame.data_ref() {
                if body.len().saturating_add(bytes.len()) > sync_core::MAX_JOURNAL_WIRE_BYTES {
                    return hyper_response(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "sync base exceeds 32 MiB",
                    );
                }
                body.extend_from_slice(bytes);
            }
        }
        let offered: Vec<sync_core::JournalEntry> = match serde_json::from_slice(&body) {
            Ok(entries) => entries,
            Err(_) => return hyper_response(StatusCode::BAD_REQUEST, "invalid sync base"),
        };
        let base_root = root.as_ref().clone();
        let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let mut cache = hash_cache().lock().map_err(|error| error.to_string())?;
            let (current, skipped) = sync_core::build_manifest(&base_root, &mut cache);
            drop(cache);
            if !skipped.is_empty() {
                return Err("receiver scan is incomplete".into());
            }
            let offered: Vec<ManifestEntry> = offered
                .into_iter()
                .filter_map(|entry| {
                    sync_core::safe_join(&base_root, &entry.rel).map(|_| ManifestEntry {
                        rel: entry.rel,
                        size: entry.size,
                        hash: entry.hash,
                    })
                })
                .collect();
            let common = sync_core::common_baseline(&current, &offered);
            sync_core::save_peer_baseline(&base_root, &sender, common)
                .map_err(|error| error.to_string())
        })
        .await;
        return match result {
            Ok(Ok(())) => hyper_response(StatusCode::OK, "ok"),
            Ok(Err(error)) => hyper_response(StatusCode::CONFLICT, error),
            Err(error) => hyper_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
    }

    if path == "/sync/file" {
        let Some(rel) = sync_core::query_param(&query, "rel") else {
            return hyper_response(StatusCode::BAD_REQUEST, "missing rel");
        };
        let Some(full) = sync_core::safe_join_confined(&root, &rel) else {
            emit_log(
                &app,
                "warn",
                format!("[serve] rejected unsafe path {rel:?}"),
            );
            return hyper_response(StatusCode::BAD_REQUEST, "bad path");
        };
        if method == HyperMethod::GET {
            #[cfg(not(unix))]
            let path = full.clone();
            #[cfg(unix)]
            let root_for_read = root.clone();
            #[cfg(unix)]
            let rel_for_read = rel.clone();
            let file = match tokio::task::spawn_blocking(move || {
                #[cfg(unix)]
                {
                    sync_core::RootedTarget::resolve(&root_for_read, &rel_for_read, false)?
                        .open_read()
                }
                #[cfg(not(unix))]
                {
                    open_sync_file_no_follow(&path)
                }
            })
            .await
            {
                Ok(Ok(file)) => tokio::fs::File::from_std(file),
                Ok(Err(_)) => return hyper_response(StatusCode::NOT_FOUND, "not found"),
                Err(_) => {
                    return hyper_response(StatusCode::INTERNAL_SERVER_ERROR, "file open failed")
                }
            };
            let stream = ReaderStream::with_capacity(file, TRANSFER_CHUNK_BYTES).map(|chunk| {
                chunk
                    .map(Frame::data)
                    .map_err(|error| Box::new(error) as BoxError)
            });
            return HyperResponse::builder()
                .status(StatusCode::OK)
                .body(BodyExt::boxed(StreamBody::new(stream)))
                .unwrap_or_else(|_| {
                    hyper_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "response construction failed",
                    )
                });
        }
        if method == HyperMethod::PUT {
            let prior = match req.headers().get(hyper::header::IF_MATCH) {
                None => None,
                Some(value) => {
                    let parsed = value
                        .to_str()
                        .ok()
                        .and_then(|text| text.strip_prefix('"'))
                        .and_then(|text| text.strip_suffix('"'))
                        .and_then(|text| text.split_once(':'))
                        .and_then(|(size, hash)| {
                            if hash.len() != 64
                                || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                            {
                                return None;
                            }
                            Some((size.parse::<u64>().ok()?, hash.to_string()))
                        });
                    let Some(parsed) = parsed else {
                        return hyper_response(StatusCode::BAD_REQUEST, "invalid If-Match base");
                    };
                    Some(parsed)
                }
            };
            let expected_size = req
                .headers()
                .get(hyper::header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok());
            if expected_size.is_some_and(|size| size > MAX_PUT_BYTES as u64) {
                return hyper_response(StatusCode::PAYLOAD_TOO_LARGE, "too large");
            }
            let expected_hash = sync_core::query_param(&query, "hash");
            let (sender, receiver) = tokio::sync::mpsc::channel(2);
            #[cfg(not(unix))]
            let target = full.clone();
            #[cfg(unix)]
            let root_for_stage = root.clone();
            #[cfg(unix)]
            let rel_for_stage = rel.clone();
            let expected_hash_for_worker = expected_hash.clone();
            let worker = tokio::task::spawn_blocking(move || {
                #[cfg(unix)]
                let mut staged = sync_core::StagedFile::begin_rooted(
                    &root_for_stage,
                    &rel_for_stage,
                    MAX_PUT_BYTES as u64,
                    expected_size,
                    expected_hash_for_worker.as_deref(),
                )?;
                #[cfg(not(unix))]
                let mut staged = sync_core::StagedFile::begin(
                    &target,
                    MAX_PUT_BYTES as u64,
                    expected_size,
                    expected_hash_for_worker.as_deref(),
                )?;
                let mut reader = TransferReader {
                    receiver,
                    current: std::io::Cursor::new(Vec::new()),
                    finished: false,
                };
                let mut buffer = [0u8; TRANSFER_CHUNK_BYTES];
                loop {
                    let count = reader
                        .read(&mut buffer)
                        .map_err(sync_core::ReceiveError::Read)?;
                    if count == 0 {
                        break;
                    }
                    staged.write_chunk(&buffer[..count])?;
                }
                staged.finish()
            });
            let mut transfer_error = None;
            loop {
                let Some(frame) =
                    (match tokio::time::timeout(REQUEST_BODY_IDLE_TIMEOUT, req.body_mut().frame())
                        .await
                    {
                        Ok(frame) => frame,
                        Err(_) => {
                            transfer_error = Some((
                                StatusCode::REQUEST_TIMEOUT,
                                "upload body timed out".to_string(),
                            ));
                            break;
                        }
                    })
                else {
                    break;
                };
                let frame = match frame {
                    Ok(frame) => frame,
                    Err(error) => {
                        transfer_error = Some((
                            StatusCode::BAD_REQUEST,
                            format!("could not read upload body: {error}"),
                        ));
                        break;
                    }
                };
                if let Some(chunk) = frame.data_ref() {
                    if sender
                        .send(TransferChunk::Data(chunk.to_vec()))
                        .await
                        .is_err()
                    {
                        transfer_error = Some((
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "upload staging worker stopped".to_string(),
                        ));
                        break;
                    }
                }
            }
            if transfer_error.is_none() {
                let _ = sender.send(TransferChunk::End).await;
            }
            drop(sender);
            let worker_result = worker.await;
            if let Some((code, detail)) = transfer_error {
                emit_log(
                    &app,
                    "warn",
                    format!("[serve] PUT {rel} rejected — {detail}"),
                );
                return hyper_response(code, detail);
            }
            let staged = match worker_result {
                Ok(Ok(staged)) => staged,
                Ok(Err(error)) => {
                    let code = receive_error_status(&error);
                    return hyper_response(code, error.to_string());
                }
                Err(error) => {
                    return hyper_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
                }
            };
            let size = staged.size;
            let commit_root = root.clone();
            let commit_rel = rel.clone();
            let commit_result = tokio::task::spawn_blocking(move || match prior {
                Some((prior_size, prior_hash)) => {
                    staged.commit_replace(&commit_root, &commit_rel, prior_size, &prior_hash)
                }
                None => staged.commit(&full),
            })
            .await;
            return match commit_result {
                Ok(Ok(outcome)) => {
                    emit_log(
                        &app,
                        "info",
                        format!("[serve] received {rel} ({size} bytes, {outcome:?})"),
                    );
                    hyper_response(StatusCode::OK, "ok")
                }
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    emit_log(
                        &app,
                        "warn",
                        format!("[serve] PUT {rel} rejected — destination has different content"),
                    );
                    hyper_response(
                        StatusCode::CONFLICT,
                        "destination exists with different content",
                    )
                }
                Ok(Err(e)) => hyper_response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
                Err(e) => hyper_response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            };
        }
        return hyper_response(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }

    hyper_response(StatusCode::NOT_FOUND, "not found")
}

fn sync_server_config(id: &Identity) -> Result<Arc<rustls::ServerConfig>, String> {
    let certs = pem::parse_many(&id.cert_pem)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|block| block.tag() == "CERTIFICATE")
        .map(|block| CertificateDer::from(block.contents().to_vec()))
        .collect::<Vec<_>>();
    if certs.is_empty() {
        return Err("sync identity certificate missing".to_string());
    }
    let key = pem::parse_many(&id.key_pem)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|block| block.tag() == "PRIVATE KEY")
        .map(|block| PrivateKeyDer::from(PrivatePkcs8KeyDer::from(block.contents().to_vec())))
        .ok_or_else(|| "sync identity key missing".to_string())?;
    let provider = rustls::crypto::ring::default_provider();
    rustls::ServerConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map(Arc::new)
        .map_err(|e| e.to_string())
}

fn ipv6_listener(port: u16) -> Result<std::net::TcpListener, String> {
    let socket = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| format!("could not create IPv6 sync listener: {e}"))?;
    socket
        .set_only_v6(true)
        .map_err(|e| format!("could not configure IPv6 sync listener: {e}"))?;
    socket
        .bind(&SocketAddr::from(([0u16; 8], port)).into())
        .map_err(|e| format!("could not bind IPv6 sync listener: {e}"))?;
    socket
        .listen(128)
        .map_err(|e| format!("could not listen on IPv6: {e}"))?;
    socket
        .set_nonblocking(true)
        .map_err(|e| format!("could not configure IPv6 sync listener: {e}"))?;
    Ok(socket.into())
}

#[tauri::command]
pub fn sync_start(
    app: tauri::AppHandle,
    port: u16,
    token: String,
    vault: String,
) -> Result<(), String> {
    require_sync_key(&token)?;
    let mut guard = state().lock().map_err(|e| e.to_string())?;
    let root = crate::vaultscope::require_approved(&app, &vault)?;
    if guard
        .as_ref()
        .is_some_and(|server| server.port == port && server.token == token && server.vault == root)
    {
        return Ok(());
    }
    if let Some(previous) = guard.take() {
        previous.running.store(false, Ordering::Relaxed);
        for handle in previous.handles {
            let _ = handle.join();
        }
    }
    let id = get_identity(&app)?;
    let tls_config = sync_server_config(&id)?;
    let addr: SocketAddr = format!("0.0.0.0:{}", port)
        .parse()
        .map_err(|e| format!("invalid sync listen address: {e}"))?;
    let listener = std::net::TcpListener::bind(addr)
        .map_err(|e| format!("could not start TLS sync server: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("could not configure TLS sync server: {e}"))?;
    let ipv6 = ipv6_listener(port);
    let running = Arc::new(AtomicBool::new(true));
    let served_root = Arc::new(root.clone());
    let served_token = Arc::new(token.clone());
    let app_for_thread = app.clone();
    let running_for_thread = running.clone();
    let handle = std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(SERVER_WORKERS)
            .thread_name("mesa-sync-server")
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                emit_log(
                    &app_for_thread,
                    "error",
                    format!("[serve] sync runtime failed: {error}"),
                );
                return;
            }
        };
        runtime.block_on(async move {
            let listener = match TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    emit_log(
                        &app_for_thread,
                        "error",
                        format!("[serve] sync listen failed: {error}"),
                    );
                    return;
                }
            };
            let ipv6 = match ipv6 {
                Ok(socket) => match TcpListener::from_std(socket) {
                    Ok(listener) => Some(listener),
                    Err(error) => {
                        emit_log(&app_for_thread, "warn", format!("[serve] IPv6 sync unavailable: {error}"));
                        None
                    }
                },
                Err(error) => {
                    emit_log(&app_for_thread, "warn", format!("[serve] {error}"));
                    None
                }
            };
            let acceptor = TlsAcceptor::from(tls_config);
            let connection_slots = Arc::new(tokio::sync::Semaphore::new(SERVER_CONNECTION_LIMIT));
            let auth_limiter = Arc::new(AuthLimiter::default());
            while running_for_thread.load(Ordering::Relaxed) {
                let accepted = tokio::time::timeout(Duration::from_millis(250), async {
                    tokio::select! {
                        result = listener.accept() => result,
                        result = async { ipv6.as_ref().expect("IPv6 branch enabled").accept().await }, if ipv6.is_some() => result,
                    }
                }).await;
                let Ok(Ok((stream, peer))) = accepted else {
                    continue;
                };
                let acceptor = acceptor.clone();
                let slot = match connection_slots.clone().try_acquire_owned() {
                    Ok(slot) => slot,
                    Err(_) => {
                        emit_log(
                            &app_for_thread,
                            "warn",
                            "[serve] connection limit reached; refused peer",
                        );
                        continue;
                    }
                };
                let root = served_root.clone();
                let token = served_token.clone();
                let app = app_for_thread.clone();
                let auth_limiter = auth_limiter.clone();
                tokio::spawn(async move {
                    let _slot = slot;
                    let tls =
                        match tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream))
                            .await
                        {
                            Ok(Ok(tls)) => tls,
                            Err(_) => return,
                            Ok(Err(_)) => return,
                        };
                    let service = service_fn(move |req| {
                        let root = root.clone();
                        let token = token.clone();
                        let app = app.clone();
                        let auth_limiter = auth_limiter.clone();
                        async move {
                            Ok::<_, hyper::Error>(
                                handle_hyper(req, root, token, app, peer.ip(), auth_limiter).await,
                            )
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(tls), service)
                        .await;
                });
            }
        });
    });
    *guard = Some(ServerState {
        running,
        handles: vec![handle],
        port,
        token,
        vault: root,
    });
    Ok(())
}

#[tauri::command]
pub fn sync_stop() -> Result<(), String> {
    let mut guard = state().lock().map_err(|e| e.to_string())?;
    if let Some(st) = guard.take() {
        st.running.store(false, Ordering::Relaxed);
        for h in st.handles {
            let _ = h.join();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn sync_status() -> bool {
    state().lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Best-effort discovery of this device's LAN IP, used to show its pairing
/// code. The UDP "connect" trick sends no packets — it just asks the OS which
/// local interface it would use to reach a public address, revealing our IP.
#[tauri::command]
pub fn sync_local_addr() -> Result<String, String> {
    local_lan_ip()
}

// === TLS identity ========================================================
//
// Each device has ONE persistent self-signed certificate. Its SHA-256
// fingerprint is this device's stable, verifiable identity: peers pin it, and
// it is what the discovery packet advertises. Generated once, then loaded from
// the app config dir on every launch so the fingerprint never changes.

#[derive(Clone)]
struct Identity {
    cert_pem: String,
    key_pem: String,
    fingerprint: String,
}

fn identity_cache() -> &'static Mutex<Option<Identity>> {
    static S: OnceLock<Mutex<Option<Identity>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// Lowercase hex SHA-256 of arbitrary bytes.
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Fingerprint (SHA-256 of the DER) of the first certificate in a PEM blob.
fn fingerprint_from_cert_pem(cert_pem: &str) -> Result<String, String> {
    let block = pem::parse(cert_pem).map_err(|e| e.to_string())?;
    Ok(sha256_hex(block.contents()))
}

/// Load this device's TLS identity, generating + persisting it on first run.
fn get_identity(app: &tauri::AppHandle) -> Result<Identity, String> {
    let mut guard = identity_cache().lock().map_err(|e| e.to_string())?;
    if let Some(id) = guard.as_ref() {
        return Ok(id.clone());
    }

    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("sync-identity");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");

    let id = if cert_path.exists() && key_path.exists() {
        let cert_pem = std::fs::read_to_string(&cert_path).map_err(|e| e.to_string())?;
        let key_pem = std::fs::read_to_string(&key_path).map_err(|e| e.to_string())?;
        let fingerprint = fingerprint_from_cert_pem(&cert_pem)?;
        Identity {
            cert_pem,
            key_pem,
            fingerprint,
        }
    } else {
        let CertifiedKey { cert, signing_key } = rcgen::generate_simple_self_signed(vec![
            "mesa.example".to_string(),
            "localhost".to_string(),
        ])
        .map_err(|e| e.to_string())?;
        let cert_pem = cert.pem();
        let key_pem = signing_key.serialize_pem();
        let fingerprint = sha256_hex(cert.der().as_ref());
        std::fs::write(&cert_path, &cert_pem).map_err(|e| e.to_string())?;
        std::fs::write(&key_path, &key_pem).map_err(|e| e.to_string())?;
        Identity {
            cert_pem,
            key_pem,
            fingerprint,
        }
    };

    *guard = Some(id.clone());
    Ok(id)
}

/// This device's certificate fingerprint (lowercase hex SHA-256), for the UI to
/// display so users can compare it out-of-band with a peer.
#[tauri::command]
pub fn sync_identity(app: tauri::AppHandle) -> Result<String, String> {
    Ok(get_identity(&app)?.fingerprint)
}

// === TLS client (fingerprint-pinning) ====================================
//
// The webview cannot talk to a self-signed LAN HTTPS peer, and even a native
// client must decide whether to trust the peer's certificate. We accept the
// self-signed cert but pin its SHA-256 fingerprint: if the caller already knows
// the expected fingerprint we reject any mismatch *at the TLS handshake* (before
// a credential or vault byte is sent). On first contact a challenge records
// the observed identity and verifies the key proof before authenticated
// requests enforce that pin. Handshake signatures verify possession of the
// private key.

#[derive(Debug)]
struct PinnedServerCert {
    expected: Option<String>,
    observed: Arc<Mutex<Option<String>>>,
    algs: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl rustls::client::danger::ServerCertVerifier for PinnedServerCert {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let fp = sha256_hex(end_entity.as_ref());
        if let Ok(mut slot) = self.observed.lock() {
            *slot = Some(fp.clone());
        }
        if let Some(expected) = &self.expected {
            if !expected.eq_ignore_ascii_case(&fp) {
                return Err(rustls::Error::General(
                    "sync certificate fingerprint mismatch".to_string(),
                ));
            }
        }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algs)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.algs.supported_schemes()
    }
}

/// Build a reqwest client that pins `expected` (or records the observed
/// fingerprint into `observed` when `expected` is None). One client is reused
/// for a whole sync: it pools connections, so hundreds of transfers ride a
/// handful of TLS handshakes instead of one each. Timeouts are set so a dead
/// or stalled peer surfaces as an error instead of an infinite silent hang.
fn build_pinned_client(
    expected: Option<String>,
    observed: Arc<Mutex<Option<String>>>,
) -> Result<reqwest::Client, String> {
    let provider = rustls::crypto::ring::default_provider();
    let algs = provider.signature_verification_algorithms;
    let verifier = PinnedServerCert {
        expected,
        observed,
        algs,
    };
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        // Time allowed between received chunks — catches a stalled transfer
        // without capping the total duration of a large one.
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

/// Total per-request timeout, scaled by expected size so huge files on slow
/// links aren't killed while tiny manifests still fail fast.
fn transfer_timeout(size: u64) -> Duration {
    Duration::from_secs(60 + size / (256 * 1024)) // 60s + 1s per 256 KiB
}

/// Turn a reqwest error into a short, human-readable sync failure message.
fn friendly_err(e: reqwest::Error) -> String {
    let detail = format!("{e:?}");
    if detail.contains("fingerprint mismatch") {
        return "This device's security certificate changed — sync refused to protect you. If you reinstalled Mesa on it, remove and re-add the device.".to_string();
    }
    if e.is_connect() {
        return "Couldn't reach that device. Check it's on and receiving.".to_string();
    }
    if e.is_timeout() {
        return "Timed out reaching that device.".to_string();
    }
    e.to_string()
}

#[derive(Deserialize)]
struct ManifestBody {
    files: Vec<ManifestEntry>,
    #[serde(rename = "journalVersion")]
    journal_version: u32,
    #[serde(rename = "syncProtocolVersion")]
    sync_protocol_version: u32,
}

#[derive(Serialize)]
pub struct ManifestResult {
    fingerprint: String,
    files: Vec<ManifestEntry>,
}

fn take_fingerprint(observed: &Arc<Mutex<Option<String>>>) -> String {
    observed
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .unwrap_or_default()
}

/// Normalize an optional pin to bare lowercase hex; empty → None.
fn normalize_pin(pin: Option<String>) -> Option<String> {
    let hex: String = pin?
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect::<String>()
        .to_lowercase();
    if hex.is_empty() {
        None
    } else {
        Some(hex)
    }
}

async fn establish_sync_credential(
    base: &str,
    key: &str,
    pin: Option<String>,
) -> Result<(reqwest::Client, String, String), String> {
    let observed = Arc::new(Mutex::new(None));
    let probe = build_pinned_client(pin, observed.clone())?;
    let challenge = nonce()?;
    let (exchange, message) = Spake2::<Ed25519Group>::start_a(
        &Password::new(key.as_bytes()),
        &PakeIdentity::new(b"mesa-sync-client-v3"),
        &PakeIdentity::new(b"mesa-sync-server-v3"),
    );
    let url = format!(
        "{}/sync/identity?pake={}&nonce={}",
        base.trim_end_matches('/'),
        hex_bytes(&message),
        hex_bytes(&challenge)
    );
    let response = tokio::select! {
        _ = wait_for_cancel() => return Err(cancelled_error()),
        result = probe.get(&url).timeout(Duration::from_secs(30)).send() => result.map_err(friendly_err)?,
    };
    if !response.status().is_success() {
        return Err("Peer does not support certificate-bound sync authentication. Update Mesa on both devices.".into());
    }
    let fingerprint = take_fingerprint(&observed);
    if fingerprint.len() != 64 {
        return Err("Peer TLS identity was not available.".into());
    }
    let mut body = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|_| "Peer does not know this sync key".to_string())?;
        if body.len().saturating_add(chunk.len()) > 4096 {
            return Err("Peer does not know this sync key".into());
        }
        body.extend_from_slice(&chunk);
    }
    let identity: IdentityProof = serde_json::from_slice(&body)
        .map_err(|_| "Peer does not know this sync key".to_string())?;
    let proof = parse_hex::<32>(&identity.proof)
        .ok_or_else(|| "Peer does not know this sync key".to_string())?;
    let message = parse_hex::<33>(&identity.message).ok_or("invalid peer key exchange")?;
    let session = exchange
        .finish(&message)
        .map_err(|_| "invalid peer key exchange")?;
    if !verify_server_proof(&hex_bytes(&session), &challenge, &fingerprint, &proof) {
        return Err("Peer does not know this sync key".into());
    }
    // A fresh client enforces this exact fingerprint on every authenticated
    // connection, including reconnects and redirects.
    let client = build_pinned_client(Some(fingerprint.clone()), Arc::new(Mutex::new(None)))?;
    Ok((
        client,
        scoped_sync_credential(key, &fingerprint),
        fingerprint,
    ))
}

async fn fetch_manifest_with(
    client: &reqwest::Client,
    base: &str,
    token: &str,
) -> Result<ManifestBody, String> {
    let url = format!("{}/sync/manifest", base.trim_end_matches('/'));
    if cancelled() {
        return Err(cancelled_error());
    }
    let request = client
        .get(&url)
        .bearer_auth(token)
        .timeout(Duration::from_secs(300));
    let res = tokio::select! {
        _ = wait_for_cancel() => return Err(cancelled_error()),
        result = request.send() => result.map_err(friendly_err)?,
    };
    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Sync key doesn't match that device.".to_string());
    }
    if !status.is_success() {
        return Err(format!("Device responded {}.", status.as_u16()));
    }
    let bytes = tokio::select! {
        _ = wait_for_cancel() => return Err(cancelled_error()),
        result = res.bytes() => result.map_err(|e| e.to_string())?,
    };
    let body: ManifestBody = serde_json::from_slice(&bytes)
        .map_err(|_| "That address isn't sharing a Mesa vault.".to_string())?;
    Ok(body)
}

async fn read_journal_response(
    mut response: reqwest::Response,
) -> Result<sync_core::SyncJournal, String> {
    if response
        .content_length()
        .is_some_and(|size| size > sync_core::MAX_JOURNAL_WIRE_BYTES as u64)
    {
        return Err("Peer journal exceeds the 32 MiB exchange limit".to_string());
    }
    let mut body = Vec::new();
    loop {
        let chunk = tokio::select! {
            _ = wait_for_cancel() => return Err(cancelled_error()),
            result = response.chunk() => result.map_err(|error| error.to_string())?,
        };
        let Some(chunk) = chunk else {
            break;
        };
        if body.len().saturating_add(chunk.len()) > sync_core::MAX_JOURNAL_WIRE_BYTES {
            return Err("Peer journal exceeds the 32 MiB exchange limit".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    let journal = serde_json::from_slice(&body)
        .map_err(|_| "Peer returned an invalid sync journal".to_string())?;
    sync_core::validate_journal(&journal, "peer journal").map_err(|error| error.to_string())?;
    Ok(journal)
}

async fn fetch_journal_with(
    client: &reqwest::Client,
    base: &str,
    token: &str,
) -> Result<sync_core::SyncJournal, String> {
    let url = format!("{}/sync/journal", base.trim_end_matches('/'));
    let response = tokio::select! {
        _ = wait_for_cancel() => return Err(cancelled_error()),
        result = client.get(&url).bearer_auth(token).timeout(Duration::from_secs(30)).send() => result.map_err(friendly_err)?,
    };
    if !response.status().is_success() {
        return Err(format!(
            "Journal request failed ({}). Sync stopped before file transfers.",
            response.status().as_u16()
        ));
    }
    read_journal_response(response).await
}

/// Deliver locally generated delete/rename intent before taking the final
/// remote manifest. The receiver applies matching operations and returns its
/// journal.
async fn deliver_journal_with(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    journal: &sync_core::SyncJournal,
    sender_fingerprint: &str,
) -> Result<sync_core::SyncJournal, String> {
    let body = sync_core::journal_wire_bytes(journal).map_err(|error| error.to_string())?;
    let url = format!("{}/sync/journal", base.trim_end_matches('/'));
    let response = tokio::select! {
        _ = wait_for_cancel() => return Err(cancelled_error()),
        result = client.put(&url).bearer_auth(token).header("x-mesa-fingerprint", sender_fingerprint).header(reqwest::header::CONTENT_TYPE, "application/json").body(body).timeout(Duration::from_secs(30)).send() => result.map_err(friendly_err)?,
    };
    if !response.status().is_success() {
        return Err(format!(
            "journal delivery returned {}",
            response.status().as_u16()
        ));
    }
    read_journal_response(response).await
}

#[tauri::command]
pub async fn sync_retire_peer(
    app: tauri::AppHandle,
    root: String,
    fingerprints: Vec<String>,
) -> Result<(), String> {
    let root = crate::vaultscope::require_approved(&app, &root)?;
    tokio::task::spawn_blocking(move || sync_core::retire_journal_peers(&root, &fingerprints))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// GET the remote manifest over pinned TLS. Returns the peer's cert fingerprint
/// (so the caller can trust-on-first-use) plus the file list. Used by the
/// "Open shared vault" probe; `sync_run` fetches its own manifest.
#[tauri::command]
pub async fn sync_fetch_manifest(
    base: String,
    token: String,
    pin: Option<String>,
) -> Result<ManifestResult, String> {
    require_sync_key(&token)?;
    let (client, credential, fingerprint) =
        establish_sync_credential(&base, &token, normalize_pin(pin)).await?;
    let manifest = fetch_manifest_with(&client, &base, &credential).await?;
    if manifest.journal_version != sync_core::JOURNAL_VERSION
        || manifest.sync_protocol_version != sync_core::SYNC_PROTOCOL_VERSION
    {
        return Err(
            "Peer uses an unsupported sync protocol. Update Mesa before pairing.".to_string(),
        );
    }
    let files = manifest.files;
    Ok(ManifestResult { fingerprint, files })
}

// === The sync engine ======================================================

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncFailureItem {
    pub rel: String,
    /// "pull" | "push" | "conflict" | "scan"
    pub op: String,
    pub error: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub fingerprint: String,
    pub pulled: u32,
    pub pushed: u32,
    pub conflicts: u32,
    pub up_to_date: u32,
    pub failed: Vec<SyncFailureItem>,
    pub bytes_pulled: u64,
    pub bytes_pushed: u64,
    pub total_local: u32,
    pub total_remote: u32,
    pub duration_ms: u64,
    pub cancelled: bool,
}

fn cancelled_report(started: Instant) -> SyncReport {
    SyncReport {
        fingerprint: String::new(),
        pulled: 0,
        pushed: 0,
        conflicts: 0,
        up_to_date: 0,
        failed: Vec::new(),
        bytes_pulled: 0,
        bytes_pushed: 0,
        total_local: 0,
        total_remote: 0,
        duration_ms: started.elapsed().as_millis() as u64,
        cancelled: true,
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Op {
    Pull,
    PullReplace,
    Push,
    PushReplace,
    Conflict,
}

impl Op {
    fn name(self) -> &'static str {
        match self {
            Op::Pull => "pull",
            Op::PullReplace => "pull update",
            Op::Push => "push",
            Op::PushReplace => "push update",
            Op::Conflict => "conflict",
        }
    }
}

struct Job {
    op: Op,
    rel: String,
    /// Where a pulled file lands, vault-relative (differs from `rel` for
    /// conflict copies).
    dest_rel: String,
    /// Expected size (remote size for pulls, local for pushes) — sizes the
    /// timeout.
    size: u64,
    /// Expected content hash for pulls/conflicts; verified before writing.
    hash: String,
    /// Shared prior bytes required for a conditional replacement.
    prior: Option<(u64, String)>,
}

struct JobOutcome {
    op: Op,
    rel: String,
    bytes: u64,
    result: Result<JobSuccess, String>,
}

fn retry_allows(retry: Option<&std::collections::HashSet<String>>, rel: &str) -> bool {
    retry.is_none_or(|rels| rels.contains(rel))
}

struct JobSuccess {
    detail: String,
    /// False when a racing/retried create found identical bytes already in
    /// place. Reports must not count that as a newly created conflict copy.
    changed: bool,
}

async fn run_job(
    client: reqwest::Client,
    base: String,
    token: String,
    root: PathBuf,
    job: Job,
) -> JobOutcome {
    if cancelled() {
        return JobOutcome {
            op: job.op,
            rel: job.rel,
            bytes: 0,
            result: Err(cancelled_error()),
        };
    }
    // One retry on any failure: transient LAN hiccups and "file changed while
    // hashing" races both deserve a second chance before being reported.
    let first = run_job_once(&client, &base, &token, &root, &job).await;
    let result = match first {
        Ok(success) => Ok(success),
        Err(first_err) => {
            tokio::select! {
                _ = wait_for_cancel() => return JobOutcome { op: job.op, rel: job.rel, bytes: 0, result: Err(cancelled_error()) },
                _ = tokio::time::sleep(Duration::from_millis(300)) => {},
            }
            match run_job_once(&client, &base, &token, &root, &job).await {
                Ok(mut success) => {
                    success.detail = format!("{} (after retry: {first_err})", success.detail);
                    Ok(success)
                }
                Err(second_err) => Err(second_err),
            }
        }
    };
    JobOutcome {
        op: job.op,
        rel: job.rel,
        bytes: job.size,
        result,
    }
}

const TRANSFER_CHUNK_BYTES: usize = 64 * 1024;

/// Explicit EOF is required: dropping/cancelling the producer must never make
/// a partial network receive look complete to the blocking disk worker.
enum TransferChunk {
    Data(Vec<u8>),
    End,
}

struct TransferReader {
    receiver: tokio::sync::mpsc::Receiver<TransferChunk>,
    current: std::io::Cursor<Vec<u8>>,
    finished: bool,
}

impl Read for TransferReader {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        loop {
            let count = self.current.read(output)?;
            if count > 0 || self.finished {
                return Ok(count);
            }
            match self.receiver.blocking_recv() {
                Some(TransferChunk::Data(bytes)) => self.current = std::io::Cursor::new(bytes),
                Some(TransferChunk::End) => self.finished = true,
                None => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "network transfer interrupted",
                    ))
                }
            }
        }
    }
}

async fn receive_response(
    mut response: reqwest::Response,
    target: PathBuf,
    #[cfg(unix)] rooted: Option<(PathBuf, String)>,
    size: u64,
    hash: String,
) -> Result<sync_core::StagedFile, String> {
    if response
        .content_length()
        .is_some_and(|length| length != size)
    {
        return Err(format!(
            "content size mismatch before transfer (expected {size}, got {:?})",
            response.content_length()
        ));
    }
    let (sender, receiver) = tokio::sync::mpsc::channel(2);
    let worker = tokio::task::spawn_blocking(move || {
        let reader = TransferReader {
            receiver,
            current: std::io::Cursor::new(Vec::new()),
            finished: false,
        };
        #[cfg(unix)]
        if let Some((root, rel)) = rooted {
            return sync_core::StagedFile::receive_rooted(
                &root,
                &rel,
                reader,
                size,
                Some(size),
                Some(&hash),
            );
        }
        sync_core::StagedFile::receive(&target, reader, size, Some(size), Some(&hash))
    });
    let transfer = async {
        let mut received = 0u64;
        loop {
            let next = tokio::select! {
                _ = wait_for_cancel() => return Err(cancelled_error()),
                result = response.chunk() => result.map_err(|e| e.to_string())?,
            };
            let Some(bytes) = next else { break };
            if bytes.len() as u64 > size.saturating_sub(received) {
                return Err(format!("transfer exceeds manifest size of {size} bytes"));
            }
            received += bytes.len() as u64;
            for chunk in bytes.chunks(TRANSFER_CHUNK_BYTES) {
                tokio::select! {
                    _ = wait_for_cancel() => return Err(cancelled_error()),
                    result = sender.send(TransferChunk::Data(chunk.to_vec())) => result.map_err(|_| "staging worker stopped".to_string())?,
                }
            }
        }
        sender
            .send(TransferChunk::End)
            .await
            .map_err(|_| "staging worker stopped".to_string())?;
        Ok::<_, String>(())
    }
    .await;
    drop(sender);
    let staged = worker.await.map_err(|e| e.to_string())?;
    // Keep the network error when it stopped an otherwise healthy worker.
    // Disk/hash errors remain useful when the worker stopped the producer.
    if let Err(error) = transfer {
        if error != "staging worker stopped" {
            return Err(error);
        }
    }
    staged.map_err(|e| e.to_string())
}

#[cfg(any(test, not(unix)))]
fn open_upload(path: &Path) -> std::io::Result<(std::fs::File, u64, String)> {
    open_upload_handle(std::fs::File::open(path)?)
}

fn open_upload_handle(mut file: std::fs::File) -> std::io::Result<(std::fs::File, u64, String)> {
    use std::io::Seek;
    if file.metadata()?.len() > MAX_PUT_BYTES as u64 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file exceeds receiver's 1 GiB PUT limit",
        ));
    }
    let mut hash = sync_core::ContentHasher::new();
    let mut buffer = [0u8; TRANSFER_CHUNK_BYTES];
    let mut n = 0u64;
    loop {
        let count = match file.read(&mut buffer) {
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            break;
        }
        n += count as u64;
        if n > MAX_PUT_BYTES as u64 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "file exceeds receiver's 1 GiB PUT limit",
            ));
        }
        hash.update(&buffer[..count]);
    }
    file.rewind()?;
    Ok((file, n, hash.hex()))
}

async fn run_job_once(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    root: &Path,
    job: &Job,
) -> Result<JobSuccess, String> {
    let url = format!("{}/sync/file", base.trim_end_matches('/'));
    match job.op {
        Op::Pull | Op::PullReplace | Op::Conflict => {
            let res = client
                .get(&url)
                .query(&[("rel", job.rel.as_str())])
                .bearer_auth(token)
                .timeout(transfer_timeout(job.size))
                .send()
                .await
                .map_err(friendly_err)?;
            if !res.status().is_success() {
                return Err(format!("device responded {}", res.status().as_u16()));
            }
            let dest = sync_core::safe_join_confined(root, &job.dest_rel)
                .ok_or_else(|| format!("unsafe destination path {:?}", job.dest_rel))?;
            let staged = receive_response(
                res,
                dest.clone(),
                #[cfg(unix)]
                Some((root.to_path_buf(), job.dest_rel.clone())),
                job.size,
                job.hash.clone(),
            )
            .await?;
            let n = staged.size;
            let root = root.to_path_buf();
            let base_dest = job.dest_rel.clone();
            let op = job.op;
            let prior = job.prior.clone();
            let (outcome, landed_rel) = tokio::task::spawn_blocking(move || {
                if op == Op::Conflict {
                    staged.commit_conflict(&root, &base_dest)
                } else if op == Op::PullReplace {
                    let (size, hash) = prior.as_ref().ok_or_else(|| {
                        std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing edit base")
                    })?;
                    staged
                        .commit_replace(&root, &base_dest, *size, hash)
                        .map(|outcome| (outcome, base_dest))
                } else {
                    let outcome = staged.commit(&dest)?;
                    Ok((outcome, base_dest))
                }
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("write failed: {e}"))?;
            Ok(JobSuccess {
                detail: format!("{} bytes, verified at {} ({outcome:?})", n, landed_rel),
                changed: outcome == sync_core::CommitOutcome::Created,
            })
        }
        Op::Push | Op::PushReplace => {
            if cancelled() {
                return Err(cancelled_error());
            }
            let src = sync_core::safe_join_confined(root, &job.rel)
                .ok_or_else(|| format!("unsafe source path {:?}", job.rel))?;
            #[cfg(unix)]
            let _ = &src;
            // Hash and rewind the same open handle off the async runtime.
            // The receiver verifies that the bytes sent still match this hash;
            // a concurrent edit fails safely and enters the existing retry path.
            #[cfg(unix)]
            let root_for_read = root.to_path_buf();
            #[cfg(unix)]
            let rel_for_read = job.rel.clone();
            let (file, n, hash) = tokio::task::spawn_blocking(move || {
                #[cfg(unix)]
                {
                    open_upload_handle(
                        sync_core::RootedTarget::resolve(&root_for_read, &rel_for_read, false)?
                            .open_read()?,
                    )
                }
                #[cfg(not(unix))]
                {
                    open_upload(&src)
                }
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("read failed: {e}"))?;
            let mut request = client
                .put(&url)
                .query(&[("rel", job.rel.as_str()), ("hash", hash.as_str())])
                .bearer_auth(token)
                .timeout(transfer_timeout(n))
                .header(reqwest::header::CONTENT_LENGTH, n)
                .body(reqwest::Body::from(tokio::fs::File::from_std(file)));
            if job.op == Op::PushReplace {
                let (size, hash) = job.prior.as_ref().ok_or("missing edit base")?;
                request = request.header(reqwest::header::IF_MATCH, format!("\"{size}:{hash}\""));
            }
            let res = tokio::select! {
                _ = wait_for_cancel() => return Err(cancelled_error()),
                result = request.send() => result.map_err(friendly_err)?,
            };
            if !res.status().is_success() {
                return Err(format!("device responded {}", res.status().as_u16()));
            }
            Ok(JobSuccess {
                detail: format!("{} bytes, hash-checked by receiver", n),
                changed: true,
            })
        }
    }
}

/// Cancel the in-flight `sync_run` after the transfers already in the air.
#[tauri::command]
pub fn sync_cancel() {
    cancel_flag().store(true, Ordering::Release);
    cancel_notify().notify_waiters();
}

/// Run a complete two-way sync against one peer. This is THE sync path:
/// everything happens natively (no vault bytes or hashing in the webview),
/// over one pooled pinned-TLS client, with bounded concurrency, per-file
/// verification, non-destructive verified commits, and per-file error
/// collection. `retry` is an optional rel-path allowlist from the previous
/// failed transfer report; manifests and journal reconciliation still run
/// before Mesa narrows the pull/push/conflict transfer jobs. Emits
/// `sync://log` and `sync://progress` throughout so the UI console can show —
/// and the user can copy — exactly what happened.
#[tauri::command]
pub async fn sync_run(
    app: tauri::AppHandle,
    root: String,
    base: String,
    token: String,
    pin: Option<String>,
    retry: Option<Vec<String>>,
    peer_name: Option<String>,
) -> Result<SyncReport, String> {
    require_sync_key(&token)?;
    let root = crate::vaultscope::require_approved(&app, &root)?;
    let _run_guard = SyncRunGuard::acquire()?;
    let _access = crate::vaulttransaction::access(&root).await?;
    let started = Instant::now();
    cancel_flag().store(false, Ordering::Relaxed);
    let base = base.trim_end_matches('/').to_string();
    let pin = normalize_pin(pin);
    let retry_set: Option<std::collections::HashSet<String>> = retry
        .map(|rels| {
            rels.into_iter()
                .filter(|rel| !rel.trim().is_empty())
                .collect()
        })
        .filter(|rels: &std::collections::HashSet<String>| !rels.is_empty());

    emit_log(
        &app,
        "info",
        format!(
            "sync started — peer {base}, pin {}{}",
            pin.as_deref()
                .map(|p| &p[..12.min(p.len())])
                .unwrap_or("none (trust-on-first-use)"),
            retry_set
                .as_ref()
                .map(|rels| format!(", retrying {} failed files", rels.len()))
                .unwrap_or_default()
        ),
    );

    emit_progress(&app, "manifest", 0, 0, "");

    // 1. Remote manifest over pinned TLS. Establishes (and verifies, when a
    //    pin is known) the peer's certificate before any vault data moves.
    let (client, token, fingerprint) =
        establish_sync_credential(&base, &token, pin.clone()).await?;
    let manifest_started = Instant::now();
    let remote_manifest = match fetch_manifest_with(&client, &base, &token).await {
        Ok(files) => files,
        Err(e) => {
            if cancelled() {
                emit_log(
                    &app,
                    "info",
                    "sync stopping — no incomplete manifest work was committed",
                );
                let report = cancelled_report(started);
                emit_progress(&app, "done", 0, 0, "");
                flush_sync_events(&app);
                return Ok(report);
            }
            emit_log(&app, "error", format!("remote manifest failed: {e}"));
            return Err(e);
        }
    };
    if remote_manifest.journal_version != sync_core::JOURNAL_VERSION {
        return Err(
            "Peer uses an unsupported journal protocol. Update Mesa before syncing.".to_string(),
        );
    }
    if remote_manifest.sync_protocol_version != sync_core::SYNC_PROTOCOL_VERSION {
        return Err(
            "Peer uses an unsupported sync protocol. Update Mesa before syncing.".to_string(),
        );
    }
    let mut remote = remote_manifest.files;
    emit_log(
        &app,
        "info",
        format!(
            "remote manifest — {} files, {} bytes total, fetched in {}ms (peer cert {})",
            remote.len(),
            remote.iter().map(|e| e.size).sum::<u64>(),
            manifest_started.elapsed().as_millis(),
            &fingerprint[..12.min(fingerprint.len())]
        ),
    );

    let remote_journal = fetch_journal_with(&client, &base, &token).await?;
    sync_core::bind_journal_peer(&root, &fingerprint, &remote_journal.device, true)
        .map_err(|error| error.to_string())?;

    // 2. Local manifest — streamed + cached hashing off the async runtime.
    emit_progress(&app, "scan", 0, 0, "");
    let scan_started = Instant::now();
    let scan_root = root.clone();
    let (mut local, skipped) = tokio::task::spawn_blocking(move || {
        let mut cache = hash_cache().lock().map_err(|e| e.to_string())?;
        sync_core::build_manifest_cancellable(&scan_root, &mut cache, cancel_flag())
            .ok_or_else(cancelled_error)
    })
    .await
    .map_err(|e| e.to_string())??;
    if cancelled() {
        emit_log(&app, "info", "sync stopping — local scan result discarded");
        let report = cancelled_report(started);
        emit_progress(&app, "done", 0, 0, "");
        flush_sync_events(&app);
        return Ok(report);
    }
    let mut failed: Vec<SyncFailureItem> = Vec::new();
    for (rel, err) in &skipped {
        emit_log(&app, "warn", format!("local scan skipped {rel}: {err}"));
        failed.push(SyncFailureItem {
            rel: rel.clone(),
            op: "scan".to_string(),
            error: err.clone(),
        });
    }
    if !skipped.is_empty() {
        emit_log(
            &app,
            "warn",
            "local vault scan is incomplete; sync stopped before journal or file planning",
        );
        return Err("Local vault scan is incomplete. Fix the listed paths and retry; Mesa did not infer any deletes or renames.".to_string());
    }
    emit_log(
        &app,
        "info",
        format!(
            "local manifest — {} files hashed in {}ms{}",
            local.len(),
            scan_started.elapsed().as_millis(),
            if skipped.is_empty() {
                String::new()
            } else {
                format!(", {} unreadable (see warnings)", skipped.len())
            }
        ),
    );

    // Record externally-made deletes/renames before applying the peer's intent.
    // The snapshot means a crash after an OS delete is reconstructed on the
    // next sync instead of silently resurrecting the file.
    let local_journal = tokio::task::spawn_blocking({
        let root = root.clone();
        let local = local.clone();
        let skipped = skipped.clone();
        move || sync_core::reconcile_complete_journal(&root, &local, &skipped)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    // Deliver local intent before calculating the ordinary file transfer plan.
    // The receiver applies a delete/rename and we then re-fetch its
    // manifest, so an initiator cannot pull the old path back in the same run.
    let remote_journal = deliver_journal_with(
        &client,
        &base,
        &token,
        &local_journal,
        &get_identity(&app)?.fingerprint,
    )
    .await
    .map_err(|error| format!("Peer rejected journal delivery: {error}"))?;
    let refreshed = fetch_manifest_with(&client, &base, &token).await?;
    if refreshed.journal_version != sync_core::JOURNAL_VERSION
        || refreshed.sync_protocol_version != sync_core::SYNC_PROTOCOL_VERSION
    {
        return Err("Peer sync protocol changed during transfer".to_string());
    }
    remote = refreshed.files;
    {
        let (_local_journal, outcomes) = tokio::task::spawn_blocking({
            let root = root.clone();
            let remote_journal = remote_journal.clone();
            move || sync_core::apply_incoming_journal(&root, &remote_journal)
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
        for outcome in outcomes {
            let op = outcome.operation;
            match outcome.result {
                Ok(sync_core::JournalApply::Applied | sync_core::JournalApply::AlreadyApplied) => {
                    emit_log(
                        &app,
                        "info",
                        format!(
                            "applied peer {} {}",
                            match op.kind {
                                sync_core::JournalOperationKind::Delete => "delete",
                                sync_core::JournalOperationKind::Rename => "rename",
                                sync_core::JournalOperationKind::Restore => "restore",
                            },
                            op.from
                        ),
                    );
                }
                Ok(sync_core::JournalApply::Conflict) => {
                    failed.push(SyncFailureItem { rel: op.from.clone(), op: "journal".to_string(), error: "peer delete/rename conflicts with changed local content; local copy was preserved".to_string() });
                    emit_log(
                        &app,
                        "warn",
                        format!(
                            "preserved local content for conflicting peer operation {}",
                            op.from
                        ),
                    );
                }
                Err(error) => failed.push(SyncFailureItem {
                    rel: op.from.clone(),
                    op: "journal".to_string(),
                    error: error.to_string(),
                }),
            }
        }
        // Remote operations changed the local filesystem. Rebuild from the
        // shared hash cache before the ordinary file diff.
        let scan_root = root.clone();
        let (rescanned_local, rescanned_skipped) = tokio::task::spawn_blocking(move || {
            let mut cache = hash_cache().lock().map_err(|error| error.to_string())?;
            sync_core::build_manifest_cancellable(&scan_root, &mut cache, cancel_flag())
                .ok_or_else(cancelled_error)
        })
        .await
        .map_err(|error| error.to_string())??;
        if !rescanned_skipped.is_empty() {
            for (rel, error) in &rescanned_skipped {
                failed.push(SyncFailureItem {
                    rel: rel.clone(),
                    op: "scan".to_string(),
                    error: error.clone(),
                });
            }
            emit_log(&app, "warn", "local vault scan became incomplete after peer operations; ordinary transfer planning was stopped");
            return Err("Local vault scan is incomplete after peer operations. Fix the listed paths and retry; Mesa did not infer any deletes.".to_string());
        }
        local = rescanned_local;
        let root_for_journal = root.clone();
        let local_for_journal = local.clone();
        tokio::task::spawn_blocking(move || {
            sync_core::reconcile_complete_journal(
                &root_for_journal,
                &local_for_journal,
                &rescanned_skipped,
            )
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    }

    // 3. Diff.
    let peer_base = sync_core::peer_baseline(&root, &fingerprint)
        .map_err(|error| format!("could not load peer sync base: {error}"))?;
    let diff = sync_core::diff_manifests_from_base(&local, &remote, &peer_base);
    emit_log(
        &app,
        "info",
        format!(
            "diff — pull {}, push {}, conflicts {}, up-to-date {}",
            diff.pull.len() + diff.pull_replace.len(),
            diff.push.len() + diff.push_replace.len(),
            diff.conflict.len(),
            diff.same
        ),
    );

    // 4. Pin every transfer to the established fingerprint. A mismatch aborts
    //    during the TLS handshake, before the body is sent.
    let enforce = pin.clone().unwrap_or_else(|| fingerprint.clone());
    let transfer_client = if pin.is_some() {
        client // already pinned
    } else {
        build_pinned_client(Some(enforce), Arc::new(Mutex::new(None)))?
    };

    // Build the job list.
    let remote_by_rel: std::collections::HashMap<&str, &ManifestEntry> =
        remote.iter().map(|e| (e.rel.as_str(), e)).collect();
    let local_by_rel: std::collections::HashMap<&str, &ManifestEntry> =
        local.iter().map(|e| (e.rel.as_str(), e)).collect();
    let base_by_rel: std::collections::HashMap<&str, &sync_core::JournalEntry> = peer_base
        .iter()
        .map(|entry| (entry.rel.as_str(), entry))
        .collect();
    let host = sync_core::conflict_source(
        peer_name.as_deref().unwrap_or(""),
        &sync_core::host_of_base(&base),
    );
    let date = sync_core::utc_date_string();
    let mut jobs: Vec<Job> = Vec::new();
    for rel in &diff.pull {
        if !retry_allows(retry_set.as_ref(), rel) {
            continue;
        }
        let e = remote_by_rel[rel.as_str()];
        jobs.push(Job {
            op: Op::Pull,
            rel: rel.clone(),
            dest_rel: rel.clone(),
            size: e.size,
            hash: e.hash.clone(),
            prior: None,
        });
    }
    for rel in &diff.pull_replace {
        if !retry_allows(retry_set.as_ref(), rel) {
            continue;
        }
        let e = remote_by_rel[rel.as_str()];
        let previous = base_by_rel[rel.as_str()];
        jobs.push(Job {
            op: Op::PullReplace,
            rel: rel.clone(),
            dest_rel: rel.clone(),
            size: e.size,
            hash: e.hash.clone(),
            prior: Some((previous.size, previous.hash.clone())),
        });
    }
    for rel in &diff.push {
        if !retry_allows(retry_set.as_ref(), rel) {
            continue;
        }
        let e = local_by_rel[rel.as_str()];
        jobs.push(Job {
            op: Op::Push,
            rel: rel.clone(),
            dest_rel: rel.clone(),
            size: e.size,
            hash: e.hash.clone(),
            prior: None,
        });
    }
    for rel in &diff.push_replace {
        if !retry_allows(retry_set.as_ref(), rel) {
            continue;
        }
        let e = local_by_rel[rel.as_str()];
        let previous = base_by_rel[rel.as_str()];
        jobs.push(Job {
            op: Op::PushReplace,
            rel: rel.clone(),
            dest_rel: rel.clone(),
            size: e.size,
            hash: e.hash.clone(),
            prior: Some((previous.size, previous.hash.clone())),
        });
    }
    // Conflicts: never overwrite local — pull the remote copy alongside it.
    // Skip when any contiguous numbered conflict copy is already identical.
    // A different same-day copy gets the next suffix during the verified
    // commit.
    for rel in &diff.conflict {
        if !retry_allows(retry_set.as_ref(), rel) {
            continue;
        }
        let e = remote_by_rel[rel.as_str()];
        let dest_rel = sync_core::conflict_name(rel, &host, &date);
        let already =
            match sync_core::conflict_copy_already_present(&root, &dest_rel, e.size, &e.hash) {
                Ok(already) => already,
                Err(error) => {
                    emit_log(
                        &app,
                        "warn",
                        format!("conflict copy scan for {rel} failed: {error}"),
                    );
                    failed.push(SyncFailureItem {
                        rel: rel.clone(),
                        op: Op::Conflict.name().to_string(),
                        error: format!("conflict copy scan failed: {error}"),
                    });
                    continue;
                }
            };
        if already {
            emit_log(
                &app,
                "info",
                format!("conflict copy for {rel} already current — skipped"),
            );
            continue;
        }
        jobs.push(Job {
            op: Op::Conflict,
            rel: rel.clone(),
            dest_rel,
            size: e.size,
            hash: e.hash.clone(),
            prior: None,
        });
    }

    // 5. Transfers — bounded concurrency over the one pooled client.
    let total = jobs.len();
    let mut done = 0usize;
    let mut pulled = 0u32;
    let mut pushed = 0u32;
    let mut conflicts = 0u32;
    let mut bytes_pulled = 0u64;
    let mut bytes_pushed = 0u64;
    let mut was_cancelled = false;
    emit_progress(&app, "transfer", 0, total, "");

    // Admit only a small batch at a time. A semaphore limits active I/O but a
    // task-per-file queue still allocates one future and captures several
    // clones for every file in a large vault.
    let mut queue = std::collections::VecDeque::from(jobs);
    let sem = Arc::new(tokio::sync::Semaphore::new(TRANSFER_CONCURRENCY));
    while !queue.is_empty() {
        let mut set = tokio::task::JoinSet::new();
        for _ in 0..TRANSFER_QUEUE_LIMIT {
            let Some(job) = queue.pop_front() else { break };
            let client = transfer_client.clone();
            let base = base.clone();
            let token = token.clone();
            let root = root.clone();
            let sem = sem.clone();
            set.spawn(async move {
                let permit = tokio::select! {
                    _ = wait_for_cancel() => return JobOutcome { op: job.op, rel: job.rel, bytes: 0, result: Err(cancelled_error()) },
                    permit = sem.acquire_owned() => match permit {
                        Ok(permit) => permit,
                        Err(_) => return JobOutcome { op: job.op, rel: job.rel, bytes: 0, result: Err("transfer scheduler stopped".to_string()) },
                    },
                };
                if crate::sync::cancelled() {
                    return JobOutcome { op: job.op, rel: job.rel, bytes: 0, result: Err(cancelled_error()) };
                }
                let result = run_job(client, base, token, root, job).await;
                drop(permit);
                result
            });
        }
        while let Some(joined) = set.join_next().await {
            let outcome = match joined {
                Ok(o) => o,
                Err(e) => {
                    emit_log(&app, "error", format!("transfer task panicked: {e}"));
                    continue;
                }
            };
            done += 1;
            emit_progress(&app, "transfer", done, total, &outcome.rel);
            match outcome.result {
                Ok(success) => {
                    match outcome.op {
                        Op::Pull | Op::PullReplace => {
                            if success.changed {
                                pulled += 1;
                            }
                            bytes_pulled += outcome.bytes;
                        }
                        Op::Push | Op::PushReplace => {
                            pushed += 1;
                            bytes_pushed += outcome.bytes;
                        }
                        Op::Conflict => {
                            if success.changed {
                                conflicts += 1;
                            }
                            bytes_pulled += outcome.bytes;
                        }
                    }
                    emit_log(
                        &app,
                        "info",
                        format!("{} {} — {}", outcome.op.name(), outcome.rel, success.detail),
                    );
                }
                Err(error) => {
                    if error == "cancelled" {
                        was_cancelled = true;
                    } else {
                        emit_log(
                            &app,
                            "error",
                            format!("{} {} failed: {error}", outcome.op.name(), outcome.rel),
                        );
                    }
                    failed.push(SyncFailureItem {
                        rel: outcome.rel,
                        op: outcome.op.name().to_string(),
                        error,
                    });
                }
            }
        }
    }

    if failed.is_empty() && !was_cancelled {
        let final_root = root.clone();
        let final_local = tokio::task::spawn_blocking(move || {
            let mut cache = hash_cache().lock().map_err(|error| error.to_string())?;
            let (entries, skipped) = sync_core::build_manifest(&final_root, &mut cache);
            if !skipped.is_empty() {
                return Err("final local scan is incomplete".to_string());
            }
            Ok::<_, String>(entries)
        })
        .await
        .map_err(|error| error.to_string())?;
        let base_result = async {
            let final_local = final_local?;
            let final_remote = fetch_manifest_with(&transfer_client, &base, &token).await?;
            if final_remote.sync_protocol_version != sync_core::SYNC_PROTOCOL_VERSION
                || final_remote.journal_version != sync_core::JOURNAL_VERSION
            {
                return Err("peer sync protocol changed during transfer".to_string());
            }
            let common = sync_core::common_baseline(&final_local, &final_remote.files);
            let own_fingerprint = get_identity(&app)?.fingerprint;
            let response = transfer_client
                .put(format!("{}/sync/base", base.trim_end_matches('/')))
                .bearer_auth(&token)
                .header("x-mesa-fingerprint", own_fingerprint)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(serde_json::to_vec(&common).map_err(|error| error.to_string())?)
                .timeout(Duration::from_secs(300))
                .send()
                .await
                .map_err(friendly_err)?;
            if !response.status().is_success() {
                return Err(format!(
                    "peer did not accept sync base: {}",
                    response.status()
                ));
            }
            sync_core::save_peer_baseline(&root, &fingerprint, common)
                .map_err(|error| format!("could not save sync base: {error}"))?;
            Ok::<_, String>(())
        }
        .await;
        if let Err(error) = base_result {
            failed.push(SyncFailureItem {
                rel: String::new(),
                op: "baseline".to_string(),
                error,
            });
        }
    }

    let report = SyncReport {
        fingerprint,
        pulled,
        pushed,
        conflicts,
        up_to_date: diff.same,
        failed,
        bytes_pulled,
        bytes_pushed,
        total_local: local.len() as u32,
        total_remote: remote.len() as u32,
        duration_ms: started.elapsed().as_millis() as u64,
        cancelled: was_cancelled,
    };
    emit_progress(&app, "done", done, total, "");
    emit_log(
        &app,
        if report.failed.iter().any(|f| f.error != "cancelled") {
            "warn"
        } else {
            "info"
        },
        format!(
            "sync finished in {}ms — ↓{} (+{} conflict copies) ↑{}, {} up-to-date, {} failed{}",
            report.duration_ms,
            report.pulled,
            report.conflicts,
            report.pushed,
            report.up_to_date,
            report.failed.len(),
            if report.cancelled { ", cancelled" } else { "" }
        ),
    );
    // Drain the coalescer now so the "done" progress and this final line reach
    // the console immediately instead of waiting out the flush window.
    flush_sync_events(&app);
    Ok(report)
}

// === Discovery ============================================================

#[tauri::command]
pub fn sync_discovery_start(
    app: tauri::AppHandle,
    name: String,
    port: u16,
    listening: bool,
) -> Result<(), String> {
    use std::net::UdpSocket;

    let mut guard = discovery_state().lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let socket = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)).map_err(|e| e.to_string())?;
    socket.set_broadcast(true).map_err(|e| e.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|e| e.to_string())?;

    let running = Arc::new(AtomicBool::new(true));
    let running_thread = running.clone();
    // Advertise this device's stable TLS certificate fingerprint so peers can
    // pin it. It doubles as the self-filter id (own packets are ignored).
    let fingerprint = get_identity(&app)?.fingerprint;
    let host = local_lan_ip().unwrap_or_else(|_| "0.0.0.0".to_string());
    let own = DiscoveryPacket {
        mesa_discovery: true,
        version: "2.0".to_string(),
        name: if name.trim().is_empty() {
            "Mesa device".to_string()
        } else {
            name.trim().to_string()
        },
        host,
        port,
        protocol: "https".to_string(),
        listening,
        fingerprint: fingerprint.clone(),
    };
    let handle = std::thread::spawn(move || {
        let dest = format!("255.255.255.255:{}", DISCOVERY_PORT);
        let payload = match serde_json::to_vec(&own) {
            Ok(v) => v,
            Err(_) => return,
        };
        let mut last_announce = Instant::now() - Duration::from_secs(10);
        let mut buf = [0u8; 4096];
        while running_thread.load(Ordering::Relaxed) {
            if last_announce.elapsed() >= Duration::from_secs(2) {
                let _ = socket.send_to(&payload, &dest);
                last_announce = Instant::now();
            }

            match socket.recv_from(&mut buf) {
                Ok((n, from)) => {
                    let Ok(mut packet) = serde_json::from_slice::<DiscoveryPacket>(&buf[..n])
                    else {
                        continue;
                    };
                    if !packet.mesa_discovery || packet.fingerprint == fingerprint {
                        continue;
                    }
                    if packet.host.trim().is_empty() || packet.host == "0.0.0.0" {
                        packet.host = from.ip().to_string();
                    }
                    let _ = app.emit(DISCOVERY_EVENT, packet);
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => break,
            }
        }
    });
    *guard = Some(DiscoveryState {
        running,
        handle: Some(handle),
    });
    Ok(())
}

#[tauri::command]
pub fn sync_discovery_stop() -> Result<(), String> {
    let mut guard = discovery_state().lock().map_err(|e| e.to_string())?;
    if let Some(mut st) = guard.take() {
        st.running.store(false, Ordering::Relaxed);
        if let Some(h) = st.handle.take() {
            let _ = h.join();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    async fn proof_server(
        key: &'static str,
    ) -> (
        String,
        String,
        Arc<AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        let CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let identity = Identity {
            cert_pem: cert.pem(),
            key_pem: signing_key.serialize_pem(),
            fingerprint: sha256_hex(cert.der().as_ref()),
        };
        let fingerprint = identity.fingerprint.clone();
        let acceptor = TlsAcceptor::from(sync_server_config(&identity).unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("https://{}", listener.local_addr().unwrap());
        let transfers = Arc::new(AtomicUsize::new(0));
        let counts = transfers.clone();
        let task = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let acceptor = acceptor.clone();
                let identity = identity.clone();
                let counts = counts.clone();
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(stream).await else {
                        return;
                    };
                    let service = service_fn(move |req: HyperRequest<Incoming>| {
                        let identity = identity.clone();
                        let counts = counts.clone();
                        async move {
                            let path = req.uri().path();
                            let body = if path == "/sync/identity" {
                                let (message, challenge) =
                                    parse_identity_request(req.uri().query().unwrap()).unwrap();
                                serde_json::to_string(
                                    &make_identity_proof(
                                        key,
                                        &message,
                                        &challenge,
                                        &identity.fingerprint,
                                    )
                                    .unwrap(),
                                )
                                .unwrap()
                            } else if path == "/sync/manifest" {
                                "{\"journalVersion\":2,\"syncProtocolVersion\":3,\"files\":[]}"
                                    .to_string()
                            } else {
                                if req.method() == HyperMethod::PUT {
                                    counts.fetch_add(1, Ordering::SeqCst);
                                }
                                "ok".to_string()
                            };
                            Ok::<_, std::convert::Infallible>(HyperResponse::new(Full::new(
                                Bytes::from(body),
                            )))
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(tls), service)
                        .await;
                });
            }
        });
        (base, fingerprint, transfers, task)
    }

    #[tokio::test]
    async fn unknown_key_refuses_peer_before_any_transfer() {
        let (base, _, transfers, task) = proof_server("peer-key").await;
        let result = establish_sync_credential(&base, "local-key", None).await;
        assert!(result
            .err()
            .unwrap()
            .contains("Peer does not know this sync key"));
        assert_eq!(transfers.load(Ordering::SeqCst), 0);
        task.abort();
    }

    #[tokio::test]
    async fn proved_peer_can_fetch_manifest_and_wrong_pin_is_refused() {
        let (base, fingerprint, transfers, task) = proof_server("shared-key").await;
        let (client, credential, observed) = establish_sync_credential(&base, "shared-key", None)
            .await
            .unwrap();
        assert_eq!(observed, fingerprint);
        assert!(fetch_manifest_with(&client, &base, &credential)
            .await
            .unwrap()
            .files
            .is_empty());
        let wrong_pin = establish_sync_credential(&base, "shared-key", Some("0".repeat(64)))
            .await
            .err()
            .unwrap();
        assert!(wrong_pin.contains("security certificate changed"));
        assert_eq!(transfers.load(Ordering::SeqCst), 0);
        task.abort();
    }

    #[test]
    fn pake_proof_is_session_nonce_and_certificate_bound() {
        let challenge = [7u8; 32];
        let fingerprint = "a".repeat(64);
        let (client, outbound) = Spake2::<Ed25519Group>::start_a(
            &Password::new(b"shared"),
            &PakeIdentity::new(b"mesa-sync-client-v3"),
            &PakeIdentity::new(b"mesa-sync-server-v3"),
        );
        let proof = make_identity_proof("shared", &outbound, &challenge, &fingerprint).unwrap();
        let reply: Vec<u8> = (0..33)
            .map(|i| u8::from_str_radix(&proof.message[i * 2..i * 2 + 2], 16).unwrap())
            .collect();
        let session = hex_bytes(&client.finish(&reply).unwrap());
        assert!(verify_server_proof(
            &session,
            &challenge,
            &fingerprint,
            &parse_hex::<32>(&proof.proof).unwrap()
        ));
        assert!(!verify_server_proof(
            "shared",
            &challenge,
            &fingerprint,
            &parse_hex::<32>(&proof.proof).unwrap()
        ));
        assert!(!verify_server_proof(
            &session,
            &[8u8; 32],
            &fingerprint,
            &parse_hex::<32>(&proof.proof).unwrap()
        ));
        assert!(!verify_server_proof(
            &session,
            &challenge,
            &"b".repeat(64),
            &parse_hex::<32>(&proof.proof).unwrap()
        ));
        let (other, _) = Spake2::<Ed25519Group>::start_a(
            &Password::new(b"shared"),
            &PakeIdentity::new(b"mesa-sync-client-v3"),
            &PakeIdentity::new(b"mesa-sync-server-v3"),
        );
        let other_session = hex_bytes(&other.finish(&reply).unwrap());
        assert!(!verify_server_proof(
            &other_session,
            &challenge,
            &fingerprint,
            &parse_hex::<32>(&proof.proof).unwrap()
        ));
    }

    #[test]
    fn hmac_matches_rfc_4231_case_2() {
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"Jefe");
        assert_eq!(
            hex_bytes(hmac::sign(&key, b"what do ya want for nothing?").as_ref()),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn identity_proof_requires_key_challenge_and_certificate() {
        let challenge = [7u8; 32];
        let proof = server_proof("correct-key", &challenge, &"a".repeat(64));
        assert!(verify_server_proof(
            "correct-key",
            &challenge,
            &"a".repeat(64),
            proof.as_ref()
        ));
        assert!(!verify_server_proof(
            "wrong-key",
            &challenge,
            &"a".repeat(64),
            proof.as_ref()
        ));
        assert!(!verify_server_proof(
            "correct-key",
            &[8u8; 32],
            &"a".repeat(64),
            proof.as_ref()
        ));
        assert!(!verify_server_proof(
            "correct-key",
            &challenge,
            &"b".repeat(64),
            proof.as_ref()
        ));
    }

    #[test]
    fn first_contact_credential_is_certificate_bound() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let credential = scoped_sync_credential("shared-key", &a);
        assert_eq!(
            credential,
            "ac654ee552735fed477f1871b9e9d0cfbcec7e44267f4a640d9ab94e359c43c8"
        );
        assert_ne!(credential, scoped_sync_credential("shared-key", &b));
        assert_ne!(credential, "shared-key");
    }

    #[tokio::test]
    async fn journal_fetch_errors_fail_closed_over_http() {
        let client = reqwest::Client::new();
        for status in [404, 405, 501, 401, 503, 200] {
            let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let address = server.server_addr().to_ip().unwrap();
            let handle = std::thread::spawn(move || {
                server
                    .recv()
                    .unwrap()
                    .respond(
                        tiny_http::Response::from_string("invalid journal")
                            .with_status_code(status),
                    )
                    .unwrap();
            });
            let result =
                fetch_journal_with(&client, &format!("http://{address}"), "test-key").await;
            assert!(result.is_err(), "status {status}");
            handle.join().unwrap();
        }
    }

    #[test]
    fn manifest_requires_journal_version() {
        assert!(serde_json::from_str::<ManifestBody>(r#"{"files":[]}"#).is_err());
        let current: ManifestBody =
            serde_json::from_str(r#"{"files":[],"journalVersion":2,"syncProtocolVersion":3}"#)
                .unwrap();
        assert_eq!(current.journal_version, sync_core::JOURNAL_VERSION);
    }

    #[tokio::test]
    async fn journal_receive_accepts_more_than_old_one_mib_limit() {
        let mut bytes =
            br#"{"version":2,"device":"peer","next_sequence":1,"operations":[],"known":[]}"#
                .to_vec();
        bytes.extend(std::iter::repeat_n(b' ', 1024 * 1024 + 1));
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let handle = std::thread::spawn(move || {
            server
                .recv()
                .unwrap()
                .respond(tiny_http::Response::from_data(bytes))
                .unwrap();
        });
        let result = fetch_journal_with(
            &reqwest::Client::new(),
            &format!("http://{address}"),
            "test-key",
        )
        .await
        .unwrap();
        assert_eq!(result.device, "peer");
        handle.join().unwrap();
    }

    #[test]
    fn transfer_reader_requires_explicit_eof_and_preserves_order() {
        let (sender, receiver) = tokio::sync::mpsc::channel(4);
        sender
            .blocking_send(TransferChunk::Data(b"abc".to_vec()))
            .unwrap();
        sender
            .blocking_send(TransferChunk::Data(b"def".to_vec()))
            .unwrap();
        sender.blocking_send(TransferChunk::End).unwrap();
        drop(sender);
        let mut reader = TransferReader {
            receiver,
            current: std::io::Cursor::new(Vec::new()),
            finished: false,
        };
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"abcdef");
        assert_eq!(reader.read(&mut [0u8; 1]).unwrap(), 0);
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        sender
            .blocking_send(TransferChunk::Data(b"partial".to_vec()))
            .unwrap();
        drop(sender);
        let mut reader = TransferReader {
            receiver,
            current: std::io::Cursor::new(Vec::new()),
            finished: false,
        };
        assert_eq!(
            reader.read_to_end(&mut Vec::new()).unwrap_err().kind(),
            std::io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn upload_hashes_and_rewinds_same_handle_and_rejects_oversize() {
        let path = std::env::temp_dir().join(format!(
            "mesa-upload-{}-{}",
            std::process::id(),
            sync_core::now_ms()
        ));
        let bytes = vec![123u8; 170_003];
        std::fs::write(&path, &bytes).unwrap();
        let (mut file, size, hash) = open_upload(&path).unwrap();
        assert_eq!(size, bytes.len() as u64);
        assert_eq!(hash, sync_core::content_hash_hex(&bytes));
        let mut actual = Vec::new();
        file.read_to_end(&mut actual).unwrap();
        assert_eq!(actual, bytes);
        drop(file);
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(MAX_PUT_BYTES as u64 + 1).unwrap();
        drop(file);
        assert_eq!(
            open_upload(&path).unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn upload_streams_same_open_file_over_real_http() {
        let path = std::env::temp_dir().join(format!(
            "mesa-http-upload-{}-{}",
            std::process::id(),
            sync_core::now_ms()
        ));
        let bytes: Vec<_> = (0..192 * 1024 + 17).map(|n| (n % 251) as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        let (file, size, hash) = open_upload(&path).unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let expected_hash = hash.clone();
        let handle = std::thread::spawn(move || {
            let mut request = server.recv().unwrap();
            assert_eq!(request.method(), &tiny_http::Method::Put);
            assert_eq!(request.body_length(), Some(bytes.len()));
            assert!(request.url().ends_with(&format!("hash={expected_hash}")));
            let mut received = Vec::new();
            request.as_reader().read_to_end(&mut received).unwrap();
            assert_eq!(received, bytes);
            request
                .respond(tiny_http::Response::from_string("ok"))
                .unwrap();
        });
        let response = reqwest::Client::new()
            .put(format!("http://{address}/sync/file"))
            .query(&[("rel", "file.bin"), ("hash", hash.as_str())])
            .header(reqwest::header::CONTENT_LENGTH, size)
            .body(reqwest::Body::from(tokio::fs::File::from_std(file)))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        handle.join().unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn receive_response_streams_and_verifies_real_http_body() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let bytes = vec![77u8; 192 * 1024 + 17];
        let expected_hash = sync_core::content_hash_hex(&bytes);
        let expected_size = bytes.len() as u64;
        let handle = std::thread::spawn(move || {
            let request = server.recv().unwrap();
            request
                .respond(tiny_http::Response::from_data(bytes))
                .unwrap();
        });
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/file"))
            .send()
            .await
            .unwrap();
        let target = std::env::temp_dir().join(format!(
            "mesa-http-receive-{}-{}",
            std::process::id(),
            sync_core::now_ms()
        ));
        let stage = receive_response(
            response,
            target.clone(),
            #[cfg(unix)]
            None,
            expected_size,
            expected_hash.clone(),
        )
        .await
        .unwrap();
        assert!(!target.exists());
        let commit_target = target.clone();
        tokio::task::spawn_blocking(move || stage.commit(&commit_target).unwrap())
            .await
            .unwrap();
        assert_eq!(
            sync_core::hash_file_streaming(&target).unwrap(),
            (expected_size, expected_hash)
        );
        std::fs::remove_file(target).unwrap();
        handle.join().unwrap();
    }

    fn line(msg: &str) -> SyncLogLine {
        SyncLogLine {
            ts: 0,
            level: "info".to_string(),
            msg: msg.to_string(),
        }
    }

    // The whole point on Windows: a full-vault sync stages thousands of console
    // lines but the flusher drains them as ONE `sync://log` array event per
    // window instead of one eval + forced repaint per file. The reduction is a
    // property of the file count, not the OS notify backend, so it is pinned
    // here rather than by a live event count. Mirrors `vaultwatch.rs`'s
    // `git_storm_collapses_to_one_send`.
    #[test]
    fn storm_of_log_lines_drains_as_one_ordered_batch() {
        let mut outbox = SyncOutbox::new();
        for i in 0..3301 {
            outbox.logs.push(line(&format!("received file-{i}.md")));
        }
        assert!(outbox.has_pending());
        let (logs, progress) = outbox.drain();
        // 3,301 events → 1 batch.
        assert_eq!(logs.len(), 3301);
        assert_eq!(logs[0].msg, "received file-0.md");
        assert_eq!(logs[3300].msg, "received file-3300.md");
        assert!(progress.is_none());
        // Fully drained: nothing left to emit, no lines dropped.
        assert!(!outbox.has_pending());
        assert!(outbox.logs.is_empty());
    }

    // Progress is a bar + current-file label, so only the newest value matters;
    // every intermediate update collapses to the latest within a window.
    #[test]
    fn progress_collapses_to_latest_within_a_window() {
        let mut outbox = SyncOutbox::new();
        for done in 1..=500usize {
            outbox.progress = Some(
                serde_json::json!({ "phase": "transfer", "done": done, "total": 500, "rel": "" }),
            );
        }
        let (logs, progress) = outbox.drain();
        assert!(logs.is_empty());
        let progress = progress.expect("latest progress survives");
        assert_eq!(progress["done"], 500);
        assert_eq!(progress["phase"], "transfer");
    }

    // `flush_now` (set by `flush_sync_events` at sync end) is cleared by a drain,
    // so it forces exactly one immediate emit and never leaves the flusher
    // spinning.
    #[test]
    fn drain_clears_the_immediate_flush_request() {
        let mut outbox = SyncOutbox::new();
        outbox.flush_now = true;
        assert!(!outbox.has_pending()); // a bare flush request has nothing staged
        let (logs, progress) = outbox.drain();
        assert!(logs.is_empty());
        assert!(progress.is_none());
        assert!(!outbox.flush_now);
    }

    // The batched array element must serialize to the exact `{ ts, level, msg }`
    // shape `SyncLogEntry` in `src/lib/sync.ts` (and `appendSyncLog`) expect —
    // the only wire-shape change is object → array, not the object itself.
    #[test]
    fn log_line_matches_frontend_entry_shape() {
        let value = serde_json::to_value(SyncLogLine {
            ts: 1234,
            level: "warn".to_string(),
            msg: "hello".to_string(),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "ts": 1234, "level": "warn", "msg": "hello" })
        );
    }

    #[test]
    fn sync_responses_do_not_opt_into_browser_cross_origin_access() {
        let response = hyper_response(StatusCode::OK, "ok");
        for header in [
            "access-control-allow-origin",
            "access-control-allow-methods",
            "access-control-allow-headers",
            "access-control-allow-private-network",
        ] {
            assert!(
                response.headers().get(header).is_none(),
                "unexpected {header}"
            );
        }
    }

    #[test]
    fn sync_run_guard_rejects_overlap_and_releases_after_drop() {
        let first = SyncRunGuard::acquire().expect("first run acquires the guard");
        assert!(SyncRunGuard::acquire().is_err());
        drop(first);
        assert!(SyncRunGuard::acquire().is_ok());
        sync_running().store(false, Ordering::Release);
    }

    #[test]
    fn retry_filter_admits_only_named_failed_paths() {
        assert!(retry_allows(None, "a.md"));
        let retry =
            std::collections::HashSet::from(["a.md".to_string(), "nested/b.pdf".to_string()]);
        assert!(retry_allows(Some(&retry), "a.md"));
        assert!(retry_allows(Some(&retry), "nested/b.pdf"));
        assert!(!retry_allows(Some(&retry), "other.md"));
    }
}
