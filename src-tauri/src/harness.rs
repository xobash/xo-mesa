// Native browser-harness webview for the Pi agent and the user.
//
// The old harness rendered pages in an <iframe> inside Mesa's own webview.
// Sites that forbid framing (google.com, youtube.com, most login pages) fell
// back to a scriptless srcdoc "reader mode" — for modern JS-shell sites that
// renders a gray skeleton or a no-JS variant that looks like a counterfeit
// page, and the Pi agent could only read a server-side fetch of HTML that the
// user was not actually seeing.
//
// This module hosts the page surface in a REAL native child webview (Tauri
// multiwebview, `unstable` cargo feature) positioned over the wing's page
// area by the frontend (`BrowserHarness.tsx` syncs bounds every frame):
//   - the user sees the real rendered site — JS, sessions, sign-ins, all of it;
//   - an injected reporter (resources/harness-reporter.js) streams the
//     *rendered* DOM text/title/links back to Mesa;
//   - the Pi `browse` tool answers with that rendered snapshot, so the agent
//     reads exactly what the user's harness displays. The frontend falls back
//     to the legacy iframe two-tier path if webview creation fails at runtime.
//
// Snapshot ingest has two doors (see harness-reporter.js for why):
//   - POST /harness on the loopback activity server (activity.rs routes here);
//   - `mesa-snap://snap/#<payload>` navigations intercepted by on_navigation.
// Both verify the per-run bearer token that Rust bakes into the reporter.
//
// Boundary notes:
//   - The webview label (`pi-harness`) matches NO capability window pattern,
//     so remote pages get zero Tauri permissions; the reporter needs none.
//   - on_navigation confines the webview to http(s)/about/blob/data.
//   - Snapshots live in memory only and are capped; nothing touches disk.

use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::webview::WebviewBuilder;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager};

pub const HARNESS_LABEL: &str = "pi-harness";
const REPORTER_SRC: &str = include_str!("../resources/harness-reporter.js");
/// Rendered-text cap stored per snapshot (the reporter clips at 60k already;
/// this is a server-side backstop against a hand-rolled payload).
const SNAPSHOT_TEXT_CAP: usize = 120_000;
const SNAPSHOT_LINK_CAP: usize = 100;

#[derive(Clone, Serialize)]
pub struct HarnessSnapshot {
    pub url: String,
    pub title: String,
    pub text: String,
    pub links: Vec<String>,
    pub ready: String,
    #[serde(skip)]
    pub at: Instant,
    /// Navigation generation this snapshot arrived under (see `bump_nav_gen`).
    #[serde(skip)]
    pub nav_gen: u64,
}

struct HarnessState {
    snapshot: Option<HarnessSnapshot>,
    nav_gen: u64,
    last_emitted_url: String,
}

fn state() -> &'static (Mutex<HarnessState>, Condvar) {
    static S: OnceLock<(Mutex<HarnessState>, Condvar)> = OnceLock::new();
    S.get_or_init(|| {
        (
            Mutex::new(HarnessState {
                snapshot: None,
                nav_gen: 0,
                last_emitted_url: String::new(),
            }),
            Condvar::new(),
        )
    })
}

/// Percent-decode a URL component (the `mesa-snap:` fragment payload).
/// std-only on purpose — no new crates for a fallback path.
pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(hex) = bytes.get(i + 1..i + 3) {
                if let Ok(h) = std::str::from_utf8(hex) {
                    if let Ok(b) = u8::from_str_radix(h, 16) {
                        out.push(b);
                        i += 3;
                        continue;
                    }
                }
            }
            out.push(bytes[i]);
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse a reporter payload (JSON body from either transport), verify the
/// token, and return the snapshot. Pure so it can be unit-tested.
pub fn parse_snapshot_body(
    body: &str,
    expected_token: &str,
    nav_gen: u64,
) -> Result<HarnessSnapshot, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("bad snapshot json: {e}"))?;
    let token = v.get("token").and_then(|t| t.as_str()).unwrap_or("");
    if token.is_empty() || token != expected_token {
        return Err("snapshot token mismatch".to_string());
    }
    let mut text = v
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    if text.len() > SNAPSHOT_TEXT_CAP {
        let mut cut = SNAPSHOT_TEXT_CAP;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }
    let links = v
        .get("links")
        .and_then(|l| l.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .take(SNAPSHOT_LINK_CAP)
                .map(|s| s.chars().take(600).collect::<String>())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    Ok(HarnessSnapshot {
        url: v
            .get("url")
            .and_then(|u| u.as_str())
            .unwrap_or("")
            .chars()
            .take(2000)
            .collect(),
        title: v
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .chars()
            .take(300)
            .collect(),
        text,
        links,
        ready: v
            .get("ready")
            .and_then(|r| r.as_str())
            .unwrap_or("")
            .to_string(),
        at: Instant::now(),
        nav_gen,
    })
}

