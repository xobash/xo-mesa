// Loopback activity bridge for the embedded Pi agent.
//
// The living graph reacts to file access by listening for an "activity" event
// on the webview (see the activity bridge in src/store.ts). The LAN sync server
// (sync.rs) already re-emits that event for its `POST /activity` route, but that
// server only runs when the user turns on device sync, and it binds to 0.0.0.0
// for peer devices. Neither is appropriate for the *local* Pi agent: it must
// work with zero setup and must not depend on exposing anything to the network.
//
// So this module runs a second, tiny HTTP server bound to loopback only
// (127.0.0.1) with a per-run bearer token. Mesa loads a small Pi extension
// (mesa-activity.ts) into the embedded terminal; that extension reports every
// read/edit/write Pi performs — across any model or provider — to this server,
// which re-emits it as an "activity" event so the graph flickers and shows a
// live preview card. Everything stays on the device.
//
// The request-handling shape deliberately mirrors sync.rs so the two servers
// stay easy to reason about together.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
};

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tiny_http::{Method, Request, Response, Server};

/// The Pi extension sources, compiled into the binary and written to temp files
/// at startup so Mesa can hand Pi real paths via (repeatable) `--extension`.
/// Bundling them with `include_str!` means the shipped extensions are exactly
/// what was code-reviewed in this repo — nothing is fetched from npm or the
/// network at runtime.
const EXTENSION_SRC: &str = include_str!("../resources/mesa-activity.ts");
const GOAL_EXTENSION_SRC: &str = include_str!("../resources/mesa-goal.ts");
const CONTEXT_EXTENSION_SRC: &str = include_str!("../resources/mesa-context.ts");
const BROWSER_EXTENSION_SRC: &str = include_str!("../resources/mesa-browser.ts");
const BROWSER_QUEUE_SRC: &str = include_str!("../resources/mesa-browser-queue.ts");
const DEEP_RESEARCH_EXTENSION_SRC: &str = include_str!("../resources/mesa-deep-research.ts");

/// Loopback ports to try, in order (inclusive). The first free one wins.
const PORT_FIRST: u16 = 8788;
const PORT_LAST: u16 = 8820;
/// Request workers for the loopback bridge. One may wait for a rendered
/// `/browse` result while the others keep snapshot ingest and control routes
/// responsive.
const ACTIVITY_SERVER_WORKERS: usize = 4;
const ACTIVITY_STOP_POLL: Duration = Duration::from_millis(50);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResearchDecision {
    Accepted,
    Rejected,
    Stopped,
}

#[derive(Clone, Serialize)]
struct ResearchReply {
    status: ResearchDecision,
    message: String,
}

struct ResearchPending {
    run_id: String,
    request_id: String,
    sender: std::sync::mpsc::SyncSender<ResearchReply>,
    replied: bool,
}

/// One admitted finish wait leaves the other loopback workers free for
/// browsing, snapshots and lifecycle events. No result cache survives a wait.
#[derive(Default)]
struct ResearchReplies(Mutex<Option<ResearchPending>>);

struct ResearchWait<'a> {
    replies: &'a ResearchReplies,
    receiver: std::sync::mpsc::Receiver<ResearchReply>,
}

impl ResearchReplies {
    fn begin(&self, run_id: String, request_id: String) -> Result<ResearchWait<'_>, String> {
        let mut pending = self.0.lock().map_err(|e| e.to_string())?;
        if pending.is_some() {
            return Err("another finish is awaiting validation".into());
        }
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        *pending = Some(ResearchPending {
            run_id,
            request_id,
            sender,
            replied: false,
        });
        Ok(ResearchWait {
            replies: self,
            receiver,
        })
    }

    fn respond(&self, run_id: &str, request_id: &str, reply: ResearchReply) -> Result<(), String> {
        let mut pending = self.0.lock().map_err(|e| e.to_string())?;
        let pending = pending
            .as_mut()
            .filter(|p| p.run_id == run_id && p.request_id == request_id)
            .ok_or("no matching finish awaiting validation")?;
        if pending.replied {
            return Err("finish already answered".into());
        }
        pending.sender.try_send(reply).map_err(|e| e.to_string())?;
        pending.replied = true;
        Ok(())
    }
}

