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

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::Emitter;
use tiny_http::{Method, Request, Response, Server};

/// The Pi extension sources, compiled into the binary and written to temp files
/// at startup so Mesa can hand Pi real paths via (repeatable) `--extension`.
/// Bundling them with `include_str!` means the shipped extensions are exactly
/// what was code-reviewed in this repo — nothing is fetched from npm or the
/// network at runtime.
const EXTENSION_SRC: &str = include_str!("../resources/mesa-activity.ts");
const GOAL_EXTENSION_SRC: &str = include_str!("../resources/mesa-goal.ts");
const BROWSER_EXTENSION_SRC: &str = include_str!("../resources/mesa-browser.ts");

/// Loopback ports to try, in order (inclusive). The first free one wins.
const PORT_FIRST: u16 = 8788;
const PORT_LAST: u16 = 8820;

#[derive(Clone, Serialize)]
pub struct ActivityInfo {
    pub port: u16,
    pub token: String,
    #[serde(rename = "extensionPath")]
    pub extension_path: String,
    #[serde(rename = "goalExtensionPath")]
    pub goal_extension_path: String,
    #[serde(rename = "browserExtensionPath")]
    pub browser_extension_path: String,
}

struct ActivityServer {
    running: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    info: ActivityInfo,
}

fn state() -> &'static Mutex<Option<ActivityServer>> {
    static S: OnceLock<Mutex<Option<ActivityServer>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
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
/// (activity_path, goal_path, browser_path).
fn write_extensions() -> Result<(String, String, String), String> {
    let dir = std::env::temp_dir().join("mesa-pi");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let activity = dir.join("mesa-activity.ts");
    std::fs::write(&activity, EXTENSION_SRC).map_err(|e| e.to_string())?;
    let goal = dir.join("mesa-goal.ts");
    std::fs::write(&goal, GOAL_EXTENSION_SRC).map_err(|e| e.to_string())?;
    let browser = dir.join("mesa-browser.ts");
    std::fs::write(&browser, BROWSER_EXTENSION_SRC).map_err(|e| e.to_string())?;
    Ok((
        activity.to_string_lossy().to_string(),
        goal.to_string_lossy().to_string(),
        browser.to_string_lossy().to_string(),
    ))
}

fn auth_ok(req: &Request, token: &str) -> bool {
    let expected = format!("Bearer {}", token);
    req.headers()
        .iter()
        .any(|h| h.field.equiv("Authorization") && h.value.as_str() == expected)
}

fn handle_request(mut req: Request, token: &str, app: &tauri::AppHandle) {
    if !auth_ok(&req, token) {
        let _ = req.respond(Response::from_string("unauthorized").with_status_code(401));
        return;
    }
    let url = req.url().to_string();
    let method = req.method().clone();
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
    // Pi's `browse` tool: fetch a page on the agent's behalf and mirror the
    // navigation into the visible harness. The fetch goes through the same
    // shared client (and cookie jar) as the user-driven harness, so the user
    // watches exactly what the agent sees.
    if url == "/browse" && method == Method::Post {
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
        // Mirror first: the harness shows the page while the fetch runs.
        let _ = app.emit("mesa://browse", target.clone());
        match crate::browse::browse_fetch_blocking(target) {
            Ok(page) => {
                let json = serde_json::to_string(&page).unwrap_or_else(|_| "{}".to_string());
                let mut resp = Response::from_string(json);
                if let Ok(h) = "Content-Type: application/json".parse::<tiny_http::Header>() {
                    resp = resp.with_header(h);
                }
                let _ = req.respond(resp);
            }
            Err(e) => {
                let _ = req.respond(Response::from_string(e).with_status_code(502));
            }
        }
        return;
    }
    let _ = req.respond(Response::from_string("not found").with_status_code(404));
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
    let (extension_path, goal_extension_path, browser_extension_path) = write_extensions()?;

    let mut bound: Option<(Server, u16)> = None;
    for port in PORT_FIRST..=PORT_LAST {
        if let Ok(server) = Server::http(format!("127.0.0.1:{}", port)) {
            bound = Some((server, port));
            break;
        }
    }
    let (server, port) =
        bound.ok_or_else(|| "no free loopback port for the activity server".to_string())?;

    let running = Arc::new(AtomicBool::new(true));
    let running_thread = running.clone();
    let token_thread = token.clone();
    let app_thread = app.clone();
    let handle = std::thread::spawn(move || {
        while running_thread.load(Ordering::Relaxed) {
            match server.recv_timeout(Duration::from_millis(250)) {
                Ok(Some(req)) => handle_request(req, &token_thread, &app_thread),
                Ok(None) => {}
                Err(_) => break,
            }
        }
    });

    let info = ActivityInfo {
        port,
        token,
        extension_path,
        goal_extension_path,
        browser_extension_path,
    };
    *guard = Some(ActivityServer {
        running,
        handle: Some(handle),
        info: info.clone(),
    });
    Ok(info)
}

#[tauri::command]
pub fn activity_stop() -> Result<(), String> {
    let mut guard = state().lock().map_err(|e| e.to_string())?;
    if let Some(mut st) = guard.take() {
        st.running.store(false, Ordering::Relaxed);
        if let Some(h) = st.handle.take() {
            let _ = h.join();
        }
    }
    Ok(())
}
