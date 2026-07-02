// Embedded peer-to-peer sync — LocalSend-style, end-to-end encrypted.
//
// Two halves live here:
//
// **Server.** A small HTTPS server bound to 0.0.0.0 so other devices on your
// LAN or Tailscale network can reach it. The transport is TLS: on first run
// each device mints a persistent self-signed certificate (its "identity") and
// serves over HTTPS, so vault contents and the bearer token are encrypted on
// the wire. Requests are handled by a small worker pool, manifest hashes are
// streamed + cached (see `sync_core::HashCache`), and writes are atomic
// (temp file + rename) so a dropped connection can never truncate a note.
// Every request must carry `Authorization: Bearer <token>` (the shared sync
// key). Endpoints:
//   GET  /sync/manifest                  -> {"files":[{"rel","size","hash"}]}
//   GET  /sync/file?rel=<path>           -> raw bytes
//   PUT  /sync/file?rel=<path>[&hash=h]  -> write bytes (verified when h given)
// `hash` is FNV-1a/64, identical to the TypeScript reference implementation.
//
// **Client engine.** `sync_run` performs an entire two-way sync natively:
// remote manifest over pinned TLS, local manifest (streamed, cached, never
// through the webview), diff, then bounded-concurrency transfers over ONE
// pooled client — instead of the old one-TLS-handshake-per-file loop that
// made large vaults crawl and abort on the first error. Every file failure is
// collected (never aborts the rest), every step emits `sync://log` +
// `sync://progress` events for the in-app console, all requests have
// timeouts, and pulled bytes are verified against the manifest hash before an
// atomic write. The client pins the peer's SHA-256 certificate fingerprint —
// trust-on-first-use, then enforced — which detects an active MITM at the
// handshake, before any vault data moves.
//
// Pure logic (hashing, walking, diff, conflict names, atomic writes, wire
// helpers) lives in `sync_core.rs` — std-only and unit-tested with
// `cargo test`, mirrored by the reference implementations in src/lib/sync.ts.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rcgen::CertifiedKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use tiny_http::{Header, Method, Request, Response, Server, SslConfig};

use crate::sync_core;
use crate::sync_core::ManifestEntry;

const DISCOVERY_PORT: u16 = 47887;
const DISCOVERY_EVENT: &str = "sync://discovered";
const LOG_EVENT: &str = "sync://log";
const PROGRESS_EVENT: &str = "sync://progress";
/// Server worker threads: enough that a slow manifest build or big file
/// transfer never blocks the rest of a sync.
const SERVER_WORKERS: usize = 4;
/// Concurrent file transfers during `sync_run`. Multiplexed over one pooled
/// client, so this is N in-flight requests over a handful of reused
/// connections — not N TLS handshakes.
const TRANSFER_CONCURRENCY: usize = 4;
/// Hard cap for a single PUT body (defense against a hostile peer).
const MAX_PUT_BYTES: usize = 1 << 30; // 1 GiB