impl ResearchWait<'_> {
    fn wait(&self, running: &AtomicBool, timeout: Duration) -> Result<ResearchReply, String> {
        let start = std::time::Instant::now();
        while running.load(Ordering::Acquire) && start.elapsed() < timeout {
            match self
                .receiver
                .recv_timeout(ACTIVITY_STOP_POLL.min(timeout.saturating_sub(start.elapsed())))
            {
                Ok(reply) => return Ok(reply),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        Err("Mesa did not acknowledge validation before the bridge stopped or timed out; completion is unconfirmed".into())
    }
}

impl Drop for ResearchWait<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.replies.0.lock() {
            *pending = None;
        }
    }
}

fn research_replies() -> &'static ResearchReplies {
    static REPLIES: OnceLock<ResearchReplies> = OnceLock::new();
    REPLIES.get_or_init(ResearchReplies::default)
}

/// Only the main store validates research; the remote harness has no IPC grant.
#[tauri::command]
pub fn deep_research_respond(
    window: tauri::Window,
    run_id: String,
    request_id: String,
    status: ResearchDecision,
    message: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("only the main workspace may validate Deep Research".into());
    }
    research_replies().respond(&run_id, &request_id, ResearchReply { status, message })
}

enum HarnessBodyError {
    TooLarge,
    Read,
    InvalidUtf8,
}

/// Read only the bounded snapshot payload. The route must do this before JSON
/// parsing or token validation because `/harness` cannot use header auth: the
/// browser reporter sends a no-CORS request with the token in its body.
fn read_harness_body(req: &mut Request) -> Result<String, HarnessBodyError> {
    if req
        .body_length()
        .map(|length| length > crate::harness::SNAPSHOT_BODY_CAP)
        .unwrap_or(false)
    {
        return Err(HarnessBodyError::TooLarge);
    }

    let mut bytes = Vec::with_capacity(
        req.body_length()
            .unwrap_or(0)
            .min(crate::harness::SNAPSHOT_BODY_CAP),
    );
    req.as_reader()
        .take((crate::harness::SNAPSHOT_BODY_CAP + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| HarnessBodyError::Read)?;
    if bytes.len() > crate::harness::SNAPSHOT_BODY_CAP {
        return Err(HarnessBodyError::TooLarge);
    }
    String::from_utf8(bytes).map_err(|_| HarnessBodyError::InvalidUtf8)
}

#[derive(Clone, Serialize)]
pub struct ActivityInfo {
    pub port: u16,
    pub token: String,
    #[serde(rename = "extensionPath")]
    pub extension_path: String,
    #[serde(rename = "goalExtensionPath")]
    pub goal_extension_path: String,
    #[serde(rename = "contextExtensionPath")]
    pub context_extension_path: String,
    #[serde(rename = "browserExtensionPath")]
    pub browser_extension_path: String,
    #[serde(rename = "deepResearchExtensionPath")]
    pub deep_research_extension_path: String,
}

struct ActivityServer {
    running: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
    info: ActivityInfo,
}

/// A `/browse` request can wait for a rendered snapshot for several seconds.
/// Admit only one so concurrent browse calls cannot occupy the whole request
/// pool and starve the `/harness` snapshot needed by the admitted call.
struct BrowsePermit<'a> {
    active: &'a AtomicBool,
}

impl<'a> BrowsePermit<'a> {
    fn try_acquire(active: &'a AtomicBool) -> Option<Self> {
        active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self { active })
    }
}

impl Drop for BrowsePermit<'_> {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

fn state() -> &'static Mutex<Option<ActivityServer>> {
    static S: OnceLock<Mutex<Option<ActivityServer>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

// The context is repeated in the model system prompt before every turn. Keep
// this server-side bound small so a large tab list cannot consume the window.
const CONTEXT_MAX_BYTES: usize = 8 * 1024;

