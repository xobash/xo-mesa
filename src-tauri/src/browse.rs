// Native page fetcher for the Pi browser harness.
//
// The harness renders pages in an iframe inside the webview. Many sites
// (google.com, github.com, most login pages) forbid being framed via
// `X-Frame-Options` / CSP `frame-ancestors`, which the webview enforces — the
// frame silently stays a white rectangle. The webview's own `fetch()` cannot
// even *inspect* those pages (CORS), so the frontend has no way to know why.
//
// This command fetches the page natively with the reqwest client already in
// the tree for device sync (no CORS applies here), reports whether the site's
// headers allow framing, and hands back the HTML body. Frame-blocked pages are
// then rendered by the harness in a sandboxed srcdoc "reader mode" instead of
// a white pane; frameable pages keep the full-fidelity direct iframe.
//
// Boundary notes:
//   - http/https only; invoked only by the local user driving the harness UI.
//   - Body capped at 4 MB and only text-ish content types are returned;
//     binary responses come back with `body: None` (the frontend direct-embeds
//     those).
//   - Charset is decoded lossily as UTF-8; reader mode is a research surface,
//     not a spec-complete browser.

use serde::Serialize;
use std::sync::OnceLock;

const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// One shared client for every harness/agent page fetch, with an in-memory
/// cookie jar (`cookie_store(true)`, reqwest's built-in feature — no extra
/// crates). Sessions established through the harness (e.g. a sign-in that
/// round-trips through reader mode) persist for the rest of the app run and
/// are shared with the Pi agent's `browse` tool, since both go through this
/// client. The jar is memory-only: it is dropped when Mesa quits, and it is
/// fully isolated from the user's default browser AND from the webview's own
/// cookie storage.
fn shared_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // A modest, honest UA. Sites that sniff UAs serve their simple-HTML
            // variant, which is exactly what reader mode renders best.
            .user_agent("Mozilla/5.0 (compatible; MesaBrowser/0.1)")
            .cookie_store(true)
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

#[derive(Serialize)]
pub struct BrowsePage {
    #[serde(rename = "finalUrl")]
    pub final_url: String,
    pub status: u16,
    #[serde(rename = "contentType")]
    pub content_type: String,
    /// True when response headers forbid rendering this page in our iframe.
    #[serde(rename = "frameBlocked")]
    pub frame_blocked: bool,
    pub body: Option<String>,
}

/// Would the webview refuse to render this response inside our iframe?
/// We are a cross-origin ancestor (tauri://localhost), so any `sameorigin` /
/// `deny` XFO or any CSP `frame-ancestors` that isn't a plain wildcard blocks.
fn frame_blocked(headers: &reqwest::header::HeaderMap) -> bool {
    if let Some(xfo) = headers
        .get("x-frame-options")
        .and_then(|v| v.to_str().ok())
    {
        let v = xfo.trim().to_ascii_lowercase();
        if v.contains("deny") || v.contains("sameorigin") || v.contains("allow-from") {
            return true;
        }
    }
    if let Some(csp) = headers
        .get("content-security-policy")
        .and_then(|v| v.to_str().ok())
    {
        for directive in csp.split(';') {
            if let Some(rest) = directive.trim().strip_prefix("frame-ancestors") {
                if !rest.split_whitespace().any(|s| s == "*") {
                    return true;
                }
            }
        }
    }
    false
}

fn is_texty(content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    ct.is_empty()
        || ct.starts_with("text/")
        || ct.contains("html")
        || ct.contains("xml")
        || ct.contains("json")
}

#[tauri::command]
pub async fn browse_fetch(url: String) -> Result<BrowsePage, String> {
    fetch_inner(url).await
}

/// Synchronous wrapper for non-async callers (the loopback activity server
/// thread serving the Pi agent's `browse` tool).
pub fn browse_fetch_blocking(url: String) -> Result<BrowsePage, String> {
    tauri::async_runtime::block_on(fetch_inner(url))
}

async fn fetch_inner(url: String) -> Result<BrowsePage, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("unsupported scheme: {other}")),
    }

    let mut resp = shared_client()
        .get(parsed)
        .header("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let blocked = frame_blocked(resp.headers());

    let body = if is_texty(&content_type) {
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
            let room = MAX_BODY_BYTES.saturating_sub(buf.len());
            if room == 0 {
                break;
            }
            let take = room.min(chunk.len());
            buf.extend_from_slice(&chunk[..take]);
        }
        Some(String::from_utf8_lossy(&buf).into_owned())
    } else {
        None
    };

    Ok(BrowsePage {
        final_url,
        status,
        content_type,
        frame_blocked: blocked,
        body,
    })
}