/// Extract the payload JSON from a `mesa-snap://snap/#<encoded>` URL.
pub fn snapshot_payload_from_scheme_url(url: &tauri::Url) -> Option<String> {
    if url.scheme() != "mesa-snap" {
        return None;
    }
    url.fragment().map(percent_decode)
}

/// Ingest a snapshot body from either transport. Stores it, wakes `/browse`
/// waiters, and mirrors observed navigations (including SPA pushState moves)
/// to the frontend address bar via `mesa://harness-nav`.
pub fn ingest_snapshot_body(app: &tauri::AppHandle, body: &str, expected_token: &str) -> Result<(), String> {
    let (lock, cvar) = state();
    let mut emit_url: Option<(String, String)> = None;
    {
        let mut st = lock.lock().map_err(|e| e.to_string())?;
        let snap = parse_snapshot_body(body, expected_token, st.nav_gen)?;
        if !snap.url.is_empty() && snap.url != st.last_emitted_url {
            st.last_emitted_url = snap.url.clone();
            emit_url = Some((snap.url.clone(), snap.title.clone()));
        }
        st.snapshot = Some(snap);
    }
    cvar.notify_all();
    if let Some((url, title)) = emit_url {
        let _ = app.emit(
            "mesa://harness-nav",
            serde_json::json!({ "url": url, "title": title }),
        );
    }
    Ok(())
}

/// Mark the start of an agent-driven navigation. Snapshots ingested after this
/// carry the new generation; `wait_for_snapshot` keys on it so `/browse` never
/// answers with the page that was open before the agent navigated.
pub fn bump_nav_gen() -> u64 {
    let (lock, _) = state();
    let mut st = lock.lock().unwrap_or_else(|p| p.into_inner());
    st.nav_gen += 1;
    st.nav_gen
}