fn context_state() -> &'static Mutex<String> {
    static CONTEXT: OnceLock<Mutex<String>> = OnceLock::new();
    CONTEXT.get_or_init(|| Mutex::new(String::new()))
}

fn bounded_context(mut context: String) -> String {
    context = context.trim().to_string();
    if context.len() <= CONTEXT_MAX_BYTES {
        return context;
    }
    let mut end = CONTEXT_MAX_BYTES;
    while !context.is_char_boundary(end) {
        end -= 1;
    }
    context.truncate(end);
    context
}

fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// A non-cryptographic but unguessable-enough token for a loopback-only server.
/// This is not a secret against a network attacker (there is no network here);
/// it just stops unrelated local processes from spamming the graph by accident.
fn make_token() -> String {
    let seed = format!("{}-{}", std::process::id(), nanos());
    let a = fnv1a(seed.as_bytes());
    let b = fnv1a(format!("{seed}-mesa-activity").as_bytes());
    format!("{a:016x}{b:016x}")
}

/// Materialize the bundled Pi extensions; returns
/// (activity_path, goal_path, context_path, browser_path, deep_research_path).
fn write_extensions() -> Result<(String, String, String, String, String), String> {
    // Never reuse a predictable shared temp directory. The old path let a
    // local process pre-place a symlink and make startup overwrite an
    // arbitrary file. A newly-created directory plus create_new files makes
    // both the directory and every extension fail closed on a collision.
    let dir = std::env::temp_dir().join(format!("mesa-pi-{}-{}", std::process::id(), nanos()));
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let write = |path: &std::path::Path, source: &str| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.write_all(source.as_bytes()).map_err(|e| e.to_string())
    };
    let activity = dir.join("mesa-activity.ts");
    write(&activity, EXTENSION_SRC)?;
    let goal = dir.join("mesa-goal.ts");
    write(&goal, GOAL_EXTENSION_SRC)?;
    let context = dir.join("mesa-context.ts");
    write(&context, CONTEXT_EXTENSION_SRC)?;
    let browser = dir.join("mesa-browser.ts");
    write(&browser, BROWSER_EXTENSION_SRC)?;
    let browser_queue = dir.join("mesa-browser-queue.ts");
    write(&browser_queue, BROWSER_QUEUE_SRC)?;
    let deep_research = dir.join("mesa-deep-research.ts");
    write(&deep_research, DEEP_RESEARCH_EXTENSION_SRC)?;
    Ok((
        activity.to_string_lossy().to_string(),
        goal.to_string_lossy().to_string(),
        context.to_string_lossy().to_string(),
        browser.to_string_lossy().to_string(),
        deep_research.to_string_lossy().to_string(),
    ))
}

fn auth_ok(req: &Request, token: &str) -> bool {
    let expected = format!("Bearer {}", token);
    req.headers()
        .iter()
        .any(|h| h.field.equiv("Authorization") && h.value.as_str() == expected)
}

fn json_response(req: Request, json: String) {
    let mut resp = Response::from_string(json);
    if let Ok(h) = "Content-Type: application/json".parse::<tiny_http::Header>() {
        resp = resp.with_header(h);
    }
    let _ = req.respond(resp);
}

/// Run one blocking operation while the activity server remains live. The
/// caller stops waiting at shutdown instead of inheriting the operation's
/// timeout. `/browse` admission bounds detached work to at most one fallback.
fn blocking_while_running<T, F>(
    running: &AtomicBool,
    thread_name: &str,
    operation: F,
) -> Result<Option<T>, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    if !running.load(Ordering::Acquire) {
        return Ok(None);
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || {
            let _ = sender.send(operation());
        })
        .map_err(|error| format!("could not start {thread_name}: {error}"))?;
    loop {
        if !running.load(Ordering::Acquire) {
            return Ok(None);
        }
        match receiver.recv_timeout(ACTIVITY_STOP_POLL) {
            Ok(result) => return Ok(Some(result)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!("{thread_name} stopped without a result"));
            }
        }
    }
}