struct ServerState {
    running: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
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

// === Console log / progress events =======================================

fn emit_log(app: &tauri::AppHandle, level: &str, msg: impl Into<String>) {
    let _ = app.emit(
        LOG_EVENT,
        serde_json::json!({ "ts": sync_core::now_ms(), "level": level, "msg": msg.into() }),
    );
}

fn emit_progress(app: &tauri::AppHandle, phase: &str, done: usize, total: usize, rel: &str) {
    let _ = app.emit(
        PROGRESS_EVENT,
        serde_json::json!({ "phase": phase, "done": done, "total": total, "rel": rel }),
    );
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

/// Constant-time bearer-token check (compares SHA-256 digests, so timing
/// reveals nothing about how much of the token matched).
fn auth_ok(req: &Request, token: &str) -> bool {
    let expected = Sha256::digest(format!("Bearer {}", token).as_bytes());
    req.headers().iter().any(|h| {
        h.field.equiv("Authorization")
            && Sha256::digest(h.value.as_str().as_bytes()) == expected
    })
}

/// CORS headers attached to every sync response.
///
/// The webview issues these requests from a non-matching origin (e.g.
/// `tauri://localhost` / `http://tauri.localhost`), and because the client
/// sends an `Authorization` header the browser fires a preflight `OPTIONS`
/// first. Without these headers — and without answering the preflight — every
/// request fails before it ever reaches the auth check. `Allow-Private-Network`
/// covers Chromium/WebView2's Private Network Access preflight when reaching a
/// LAN address from the app origin.
fn cors_headers() -> Vec<Header> {
    [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "Authorization, Content-Type"),
        ("Access-Control-Allow-Private-Network", "true"),
        ("Access-Control-Max-Age", "86400"),
    ]
    .iter()
    .filter_map(|(k, v)| Header::from_bytes(k.as_bytes(), v.as_bytes()).ok())
    .collect()
}

fn with_cors<R: std::io::Read>(mut resp: Response<R>) -> Response<R> {
    for h in cors_headers() {
        resp.add_header(h);
    }
    resp
}

fn respond_text(req: Request, code: u16, body: &str) {
    let resp = Response::from_string(body).with_status_code(code);
    let _ = req.respond(with_cors(resp));
}

// === Server request handling ==============================================

fn handle(mut req: Request, root: &Path, token: &str, app: &tauri::AppHandle) {
    let method = req.method().clone();

    // Answer CORS preflight before the auth check — `OPTIONS` carries no
    // Authorization header, so gating it on auth would 401 every real request.
    if method == Method::Options {
        let resp = Response::empty(204);
        let _ = req.respond(with_cors(resp));
        return;
    }

    if !auth_ok(&req, token) {
        emit_log(
            app,
            "warn",
            format!("[serve] rejected {} {} — bad or missing sync key", method, req.url()),
        );
        respond_text(req, 401, "unauthorized");
        return;
    }
    let url = req.url().to_string();
    let (path, query) = match url.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (url, String::new()),
    };

    // Activity ingress: external agents POST here when they read/edit/write/
    // create a vault file, so the graph can flicker + show a live preview card.
    // Filesystem watchers can't see *reads*, so this is the only way reads show.
    // Body: {"path":"Notes/foo.md","op":"read|edit|write|create","status":"…"}.
    // The raw JSON is re-emitted to the webview as an "activity" event.
    if path == "/activity" && method == Method::Post {
        let mut body = String::new();
        if req.as_reader().read_to_string(&mut body).is_ok() {
            let _ = app.emit("activity", body);
            respond_text(req, 200, "ok");
        } else {
            respond_text(req, 400, "read error");
        }
        return;
    }

    if path == "/sync/manifest" && method == Method::Get {
        let started = Instant::now();
        let (entries, skipped) = {
            let mut cache = match hash_cache().lock() {
                Ok(c) => c,
                Err(_) => {
                    respond_text(req, 500, "cache poisoned");
                    return;
                }
            };
            sync_core::build_manifest(root, &mut cache)
        };
        for (rel, err) in &skipped {
            emit_log(app, "warn", format!("[serve] manifest skipped {rel}: {err}"));
        }
        emit_log(
            app,
            "info",
            format!(
                "[serve] manifest served — {} files in {}ms",
                entries.len(),
                started.elapsed().as_millis()
            ),
        );
        let body = sync_core::manifest_to_json(&entries);
        let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
        let _ = req.respond(with_cors(Response::from_string(body).with_header(header)));
        return;
    }

    if path == "/sync/file" {
        let Some(rel) = sync_core::query_param(&query, "rel") else {
            respond_text(req, 400, "missing rel");
            return;
        };
        let Some(full) = sync_core::safe_join(root, &rel) else {
            emit_log(app, "warn", format!("[serve] rejected unsafe path {rel:?}"));
            respond_text(req, 400, "bad path");
            return;
        };
        match method {
            // Streamed read — never loads the file into memory.
            Method::Get => match std::fs::File::open(&full) {
                Ok(file) => {
                    let _ = req.respond(with_cors(Response::from_file(file)));
                }
                Err(_) => respond_text(req, 404, "not found"),
            },
            Method::Put => {
                if req.body_length().map_or(false, |l| l > MAX_PUT_BYTES) {
                    respond_text(req, 413, "too large");
                    return;
                }
                let mut body = Vec::new();
                let read = std::io::Read::take(req.as_reader(), (MAX_PUT_BYTES + 1) as u64)
                    .read_to_end(&mut body);
                if read.is_err() {
                    respond_text(req, 400, "read error");
                    return;
                }
                if body.len() > MAX_PUT_BYTES {
                    respond_text(req, 413, "too large");
                    return;
                }
                // Integrity check: the sender includes the expected FNV-1a/64
                // so a corrupted/truncated body is rejected instead of stored.
                if let Some(expected) = sync_core::query_param(&query, "hash") {
                    let actual = sync_core::fnv1a_hex(&body);
                    if !expected.eq_ignore_ascii_case(&actual) {
                        emit_log(
                            app,
                            "warn",
                            format!("[serve] PUT {rel} rejected — hash mismatch (got {actual}, expected {expected})"),
                        );
                        respond_text(req, 422, "hash mismatch");
                        return;
                    }
                }
                match sync_core::atomic_write(&full, &body) {
                    Ok(()) => {
                        emit_log(
                            app,
                            "info",
                            format!("[serve] received {rel} ({} bytes)", body.len()),
                        );
                        respond_text(req, 200, "ok");
                    }
                    Err(e) => respond_text(req, 500, &e.to_string()),
                }
            }
            _ => respond_text(req, 405, "method not allowed"),
        }
        return;
    }

