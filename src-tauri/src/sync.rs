#[path = "sync_identity.rs"]
mod identity;
pub(crate) use identity::protect_private_directory;
pub use identity::*;
#[path = "sync_server.rs"]
mod server;
pub use server::*;

use crate::sync_policy::listener_address;
// Native HTTPS sync server and client with key proof, certificate pinning, and verified file transfers.
// Protected requests use a certificate-bound credential; shared keys are not sent as bearer tokens.
// Pure file/journal logic is in sync_core.rs; security limits are in docs/security.md.

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, PoisonError};
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
/// One pooled client uses up to four transfer connections plus control calls
/// and a lingering probe or retry connection.
const PEER_CONNECTION_LIMIT: usize = 6;
const CONNECTION_HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECTION_LIFETIME: Duration = Duration::from_secs(60 * 60);
const CONNECTION_DRAIN: Duration = Duration::from_secs(30);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Concurrent file transfers during `sync_run`. Multiplexed over one pooled
/// client, so this is N in-flight requests over a handful of reused
/// connections — not N TLS handshakes.
const TRANSFER_CONCURRENCY: usize = 4;
const TRANSFER_QUEUE_LIMIT: usize = 8;
/// Hard cap for a single PUT body (defense against a hostile peer).
const MAX_PUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_INFLIGHT_PUT_BYTES: u64 = 256 * 1024 * 1024;
const PEER_UPLOAD_BYTES_PER_HOUR: u64 = 1024 * 1024 * 1024;

fn parse_transfer_limit(value: Option<&str>) -> Result<u64, String> {
    match value {
        None => Ok(MAX_PUT_BYTES as u64),
        Some(value) => value
            .parse::<u64>()
            .ok()
            .filter(|mib| (1..=256).contains(mib))
            .map(|mib| mib * 1024 * 1024)
            .ok_or_else(|| "MESA_SYNC_MAX_FILE_MIB must be an integer from 1 to 256".into()),
    }
}

fn transfer_limit() -> Result<u64, String> {
    parse_transfer_limit(std::env::var("MESA_SYNC_MAX_FILE_MIB").ok().as_deref())
}

#[derive(Default)]
struct UploadBudget {
    state: Mutex<UploadBudgetState>,
}

#[derive(Default)]
struct UploadBudgetState {
    inflight: u64,
    peers: HashMap<IpAddr, (Instant, u64)>,
}

struct UploadReservation<'a> {
    budget: &'a UploadBudget,
    bytes: u64,
}

impl UploadBudget {
    fn reserve(
        &self,
        peer: IpAddr,
        bytes: u64,
        now: Instant,
    ) -> Result<UploadReservation<'_>, &'static str> {
        let mut state = self.state.lock().map_err(|_| "upload budget unavailable")?;
        state.peers.retain(|_, (start, _)| {
            now.saturating_duration_since(*start) < Duration::from_secs(3600)
        });
        // IPv6 address rotation within a subnet cannot reset the budget.
        let peer = AuthLimiter::bucket(peer);
        if state.inflight.saturating_add(bytes) > MAX_INFLIGHT_PUT_BYTES {
            return Err("concurrent upload byte budget reached");
        }
        if !state.peers.contains_key(&peer) && state.peers.len() >= 4096 {
            return Err("upload peer budget table is full");
        }
        let usage = state.peers.entry(peer).or_insert((now, 0));
        if usage.1.saturating_add(bytes) > PEER_UPLOAD_BYTES_PER_HOUR {
            return Err("peer hourly upload budget reached");
        }
        // Charge admitted bytes even after a failed upload, bounding repeated
        // disk staging and bandwidth abuse as well as successful publication.
        usage.1 += bytes;
        state.inflight += bytes;
        Ok(UploadReservation {
            budget: self,
            bytes,
        })
    }
}

impl Drop for UploadReservation<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.budget.state.lock() {
            state.inflight = state.inflight.saturating_sub(self.bytes);
        }
    }
}
/// Activity is UI metadata, not a file-transfer channel. Keep a hostile peer
/// from making the server retain an unbounded request body.
const MAX_ACTIVITY_BYTES: usize = 1 << 20;