fn browse_fetch_while_running(
    target: String,
    running: &AtomicBool,
) -> Option<Result<crate::browse::BrowsePage, String>> {
    match blocking_while_running(running, "mesa-activity-browse-fetch", move || {
        crate::browse::browse_fetch_blocking(target)
    }) {
        Ok(result) => result,
        Err(error) => Some(Err(error)),
    }
}

fn handle_request(
    mut req: Request,
    token: &str,
    app: &tauri::AppHandle,
    running: &AtomicBool,
    browse_active: &AtomicBool,
) {
    let url = req.url().to_string();
    let method = req.method().clone();
    // Rendered-DOM snapshots from the native harness webview. This route is
    // token-in-body instead of header-auth: the reporter posts with
    // `mode: "no-cors"` (the only way an https page may reach loopback without
    // a preflight), and no-cors requests cannot carry an Authorization header.
    // `ingest_snapshot_body` verifies the same per-run token before storing.
    if url == "/harness" && method == Method::Post {
        match read_harness_body(&mut req) {
            Ok(body) => {
                let _ = crate::harness::ingest_snapshot_body(app, &body, token);
                let _ = req.respond(Response::from_string("ok"));
            }
            Err(HarnessBodyError::TooLarge) => {
                let _ =
                    req.respond(Response::from_string("snapshot too large").with_status_code(413));
            }
            Err(HarnessBodyError::Read | HarnessBodyError::InvalidUtf8) => {
                let _ = req.respond(Response::from_string("read error").with_status_code(400));
            }
        }
        return;
    }
    if !auth_ok(&req, token) {
        let _ = req.respond(Response::from_string("unauthorized").with_status_code(401));
        return;
    }
    if url == "/activity" && method == Method::Post {
        let mut body = String::new();
        if req.as_reader().read_to_string(&mut body).is_ok() {
            let _ = app.emit("activity", body);
            let _ = req.respond(Response::from_string("ok"));
        } else {
            let _ = req.respond(Response::from_string("read error").with_status_code(400));
        }
        return;
    }
    // Current path-only Mesa workspace context. The bundled context extension
    // reads this before every Pi turn, so a long-lived/shared PTY follows the
    // main workspace without restarting or relying on immutable process env.
    if url == "/context" && method == Method::Get {
        let context = context_state()
            .lock()
            .map(|context| context.clone())
            .unwrap_or_default();
        json_response(req, serde_json::json!({ "context": context }).to_string());
        return;
    }
    // Pi's `browse` tool: navigate the visible harness and answer with the
    // RENDERED page. The `mesa://browse` event pops the wing open; the wing
    // drives the native harness webview; its injected reporter streams the
    // rendered DOM back here (POST /harness above). We wait for the snapshot
    // that belongs to this navigation, so the agent reads exactly what the
    // user's harness displays. If no live harness materializes (no Pi surface
    // mounted, or the native webview failed and the wing is on the legacy
    // iframe path), fall back to the shared-client native fetch — clearly
    // flagged `rendered: false` so the tool/model can say so honestly.
    if url == "/browse" && method == Method::Post {
        let Some(_browse_permit) = BrowsePermit::try_acquire(browse_active) else {
            let mut response =
                Response::from_string("browse already in progress").with_status_code(429);
            if let Ok(header) = "Retry-After: 1".parse::<tiny_http::Header>() {
                response = response.with_header(header);
            }
            let _ = req.respond(response);
            return;
        };
        let mut body = String::new();
        if req.as_reader().read_to_string(&mut body).is_err() {
            let _ = req.respond(Response::from_string("read error").with_status_code(400));
            return;
        }
        let target = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(String::from))
            .unwrap_or_default();
        if target.is_empty() {
            let _ = req.respond(Response::from_string("missing url").with_status_code(400));
            return;
        }
        let gen = crate::harness::bump_nav_gen();
        let bumped_at = std::time::Instant::now();
        // Old-page ticks are debounced ≥900ms apart; by +600ms the webview has
        // left the previous page, so a time-qualified snapshot is trustworthy.
        let min_at = bumped_at + Duration::from_millis(600);
        let _ = app.emit("mesa://browse", target.clone());
        let mut nudged = false;
        let mut rendered: Option<crate::harness::HarnessSnapshot> = None;
        while running.load(Ordering::Acquire) && bumped_at.elapsed() < Duration::from_secs(9) {
            if let Some(snap) =
                crate::harness::wait_for_snapshot(gen, &target, min_at, Duration::from_millis(450))
            {
                rendered = Some(snap);
                break;
            }
            let live = crate::harness::webview_exists(app);
            if !live && bumped_at.elapsed() > Duration::from_millis(2500) {
                break; // no harness anywhere — don't stall the agent
            }
            if live && !nudged && bumped_at.elapsed() > Duration::from_millis(2000) {
                crate::harness::request_report(app);
                nudged = true;
            }
        }
        if !running.load(Ordering::Acquire) {
            let _ = req.respond(Response::from_string("server stopping").with_status_code(503));
            return;
        }
        let json = match rendered {
            Some(snap) => serde_json::json!({
                "finalUrl": snap.url,
                "title": snap.title,
                "status": 200,
                "contentType": "text/html",
                "frameBlocked": false,
                "body": snap.text,
                "links": snap.links,
                "rendered": true,
                "harnessLive": true,
            })
            .to_string(),
            None => match browse_fetch_while_running(target, running) {
                Some(Ok(page)) => {
                    let mut v =
                        serde_json::to_value(&page).unwrap_or_else(|_| serde_json::json!({}));
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert("rendered".into(), serde_json::Value::Bool(false));
                        obj.insert(
                            "harnessLive".into(),
                            serde_json::Value::Bool(crate::harness::webview_exists(app)),
                        );
                    }
                    v.to_string()
                }
                Some(Err(e)) => {
                    let _ = req.respond(Response::from_string(e).with_status_code(502));
                    return;
                }
                None => {
                    let _ =
                        req.respond(Response::from_string("server stopping").with_status_code(503));
                    return;
                }
            },
        };
        json_response(req, json);
        return;
    }
    // Pi's `browse_read` tool: what is the harness showing RIGHT NOW — the
    // agent's way to look at the page again (or at whatever the user
    // navigated to by hand) without re-navigating.
    if url == "/browse/current" && method == Method::Get {
        crate::harness::request_report(app);
        let json = match crate::harness::current_snapshot() {
            Some((snap, age_ms)) => serde_json::json!({
                "harnessLive": crate::harness::webview_exists(app),
                "ageMs": age_ms,
                "snapshot": snap,
            })
            .to_string(),
            None => serde_json::json!({
                "harnessLive": crate::harness::webview_exists(app),
                "ageMs": null,
                "snapshot": null,
            })
            .to_string(),
        };
        json_response(req, json);
        return;
    }
    // Deep Research bridge: the mesa-deep-research extension POSTs
    // The frontend owns validation. A correlated finish waits for its decision
    // so the model sees rejection as its tool result, not terminal keystrokes.
    if url == "/deep-research" && method == Method::Post {
        let mut body = String::new();
        if req
            .as_reader()
            .take(1_048_577)
            .read_to_string(&mut body)
            .is_err()
        {
            let _ = req.respond(Response::from_string("read error").with_status_code(400));
            return;
        }
        if body.len() > 1_048_576 {
            let _ = req
                .respond(Response::from_string("research payload too large").with_status_code(413));
            return;
        }
        let parsed = match serde_json::from_str::<serde_json::Value>(&body) {
            Ok(value) => value,
            Err(_) => {
                let _ = req.respond(
                    Response::from_string("invalid research payload").with_status_code(400),
                );
                return;
            }
        };
        let wait = if parsed["kind"] == "finish" {
            // Older bundled extensions have no requestId and still receive
            // delivery-only acknowledgement; never label that as acceptance.
            match (parsed["runId"].as_str(), parsed["requestId"].as_str()) {
                (Some(run_id), Some(request_id)) => {
                    match research_replies().begin(run_id.into(), request_id.into()) {
                        Ok(wait) => Some(wait),
                        Err(error) => {
                            let _ = req.respond(Response::from_string(error).with_status_code(409));
                            return;
                        }
                    }
                }
                _ => None,
            }
        } else {
            None
        };
        if let Err(error) = app.emit("mesa://deep-research", body) {
            let _ = req.respond(Response::from_string(error.to_string()).with_status_code(503));
            return;
        }
        if let Some(wait) = wait {
            match wait.wait(running, Duration::from_secs(30)) {
                Ok(reply) => json_response(req, serde_json::to_string(&reply).unwrap_or_default()),
                Err(error) => {
                    let _ = req.respond(Response::from_string(error).with_status_code(504));
                }
            }
        } else {
            let _ = req.respond(Response::from_string("ok"));
        }
        return;
    }
    let _ = req.respond(Response::from_string("not found").with_status_code(404));
}