/// Block (activity-server thread) until a snapshot for `gen` arrives, then
/// give fast-mutating pages a short settle window for a fresher one.
///
/// Guard against the pre-navigation page's last debounced tick slipping in
/// right after the generation bump: a snapshot only counts if its URL matches
/// the requested target (redirect-free case) or it arrived at/after `min_at`
/// (bump time + a beat — by then the webview has left the old page).
pub fn wait_for_snapshot(
    gen: u64,
    expect_url: &str,
    min_at: Instant,
    timeout: Duration,
) -> Option<HarnessSnapshot> {
    let (lock, cvar) = state();
    let deadline = Instant::now() + timeout;
    let mut st = lock.lock().unwrap_or_else(|p| p.into_inner());
    loop {
        let hit = st
            .snapshot
            .as_ref()
            .map(|s| {
                s.nav_gen >= gen
                    && (s.url == expect_url || s.at >= min_at)
                    && (s.ready != "loading" || !s.text.trim().is_empty())
            })
            .unwrap_or(false);
        if hit {
            // Settle: prefer a fresher snapshot if one lands quickly.
            let settle_until = Instant::now() + Duration::from_millis(700);
            let base_at = st.snapshot.as_ref().map(|s| s.at);
            while Instant::now() < settle_until {
                let wait = settle_until.saturating_duration_since(Instant::now());
                let (next, res) = match cvar.wait_timeout(st, wait) {
                    Ok(v) => v,
                    Err(p) => {
                        st = p.into_inner().0;
                        break;
                    }
                };
                st = next;
                let fresher = st.snapshot.as_ref().map(|s| s.at) != base_at;
                if res.timed_out() || fresher {
                    break;
                }
            }
            return st.snapshot.clone();
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        let (next, _) = match cvar.wait_timeout(st, deadline - now) {
            Ok(v) => v,
            Err(p) => p.into_inner(),
        };
        st = next;
    }
}

/// Latest snapshot regardless of generation (the `browse_read` tool), plus its
/// age in milliseconds.
pub fn current_snapshot() -> Option<(HarnessSnapshot, u128)> {
    let (lock, _) = state();
    let st = lock.lock().unwrap_or_else(|p| p.into_inner());
    st.snapshot
        .as_ref()
        .map(|s| (s.clone(), s.at.elapsed().as_millis()))
}

pub fn webview_exists(app: &tauri::AppHandle) -> bool {
    app.get_webview(HARNESS_LABEL).is_some()
}

/// Child webviews are positioned relative to the window FRAME (on macOS wry
/// flips Y over the full frame, titlebar included), while the CSS-pixel rects
/// the frontend measures are relative to the DOM viewport, which starts below
/// the titlebar. The exact delta between those two origins is simply
/// `frame height − DOM viewport height`, so the frontend sends its
/// `window.innerHeight` with every placement call and we shift down by the
/// difference.
///
/// Why not tao window metrics: desktop QA (2026-07-02, macOS) showed tao
/// reporting inner_size == outer_size == frame (1440×821) and
/// inner_position == outer_position, so "outer − inner" computed 0 while the
/// real offset was ~30 (that macOS version's titlebar). This formula needs no
/// per-OS knowledge: it self-adapts to any titlebar/toolbar height, collapses
/// to 0 in fullscreen (titlebar hides, viewport == frame), and is 0 on
/// Windows/Linux where children are client-area-relative and inner_size IS
/// the viewport.
fn content_y_offset(window: &tauri::Window, viewport_h: f64) -> f64 {
    if viewport_h <= 0.0 {
        return 0.0;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let frame_h = window
        .inner_size()
        .map(|s| s.height as f64 / scale)
        .unwrap_or(viewport_h);
    (frame_h - viewport_h).clamp(0.0, 200.0)
}

/// Runtime placement nudge (logical px), applied on top of `content_y_offset`
/// at every placement site. Driven by the harness calibration row in the
/// frontend so a misplaced webview can be aligned visually on a LIVE build;
/// the winning value is then baked into `content_y_offset` and this returns
/// to (0, 0). Per-run, in-memory only.
fn nudge() -> &'static Mutex<(f64, f64)> {
    static N: OnceLock<Mutex<(f64, f64)>> = OnceLock::new();
    N.get_or_init(|| Mutex::new((0.0, 0.0)))
}

/// Last `window.innerHeight` the frontend reported with a placement call.
/// `content_y_offset` needs this every time it runs (including from
/// `harness_status`, which the frontend polls with no rect of its own), so
/// it is cached here instead of threaded through every call site. Starts at
/// 0 (no compensation) until the first real placement call arrives.
fn last_viewport_h() -> &'static Mutex<f64> {
    static V: OnceLock<Mutex<f64>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(0.0))
}

/// Record a freshly reported `window.innerHeight` (ignores non-positive
/// values so a stale/zero read never clobbers a good one).
fn record_viewport_h(viewport_h: f64) {
    if viewport_h > 0.0 {
        *last_viewport_h().lock().unwrap_or_else(|p| p.into_inner()) = viewport_h;
    }
}

fn effective_offset(window: &tauri::Window) -> (f64, f64) {
    let n = *nudge().lock().unwrap_or_else(|p| p.into_inner());
    let viewport_h = *last_viewport_h().lock().unwrap_or_else(|p| p.into_inner());
    (n.0, n.1 + content_y_offset(window, viewport_h))
}

/// Adjust the runtime nudge (calibration row). Returns the new nudge totals.
#[tauri::command]
pub fn harness_nudge(dx: f64, dy: f64, reset: bool) -> Result<(f64, f64), String> {
    let mut n = nudge().lock().unwrap_or_else(|p| p.into_inner());
    if reset {
        *n = (0.0, 0.0);
    } else {
        n.0 += dx;
        n.1 += dy;
    }
    Ok(*n)
}

fn reporter_script() -> Result<String, String> {
    let (port, token) =
        crate::activity::harness_report_target().ok_or("activity server not running")?;
    Ok(REPORTER_SRC
        .replace("__MESA_PORT__", &port.to_string())
        .replace("__MESA_TOKEN__", &token))
}

fn create_webview(
    window: &tauri::Window,
    app: &tauri::AppHandle,
    url: tauri::Url,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let script = reporter_script()?;
    let ingest_app = app.clone();
    let token = crate::activity::harness_report_target()
        .map(|(_, t)| t)
        .unwrap_or_default();
    let builder = WebviewBuilder::new(HARNESS_LABEL, tauri::WebviewUrl::External(url))
        .initialization_script(script.as_str())
        .on_navigation(move |nav_url| {
            if nav_url.scheme() == "mesa-snap" {
                if let Some(body) = snapshot_payload_from_scheme_url(nav_url) {
                    let _ = ingest_snapshot_body(&ingest_app, &body, &token);
                }
                return false; // never actually navigate the bridge scheme
            }
            matches!(nav_url.scheme(), "http" | "https" | "about" | "blob" | "data")
        });
    let (dx, dy) = effective_offset(window);
    window
        .add_child(
            builder,
            LogicalPosition::new(x + dx, y + dy),
            LogicalSize::new(w, h),
        )
        .map_err(|e| format!("harness webview create failed: {e}"))?;
    Ok(())
}

