use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde::Serialize;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, OnceLock};

const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// One shared client for every harness/agent page fetch, with an in-memory
/// cookie jar (`cookie_store(true)`, reqwest's built-in feature — no extra
/// crates). Sessions established through the harness (e.g. a sign-in that
/// round-trips through reader mode) persist for the rest of the app run and
/// are shared with the Pi agent's `browse` tool, since both go through this
/// client. The jar is memory-only: it is dropped when Mesa quits, and it is
/// fully isolated from the user's default browser AND from the webview's own
/// cookie storage.
fn shared_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                // A modest, honest UA. Sites that sniff UAs serve their simple-HTML
                // variant, which is exactly what reader mode renders best.
                .user_agent("Mozilla/5.0 (compatible; MesaBrowser/0.1)")
                .cookie_store(true)
                // A proxy can resolve a hostname outside this process and bypass
                // the address check. The page fetcher never uses proxy settings.
                .no_proxy()
                .dns_resolver(Arc::new(PublicResolver))
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 10 {
                        return attempt.error("too many redirects");
                    }
                    if public_url(attempt.url()).is_err() {
                        return attempt.error("redirect to a private network is blocked");
                    }
                    attempt.follow()
                }))
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .map_err(|e| format!("browser client setup failed: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && (b == 0 || b == 168 || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(v6) => {
            // Only ordinary global unicast is eligible. Exclude address
            // translation/tunnel ranges that can hide a private IPv4 target.
            let segments = v6.segments();
            (segments[0] & 0xe000) == 0x2000
                && !(segments[0] == 0x2001 && (segments[1] == 0 || segments[1] == 0x0db8))
                && segments[0] != 0x2002
        }
    }
}

fn public_url(url: &reqwest::Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only HTTP and HTTPS pages are allowed".into());
    }
    let host = url.host_str().ok_or("URL has no host")?;
    let host = host.trim_matches(['[', ']']);
    if let Ok(ip) = host.parse::<IpAddr>() {
        return public_ip(ip)
            .then_some(())
            .ok_or_else(|| "private network address is blocked".into());
    }
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost") {
        return Err("local host is blocked".into());
    }
    Ok(())
}

pub(crate) fn check_public_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    public_url(&parsed)
}

pub(crate) async fn check_public_destination(url: &str) -> Result<(), String> {
    check_public_url(url)?;
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    let host = parsed.host_str().ok_or("URL has no host")?;
    if host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let addresses: Vec<SocketAddr> = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::net::lookup_host((host, parsed.port_or_known_default().unwrap_or(80))),
    )
    .await
    .map_err(|_| "DNS check timed out".to_string())?
    .map_err(|e| format!("DNS check failed: {e}"))?
    .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err("private network address is blocked".into());
    }
    Ok(())
}

struct PublicResolver;

impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses: Vec<SocketAddr> =
                tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "private network address is blocked",
                )
                .into());
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
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
    if let Some(xfo) = headers.get("x-frame-options").and_then(|v| v.to_str().ok()) {
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

    public_url(&parsed)?;

    let mut resp = shared_client()?
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_local_and_private_page_addresses() {
        for url in [
            "http://localhost/".to_string(),
            "https://notes.localhost/".to_string(),
            "http://127.0.0.1/".to_string(),
            "http://0177.0.0.1/".to_string(),
            format!("http://{}/", std::net::Ipv4Addr::new(10, 2, 3, 4)),
            "http://169.254.169.254/".to_string(),
            format!("http://{}/", std::net::Ipv4Addr::new(172, 19, 1, 2)),
            format!("http://{}/", std::net::Ipv4Addr::new(192, 168, 1, 1)),
            format!("http://{}/", std::net::Ipv4Addr::new(100, 100, 100, 100)),
            "http://[::1]/".to_string(),
            "http://[fc00::1]/".to_string(),
            "http://[::ffff:127.0.0.1]/".to_string(),
            "file:///etc/passwd".to_string(),
        ] {
            let parsed = reqwest::Url::parse(&url).unwrap();
            assert!(public_url(&parsed).is_err(), "{url}");
        }
    }

    #[test]
    fn allows_public_page_addresses() {
        for url in [
            "https://example.com/",
            "http://8.8.8.8/",
            "https://[2606:4700:4700::1111]/",
        ] {
            let parsed = reqwest::Url::parse(url).unwrap();
            assert!(public_url(&parsed).is_ok(), "{url}");
        }
    }
}