/// Where the harness reporter should POST rendered-DOM snapshots: the running
/// activity server's loopback port + per-run token. `None` until
/// `activity_start` has run (harness.rs refuses to create the webview then —
/// a reporter with nowhere to report would blind the agent).
pub fn harness_report_target() -> Option<(u16, String)> {
    let guard = state().lock().ok()?;
    guard.as_ref().map(|s| (s.info.port, s.info.token.clone()))
}

/// Start (or reuse) the loopback activity server and materialize the Pi
/// extension. Idempotent: repeated calls return the same running server's
/// port/token/extension path, so surface switches and context restarts never
/// spawn duplicate servers.
#[tauri::command]
pub fn activity_start(app: tauri::AppHandle) -> Result<ActivityInfo, String> {
    let mut guard = state().lock().map_err(|e| e.to_string())?;
    if let Some(existing) = guard.as_ref() {
        return Ok(existing.info.clone());
    }

    let token = make_token();
    let (
        extension_path,
        goal_extension_path,
        context_extension_path,
        browser_extension_path,
        deep_research_extension_path,
    ) = write_extensions()?;

    let mut bound: Option<(Server, u16)> = None;
    for port in PORT_FIRST..=PORT_LAST {
        if let Ok(server) = Server::http(format!("127.0.0.1:{}", port)) {
            bound = Some((server, port));
            break;
        }
    }
    let (server, port) =
        bound.ok_or_else(|| "no free loopback port for the activity server".to_string())?;
    let server = Arc::new(server);

    let running = Arc::new(AtomicBool::new(true));
    let browse_active = Arc::new(AtomicBool::new(false));
    let mut handles = Vec::with_capacity(ACTIVITY_SERVER_WORKERS);
    for _ in 0..ACTIVITY_SERVER_WORKERS {
        let server = server.clone();
        let running = running.clone();
        let browse_active = browse_active.clone();
        let token = token.clone();
        let app = app.clone();
        handles.push(std::thread::spawn(move || {
            while running.load(Ordering::Acquire) {
                match server.recv_timeout(Duration::from_millis(250)) {
                    Ok(Some(req)) => handle_request(req, &token, &app, &running, &browse_active),
                    Ok(None) => {}
                    Err(_) => break,
                }
            }
        }));
    }

    let info = ActivityInfo {
        port,
        token,
        extension_path,
        goal_extension_path,
        context_extension_path,
        browser_extension_path,
        deep_research_extension_path,
    };
    *guard = Some(ActivityServer {
        running,
        handles,
        info: info.clone(),
    });
    Ok(info)
}