struct ServerState {
    running: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
    port: u16,
    token: String,
    vault: PathBuf,
    bind_address: std::net::IpAddr,
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

pub(crate) fn require_sync_key(key: &str) -> Result<(), String> {
    if key.len() == 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && key
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
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

/// Serialize manifest scans so concurrent requests share the two-worker budget.
fn manifest_lock() -> &'static Mutex<()> {
    static S: OnceLock<Mutex<()>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(()))
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

// Stage logs and latest progress through one flusher. Wait without polling when idle;
// force-drain at sync completion.

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
            let mut st = e.state.lock().unwrap_or_else(PoisonError::into_inner);
            // Zero-cost sleep until a caller stages the first item of a burst.
            while !st.has_pending() && !st.flush_now {
                st = e.cv.wait(st).unwrap_or_else(PoisonError::into_inner);
            }
            // Early notifications do not end the coalescing window; only the fixed deadline or flush_now does.
            let deadline = Instant::now() + Duration::from_millis(SYNC_EVENT_FLUSH_MS);
            while !st.flush_now {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                let (guard, timed) =
                    e.cv.wait_timeout(st, deadline - now)
                        .unwrap_or_else(PoisonError::into_inner);
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

/// First 12 characters of an identifier, safe for any UTF-8 input.
fn short_id(value: &str) -> &str {
    value
        .char_indices()
        .nth(12)
        .map_or(value, |(end, _)| &value[..end])
}

fn emit_log(app: &tauri::AppHandle, level: &str, msg: impl Into<String>) {
    let e = sync_emitter(app);
    {
        let mut st = e.state.lock().unwrap_or_else(PoisonError::into_inner);
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
        let mut st = e.state.lock().unwrap_or_else(PoisonError::into_inner);
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
        let mut st = e.state.lock().unwrap_or_else(PoisonError::into_inner);
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

// Verify TLS signatures and a supplied leaf-certificate fingerprint.
// With no pin, record the observed fingerprint for the key-proof exchange.

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
    let bytes = read_capped(res, MAX_MANIFEST_WIRE_BYTES, "Peer manifest").await?;
    let body: ManifestBody = serde_json::from_slice(&bytes)
        .map_err(|_| "That address isn't sharing a Mesa vault.".to_string())?;
    validate_remote_manifest(&body.files)?;
    Ok(body)
}

const MAX_MANIFEST_FILES: usize = 1_000_000;
const MAX_MANIFEST_REL_BYTES: usize = 4096;
fn validate_remote_manifest(files: &[ManifestEntry]) -> Result<(), String> {
    if files.len() > MAX_MANIFEST_FILES {
        return Err("Peer manifest contains too many files".into());
    }
    let mut paths = std::collections::HashSet::with_capacity(files.len());
    for file in files {
        if file.rel.len() > MAX_MANIFEST_REL_BYTES
            || !sync_core::is_peer_rel(&file.rel)
            || file.hash.len() != 64
            || !file
                .hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !paths.insert(&file.rel)
        {
            return Err("Peer manifest contains an invalid or duplicate file entry".into());
        }
    }
    Ok(())
}

/// Largest manifest a peer may send (about a million files).
const MAX_MANIFEST_WIRE_BYTES: usize = 256 * 1024 * 1024;

/// Read a response body without ever holding more than `limit` bytes.
async fn read_capped(
    mut response: reqwest::Response,
    limit: usize,
    what: &str,
) -> Result<Vec<u8>, String> {
    let too_large = || {
        format!(
            "{what} exceeds the {} MiB exchange limit",
            limit / (1024 * 1024)
        )
    };
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(too_large());
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
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn read_journal_response(
    response: reqwest::Response,
) -> Result<sync_core::SyncJournal, String> {
    let body = read_capped(response, sync_core::MAX_JOURNAL_WIRE_BYTES, "Peer journal").await?;
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
    let token = crate::secrets::resolve_async(token).await?;
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
    open_upload_handle(sync_core::open_file_no_follow(path)?)
}

fn open_upload_handle(mut file: std::fs::File) -> std::io::Result<(std::fs::File, u64, String)> {
    use std::io::Seek;
    let max_bytes = transfer_limit().map_err(std::io::Error::other)?;
    if file.metadata()?.len() > max_bytes {
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
        if n > max_bytes {
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
    let max_bytes = transfer_limit()?;
    if job.size > max_bytes {
        return Err(format!(
            "file exceeds the configured sync limit of {max_bytes} bytes"
        ));
    }
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
pub fn sync_cancel(window: tauri::Window) -> Result<(), String> {
    crate::require_main(window.label())?;
    cancel_flag().store(true, Ordering::Release);
    cancel_notify().notify_waiters();
    Ok(())
}

/// Run one native sync with fresh manifests, journal reconciliation, bounded transfers, and final verification.
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
    let token = crate::secrets::resolve_async(token).await?;
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
                .map(short_id)
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
    let offered = remote.len();
    remote.retain(|entry| sync_core::is_peer_rel(&entry.rel));
    if remote.len() != offered {
        emit_log(
            &app,
            "warn",
            format!(
                "ignored {} remote manifest entries with hidden, ignored or unsafe paths",
                offered - remote.len()
            ),
        );
    }
    emit_log(
        &app,
        "info",
        format!(
            "remote manifest — {} files, {} bytes total, fetched in {}ms (peer cert {})",
            remote.len(),
            remote.iter().map(|e| e.size).sum::<u64>(),
            manifest_started.elapsed().as_millis(),
            short_id(&fingerprint)
        ),
    );

    let remote_journal = fetch_journal_with(&client, &base, &token).await?;
    sync_core::bind_journal_peer(&root, &fingerprint, &remote_journal.device, true)
        .map_err(|error| error.to_string())?;

    // 2. Local manifest — fresh streaming hashes off the async runtime.
    emit_progress(&app, "scan", 0, 0, "");
    let scan_started = Instant::now();
    let scan_root = root.clone();
    let (mut local, skipped) = tokio::task::spawn_blocking(move || {
        let _scan_guard = manifest_lock().lock().map_err(|e| e.to_string())?;
        sync_core::build_manifest_cancellable(&scan_root, cancel_flag()).ok_or_else(cancelled_error)
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
        // fresh bytes before the ordinary file diff.
        let scan_root = root.clone();
        let (rescanned_local, rescanned_skipped) = tokio::task::spawn_blocking(move || {
            let _scan_guard = manifest_lock().lock().map_err(|error| error.to_string())?;
            sync_core::build_manifest_cancellable(&scan_root, cancel_flag())
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
            let _scan_guard = manifest_lock().lock().map_err(|error| error.to_string())?;
            let (entries, skipped) = sync_core::build_manifest(&final_root);
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

// Blocking work: run off the main (UI) thread.
#[tauri::command(async)]
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
#[path = "sync_runtime_tests.rs"]
mod tests;