    respond_text(req, 404, "not found");
}

#[tauri::command]
pub fn sync_start(
    app: tauri::AppHandle,
    port: u16,
    token: String,
    vault: String,
) -> Result<(), String> {
    let mut guard = state().lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(()); // already listening
    }
    let id = get_identity(&app)?;
    let ssl = SslConfig {
        certificate: id.cert_pem.into_bytes(),
        private_key: id.key_pem.into_bytes(),
    };
    let server = Server::https(format!("0.0.0.0:{}", port), ssl)
        .map_err(|e| format!("could not start TLS sync server: {e}"))?;
    let server = Arc::new(server);
    let running = Arc::new(AtomicBool::new(true));
    let root = PathBuf::from(vault);
    // A small worker pool: tiny_http hands each accepted request to exactly
    // one of the threads blocked in recv_timeout, so a slow manifest build or
    // a large file transfer no longer stalls every other request.
    let mut handles = Vec::with_capacity(SERVER_WORKERS);
    for _ in 0..SERVER_WORKERS {
        let server = server.clone();
        let running = running.clone();
        let root = root.clone();
        let token = token.clone();
        let app = app.clone();
        handles.push(std::thread::spawn(move || {
            while running.load(Ordering::Relaxed) {
                match server.recv_timeout(Duration::from_millis(250)) {
                    Ok(Some(req)) => handle(req, &root, &token, &app),
                    Ok(None) => {}
                    Err(_) => break,
                }
            }
        }));
    }
    *guard = Some(ServerState { running, handles });
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
        let CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["mesa.local".to_string(), "localhost".to_string()])
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
// a byte of vault data is sent); otherwise we record what we observed so the
// caller can remember it (trust-on-first-use). Handshake signatures are still
// verified normally, so possession of the private key is proven.

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