/// Publish the main workspace's current path-only Pi context. This state is
/// independent of the loopback server lifecycle, so the main renderer can
/// update it before Pi starts and the first agent turn still sees it.
#[tauri::command]
pub fn activity_set_context(context: String) -> Result<(), String> {
    let mut current = context_state().lock().map_err(|e| e.to_string())?;
    *current = bounded_context(context);
    Ok(())
}

#[tauri::command]
pub fn activity_stop() -> Result<(), String> {
    let mut guard = state().lock().map_err(|e| e.to_string())?;
    let stopped = guard.take();
    if let Some(st) = stopped.as_ref() {
        st.running.store(false, Ordering::Release);
    }
    // A request may be finishing in another worker and call back into
    // `harness_report_target`, which also needs `state()`. Never hold this
    // lock while waiting for worker threads to exit.
    drop(guard);
    if let Some(st) = stopped {
        for h in st.handles {
            let _ = h.join();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn research_decisions_are_correlated_and_single_admission() {
        let replies = ResearchReplies::default();
        let wait = replies.begin("run".into(), "call".into()).unwrap();
        assert!(replies.begin("other".into(), "call".into()).is_err());
        let reply = ResearchReply {
            status: ResearchDecision::Rejected,
            message: "missing Findings".into(),
        };
        assert!(replies.respond("old-run", "call", reply.clone()).is_err());
        assert!(replies.respond("run", "old-call", reply.clone()).is_err());
        replies.respond("run", "call", reply.clone()).unwrap();
        assert!(replies.respond("run", "call", reply).is_err());
        let result = wait
            .wait(&AtomicBool::new(true), Duration::from_millis(100))
            .unwrap();
        assert_eq!(serde_json::to_value(result).unwrap()["status"], "rejected");
        assert!(replies
            .respond(
                "run",
                "call",
                ResearchReply {
                    status: ResearchDecision::Accepted,
                    message: "late duplicate".into(),
                }
            )
            .is_err());
        drop(wait);
        assert!(replies.begin("next".into(), "next-call".into()).is_ok());
    }

    #[test]
    fn research_wait_shutdown_and_timeout_release_the_slot() {
        let replies = ResearchReplies::default();
        let wait = replies.begin("run".into(), "call".into()).unwrap();
        assert!(wait
            .wait(&AtomicBool::new(false), Duration::from_secs(30))
            .is_err());
        drop(wait);
        let wait = replies.begin("next".into(), "next-call".into()).unwrap();
        assert!(wait.wait(&AtomicBool::new(true), Duration::ZERO).is_err());
        drop(wait);
        let reply = ResearchReply {
            status: ResearchDecision::Accepted,
            message: "ready".into(),
        };
        assert!(replies.respond("next", "next-call", reply).is_err());
        assert!(replies.begin("last".into(), "last-call".into()).is_ok());
    }

    #[test]
    fn live_context_is_trimmed_and_bounded_on_utf8_boundaries() {
        assert_eq!(bounded_context("  active.md  ".into()), "active.md");
        let oversized = "é".repeat(CONTEXT_MAX_BYTES);
        let bounded = bounded_context(oversized);
        assert!(bounded.len() <= CONTEXT_MAX_BYTES);
        assert!(bounded.is_char_boundary(bounded.len()));
        assert!(bounded.ends_with('é'));
    }

    #[test]
    fn browse_admission_is_single_and_reusable() {
        let active = AtomicBool::new(false);
        let first = BrowsePermit::try_acquire(&active).expect("first browse must be admitted");
        assert!(BrowsePermit::try_acquire(&active).is_none());
        drop(first);
        assert!(BrowsePermit::try_acquire(&active).is_some());
    }

    #[test]
    fn pending_fallback_stops_with_the_server() {
        let running = Arc::new(AtomicBool::new(true));
        let stop = running.clone();
        let (started_tx, started_rx) = std::sync::mpsc::sync_channel(0);
        let stopper = std::thread::spawn(move || {
            started_rx.recv().unwrap();
            stop.store(false, Ordering::Release);
        });
        let result = blocking_while_running(&running, "test-pending-fallback", move || {
            started_tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(250));
            "late result"
        });
        stopper.join().unwrap();
        assert_eq!(result.unwrap(), None);
    }
}