/// Navigate the harness webview, creating it (as a child of the calling
/// window) or re-parenting it (close + recreate) as needed. Bounds are the
/// wing's page-area rect in CSS pixels, supplied by the frontend, along with
/// `window.innerHeight` (`viewport_h`) so the placement offset can be
/// computed as frame height minus DOM viewport height.
#[tauri::command]
pub fn harness_navigate(
    window: tauri::Window,
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    viewport_h: f64,
) -> Result<(), String> {
    record_viewport_h(viewport_h);
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported scheme: {}", parsed.scheme()));
    }
    if let Some(existing) = app.get_webview(HARNESS_LABEL) {
        if existing.window().label() == window.label() {
            let (dx, dy) = effective_offset(&window);
            let _ = existing.set_position(LogicalPosition::new(x + dx, y + dy));
            let _ = existing.set_size(LogicalSize::new(w, h));
            let _ = existing.show();
            let mut wv = existing;
            return wv.navigate(parsed).map_err(|e| e.to_string());
        }
        // The wing moved to another Mesa window (e.g. popped-out Pi):
        // child webviews cannot re-parent, so recreate there.
        existing.close().map_err(|e| e.to_string())?;
    }
    create_webview(&window, &app, parsed, x, y, w, h)
}

/// Follow the wing's on-screen rect (called by the frontend's rAF sync loop
/// whenever the measured rect changes). Also carries the frontend's current
/// `window.innerHeight` so the placement offset stays correct if the DOM
/// viewport height itself changes (e.g. the OS toggles fullscreen).
#[tauri::command]
pub fn harness_bounds(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    viewport_h: f64,
) -> Result<(), String> {
    record_viewport_h(viewport_h);
    if let Some(wv) = app.get_webview(HARNESS_LABEL) {
        let (dx, dy) = effective_offset(&wv.window());
        wv.set_position(LogicalPosition::new(x + dx, y + dy))
            .map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(w, h))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Hide when the wing closes/unmounts; show when it reopens. The webview (and
/// the page in it) survives hidden, so reopening the wing restores the page.
#[tauri::command]
pub fn harness_visibility(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    if let Some(wv) = app.get_webview(HARNESS_LABEL) {
        if visible {
            wv.show().map_err(|e| e.to_string())?;
        } else {
            wv.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Native history controls ("back" | "forward" | "reload"). History lives in
/// the real webview, so these are eval'd rather than tracked in the frontend.
#[tauri::command]
pub fn harness_history(app: tauri::AppHandle, direction: String) -> Result<(), String> {
    let wv = app
        .get_webview(HARNESS_LABEL)
        .ok_or("harness webview not open")?;
    let js = match direction.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        other => return Err(format!("unknown history direction: {other}")),
    };
    wv.eval(js).map_err(|e| e.to_string())
}

/// Placement diagnostics for the calibration row (all values logical px).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessDiag {
    /// Webview bounds as the native side reads them back (x, y, w, h).
    pub bounds: Option<[f64; 4]>,
    /// Effective placement offset in use: nudge + titlebar compensation.
    pub offset: [f64; 2],
    /// The `content_y_offset` component alone.
    pub titlebar_comp: f64,
    /// Last `window.innerHeight` the frontend reported (the other half of
    /// the `frame_h - viewport_h` calibration formula; 0 before any
    /// placement call has landed).
    pub viewport_h: f64,
    pub scale: f64,
    pub inner_size: [f64; 2],
    pub outer_size: [f64; 2],
    pub inner_pos: [f64; 2],
    pub outer_pos: [f64; 2],
}

#[derive(Serialize)]
pub struct HarnessStatus {
    pub exists: bool,
    pub url: Option<String>,
    pub title: Option<String>,
    pub diag: Option<HarnessDiag>,
}

/// Frontend mount probe: lets a re-opened wing restore the address bar and
/// re-adopt a live webview instead of resetting to the start page. Also
/// carries placement diagnostics for the calibration row.
#[tauri::command]
pub fn harness_status(app: tauri::AppHandle) -> Result<HarnessStatus, String> {
    let wv = app.get_webview(HARNESS_LABEL);
    let snap = current_snapshot();
    let diag = wv.as_ref().map(|wv| {
        let window = wv.window();
        let scale = window.scale_factor().unwrap_or(1.0);
        let logical = |v: f64| v / scale;
        let bounds = match (wv.position(), wv.size()) {
            (Ok(pos), Ok(size)) => Some([
                logical(pos.x as f64),
                logical(pos.y as f64),
                logical(size.width as f64),
                logical(size.height as f64),
            ]),
            _ => None,
        };
        let pair_size = |s: Result<tauri::PhysicalSize<u32>, tauri::Error>| {
            s.map(|s| [logical(s.width as f64), logical(s.height as f64)])
                .unwrap_or([0.0, 0.0])
        };
        let pair_pos = |p: Result<tauri::PhysicalPosition<i32>, tauri::Error>| {
            p.map(|p| [logical(p.x as f64), logical(p.y as f64)])
                .unwrap_or([0.0, 0.0])
        };
        let (dx, dy) = effective_offset(&window);
        let viewport_h = *last_viewport_h().lock().unwrap_or_else(|p| p.into_inner());
        HarnessDiag {
            bounds,
            offset: [dx, dy],
            titlebar_comp: content_y_offset(&window, viewport_h),
            viewport_h,
            scale,
            inner_size: pair_size(window.inner_size()),
            outer_size: pair_size(window.outer_size()),
            inner_pos: pair_pos(window.inner_position()),
            outer_pos: pair_pos(window.outer_position()),
        }
    });
    Ok(HarnessStatus {
        exists: wv.is_some(),
        url: snap.as_ref().map(|(s, _)| s.url.clone()),
        title: snap.map(|(s, _)| s.title),
        diag,
    })
}

/// Ask the live page for a fresh snapshot (used by `/browse` right after
/// navigation settles and by `/browse/current` refresh).
pub fn request_report(app: &tauri::AppHandle) {
    if let Some(wv) = app.get_webview(HARNESS_LABEL) {
        let _ = wv.eval("window.__mesaHarnessReport && window.__mesaHarnessReport()");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_roundtrips_json() {
        let payload = r#"{"token":"t","text":"a b\nc","url":"https://x.y/?q=1&r=2"}"#;
        // encodeURIComponent-style encoding of the payload
        let encoded = "%7B%22token%22%3A%22t%22%2C%22text%22%3A%22a%20b%5Cnc%22%2C%22url%22%3A%22https%3A%2F%2Fx.y%2F%3Fq%3D1%26r%3D2%22%7D";
        assert_eq!(percent_decode(encoded), payload);
    }

    #[test]
    fn percent_decode_is_liberal_on_junk() {
        assert_eq!(percent_decode("a%zzb%"), "a%zzb%");
        assert_eq!(percent_decode(""), "");
    }

    #[test]
    fn parse_snapshot_rejects_bad_token() {
        let body = r#"{"token":"wrong","url":"https://a.b","text":"hi"}"#;
        assert!(parse_snapshot_body(body, "right", 1).is_err());
        let body = r#"{"url":"https://a.b","text":"hi"}"#;
        assert!(parse_snapshot_body(body, "right", 1).is_err());
    }

    #[test]
    fn parse_snapshot_accepts_and_caps() {
        let long = "x".repeat(SNAPSHOT_TEXT_CAP + 50);
        let body = serde_json::json!({
            "token": "t",
            "url": "https://example.com/page",
            "title": "Example",
            "ready": "complete",
            "text": long,
            "links": ["Home :: https://example.com"],
        })
        .to_string();
        let snap = parse_snapshot_body(&body, "t", 7).expect("parses");
        assert_eq!(snap.url, "https://example.com/page");
        assert_eq!(snap.nav_gen, 7);
        assert_eq!(snap.text.len(), SNAPSHOT_TEXT_CAP);
        assert_eq!(snap.links.len(), 1);
    }

    #[test]
    fn scheme_payload_extraction() {
        let url = tauri::Url::parse("mesa-snap://snap/#%7B%22a%22%3A1%7D").unwrap();
        assert_eq!(
            snapshot_payload_from_scheme_url(&url).as_deref(),
            Some(r#"{"a":1}"#)
        );
        let http = tauri::Url::parse("https://example.com/#x").unwrap();
        assert!(snapshot_payload_from_scheme_url(&http).is_none());
    }
}