async fn fetch_manifest_with(
    client: &reqwest::Client,
    base: &str,
    token: &str,
) -> Result<Vec<ManifestEntry>, String> {
    let url = format!("{}/sync/manifest", base.trim_end_matches('/'));
    let res = client
        .get(&url)
        .bearer_auth(token)
        // Generous: a cold peer may be hashing a large vault before replying.
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(friendly_err)?;
    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Sync key doesn't match that device.".to_string());
    }
    if !status.is_success() {
        return Err(format!("Device responded {}.", status.as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let body: ManifestBody = serde_json::from_slice(&bytes)
        .map_err(|_| "That address isn't sharing a Mesa vault.".to_string())?;
    Ok(body.files)
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
    let observed = Arc::new(Mutex::new(None));
    let client = build_pinned_client(normalize_pin(pin), observed.clone())?;
    let files = fetch_manifest_with(&client, &base, &token).await?;
    Ok(ManifestResult {
        fingerprint: take_fingerprint(&observed),
        files,
    })
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

#[derive(Clone, Copy, PartialEq)]
enum Op {
    Pull,
    Push,
    Conflict,
}

impl Op {
    fn name(self) -> &'static str {
        match self {
            Op::Pull => "pull",
            Op::Push => "push",
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
}

struct JobOutcome {
    op: Op,
    rel: String,
    bytes: u64,
    /// Ok(detail-line) or Err(error).
    result: Result<String, String>,
}

async fn run_job(
    client: reqwest::Client,
    base: String,
    token: String,
    root: PathBuf,
    job: Job,
) -> JobOutcome {
    // One retry on any failure: transient LAN hiccups and "file changed while
    // hashing" races both deserve a second chance before being reported.
    let first = run_job_once(&client, &base, &token, &root, &job).await;
    let result = match first {
        Ok(detail) => Ok(detail),
        Err(first_err) => {
            tokio::time::sleep(Duration::from_millis(300)).await;
            match run_job_once(&client, &base, &token, &root, &job).await {
                Ok(detail) => Ok(format!("{detail} (after retry: {first_err})")),
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

async fn run_job_once(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    root: &Path,
    job: &Job,
) -> Result<String, String> {
    let url = format!("{}/sync/file", base.trim_end_matches('/'));
    match job.op {
        Op::Pull | Op::Conflict => {
            let dest = sync_core::safe_join(root, &job.dest_rel)
                .ok_or_else(|| format!("unsafe destination path {:?}", job.dest_rel))?;
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
            let bytes = res.bytes().await.map_err(|e| e.to_string())?;
            // Verify against the manifest before anything touches disk. A
            // mismatch means truncation, corruption, or an edit mid-sync.
            let actual = sync_core::fnv1a_hex(&bytes);
            if !actual.eq_ignore_ascii_case(&job.hash) {
                return Err(format!(
                    "content hash mismatch after transfer (expected {}, got {}, {} bytes)",
                    job.hash,
                    actual,
                    bytes.len()
                ));
            }
            let n = bytes.len();
            let dest2 = dest.clone();
            tokio::task::spawn_blocking(move || sync_core::atomic_write(&dest2, &bytes))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("write failed: {e}"))?;
            Ok(format!("{} bytes, verified", n))
        }
        Op::Push => {
            let src = sync_core::safe_join(root, &job.rel)
                .ok_or_else(|| format!("unsafe source path {:?}", job.rel))?;
            let (data, hash) = tokio::task::spawn_blocking(move || {
                let data = std::fs::read(&src)?;
                let hash = sync_core::fnv1a_hex(&data);
                Ok::<_, std::io::Error>((data, hash))
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("read failed: {e}"))?;
            let n = data.len();
            let res = client
                .put(&url)
                .query(&[("rel", job.rel.as_str()), ("hash", hash.as_str())])
                .bearer_auth(token)
                .timeout(transfer_timeout(n as u64))
                .body(data)
                .send()
                .await
                .map_err(friendly_err)?;
            if !res.status().is_success() {
                return Err(format!("device responded {}", res.status().as_u16()));
            }
            Ok(format!("{} bytes, hash-checked by receiver", n))
        }
    }
}

/// Cancel the in-flight `sync_run` after the transfers already in the air.
#[tauri::command]
pub fn sync_cancel() {
    cancel_flag().store(true, Ordering::Relaxed);
}

/// Run a complete two-way sync against one peer. This is THE sync path:
/// everything happens natively (no vault bytes or hashing in the webview),
/// over one pooled pinned-TLS client, with bounded concurrency, per-file
/// verification, atomic writes, and per-file error collection. Emits
/// `sync://log` and `sync://progress` throughout so the UI console can show —
/// and the user can copy — exactly what happened.
#[tauri::command]
pub async fn sync_run(
    app: tauri::AppHandle,
    root: String,
    base: String,
    token: String,
    pin: Option<String>,
) -> Result<SyncReport, String> {
    let started = Instant::now();
    cancel_flag().store(false, Ordering::Relaxed);
    let root = PathBuf::from(&root);
    let base = base.trim_end_matches('/').to_string();
    let pin = normalize_pin(pin);

    emit_log(
        &app,
        "info",
        format!(
            "sync started — peer {base}, pin {}",
            pin.as_deref().map(|p| &p[..12.min(p.len())]).unwrap_or("none (trust-on-first-use)")
        ),
    );
    emit_progress(&app, "manifest", 0, 0, "");

    // 1. Remote manifest over pinned TLS. Establishes (and verifies, when a
    //    pin is known) the peer's certificate before any vault data moves.
    let observed = Arc::new(Mutex::new(None));
    let client = build_pinned_client(pin.clone(), observed.clone())?;
    let manifest_started = Instant::now();
    let remote = match fetch_manifest_with(&client, &base, &token).await {
        Ok(files) => files,
        Err(e) => {
            emit_log(&app, "error", format!("remote manifest failed: {e}"));
            return Err(e);
        }
    };
    let fingerprint = take_fingerprint(&observed);
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

    // 2. Local manifest — streamed + cached hashing off the async runtime.
    emit_progress(&app, "scan", 0, 0, "");
    let scan_started = Instant::now();
    let scan_root = root.clone();
    let (local, skipped) = tokio::task::spawn_blocking(move || {
        let mut cache = hash_cache().lock().map_err(|e| e.to_string())?;
        Ok::<_, String>(sync_core::build_manifest(&scan_root, &mut cache))
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut failed: Vec<SyncFailureItem> = Vec::new();
    for (rel, err) in &skipped {
        emit_log(&app, "warn", format!("local scan skipped {rel}: {err}"));
        failed.push(SyncFailureItem {
            rel: rel.clone(),
            op: "scan".to_string(),
            error: err.clone(),
        });
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

    // 3. Diff.
    let diff = sync_core::diff_manifests(&local, &remote);
    emit_log(
        &app,
        "info",
        format!(
            "diff — pull {}, push {}, conflicts {}, up-to-date {}",
            diff.pull.len(),
            diff.push.len(),
            diff.conflict.len(),
            diff.same
        ),
    );

    // 4. Pin every transfer to the fingerprint just established. Even in
    //    trust-on-first-use mode a push can no longer leak to a substituted
    //    cert: a mismatch aborts at the TLS handshake, before the body is sent.
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
    let host = sync_core::host_of_base(&base);
    let date = sync_core::utc_date_string();
    let mut jobs: Vec<Job> = Vec::new();
    for rel in &diff.pull {
        let e = remote_by_rel[rel.as_str()];
        jobs.push(Job {
            op: Op::Pull,
            rel: rel.clone(),
            dest_rel: rel.clone(),
            size: e.size,
            hash: e.hash.clone(),
        });
    }
    for rel in &diff.push {
        let e = local_by_rel[rel.as_str()];
        jobs.push(Job {
            op: Op::Push,
            rel: rel.clone(),
            dest_rel: rel.clone(),
            size: e.size,
            hash: e.hash.clone(),
        });
    }
    // Conflicts: never overwrite local — pull the remote copy alongside it.
    // Skip when an identical conflict copy from a previous run already exists.
    for rel in &diff.conflict {
        let e = remote_by_rel[rel.as_str()];
        let dest_rel = sync_core::conflict_name(rel, &host, &date);
        let already = sync_core::safe_join(&root, &dest_rel)
            .filter(|p| p.exists())
            .and_then(|p| {
                hash_cache()
                    .lock()
                    .ok()
                    .and_then(|mut c| c.hash_file(&p).ok())
            })
            .map_or(false, |(_, h)| h == e.hash);
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
    let mut cancelled = false;
    emit_progress(&app, "transfer", 0, total, "");

    let sem = Arc::new(tokio::sync::Semaphore::new(TRANSFER_CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for job in jobs {
        let sem = sem.clone();
        let client = transfer_client.clone();
        let base = base.clone();
        let token = token.clone();
        let root = root.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            if cancel_flag().load(Ordering::Relaxed) {
                return JobOutcome {
                    op: job.op,
                    rel: job.rel,
                    bytes: 0,
                    result: Err("cancelled".to_string()),
                };
            }
            run_job(client, base, token, root, job).await
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
            Ok(detail) => {
                match outcome.op {
                    Op::Pull => {
                        pulled += 1;
                        bytes_pulled += outcome.bytes;
                    }
                    Op::Push => {
                        pushed += 1;
                        bytes_pushed += outcome.bytes;
                    }
                    Op::Conflict => {
                        conflicts += 1;
                        bytes_pulled += outcome.bytes;
                    }
                }
                emit_log(
                    &app,
                    "info",
                    format!("{} {} — {detail}", outcome.op.name(), outcome.rel),
                );
            }
            Err(error) => {
                if error == "cancelled" {
                    cancelled = true;
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
        cancelled,
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
        version: "1.0".to_string(),
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
