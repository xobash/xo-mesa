use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde::Serialize;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};

const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// User browsing and Pi's browse tool keep separate in-memory cookie jars.
fn client_for_agent(agent: bool) -> Result<&'static reqwest::Client, String> {
    static USER_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    static AGENT_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    let cell = if agent { &AGENT_CLIENT } else { &USER_CLIENT };
    cell.get_or_init(|| {
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
                || (a == 192
                    && ((b == 0 && (c == 0 || c == 2)) || b == 168 || (b == 88 && c == 99)))
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

#[derive(Clone, Serialize)]
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
    pub truncated: bool,
}

fn current_page() -> &'static Mutex<Option<(BrowsePage, std::time::Instant)>> {
    static CURRENT: OnceLock<Mutex<Option<(BrowsePage, std::time::Instant)>>> = OnceLock::new();
    CURRENT.get_or_init(|| Mutex::new(None))
}

pub fn current_page_json() -> String {
    match current_page().lock() {
        Ok(page) => match page.as_ref() {
            Some((page, at)) => serde_json::json!({ "page": page, "ageMs": at.elapsed().as_millis(), "trust": "untrusted-page-content" }).to_string(),
            None => serde_json::json!({ "page": null, "ageMs": null }).to_string(),
        },
        Err(_) => serde_json::json!({ "page": null, "ageMs": null }).to_string(),
    }
}

fn decode_page_body(bytes: &[u8], content_type: &str) -> String {
    let charset = content_type.split(';').skip(1).find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        name.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| value.trim().trim_matches('"'))
    });
    let encoding = charset
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(bytes).0.into_owned()
}

async fn read_text_body(
    resp: &mut reqwest::Response,
    content_type: &str,
) -> Result<(String, bool), String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = resp.chunk().await.map_err(|error| error.to_string())? {
        let room = MAX_BODY_BYTES.saturating_sub(buf.len());
        if room == 0 {
            truncated = true;
            break;
        }
        let take = room.min(chunk.len());
        buf.extend_from_slice(&chunk[..take]);
        if take < chunk.len() {
            truncated = true;
            break;
        }
    }
    Ok((decode_page_body(&buf, content_type), truncated))
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
pub async fn browse_fetch(app: tauri::AppHandle, url: String) -> Result<BrowsePage, String> {
    use tauri::Emitter;
    let page = fetch_inner(url, false).await?;
    let _ = app.emit(
        "mesa://browse-observed",
        serde_json::json!({ "url": page.final_url }),
    );
    Ok(page)
}

/// Synchronous wrapper for non-async callers (the loopback activity server
/// thread serving the Pi agent's `browse` tool).
pub fn browse_fetch_blocking(url: String) -> Result<BrowsePage, String> {
    tauri::async_runtime::block_on(fetch_inner(url, true))
}

async fn fetch_inner(url: String, agent: bool) -> Result<BrowsePage, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("unsupported scheme: {other}")),
    }

    public_url(&parsed)?;

    let mut resp = client_for_agent(agent)?
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

    let (body, truncated) = if is_texty(&content_type) {
        let (body, truncated) = read_text_body(&mut resp, &content_type).await?;
        (Some(body), truncated)
    } else {
        (None, false)
    };

    let page = BrowsePage {
        final_url,
        status,
        content_type,
        frame_blocked: blocked,
        body,
        truncated,
    };
    *current_page()
        .lock()
        .map_err(|_| "browser source state unavailable")? =
        Some((page.clone(), std::time::Instant::now()));
    Ok(page)
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

    #[tokio::test]
    async fn final_connection_resolver_rejects_local_dns_answers() {
        use std::str::FromStr;
        let result = PublicResolver
            .resolve(Name::from_str("localhost").unwrap())
            .await;
        assert!(result.is_err());
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
        for url in [
            "http://192.1.1.1/",
            "http://192.0.1.1/",
            "http://192.0.3.1/",
        ] {
            let parsed = reqwest::Url::parse(url).unwrap();
            assert!(public_url(&parsed).is_ok(), "{url}");
        }
    }

    #[test]
    fn rejects_only_special_purpose_192_0_subnets() {
        for url in ["http://192.0.0.1/", "http://192.0.2.1/"] {
            let parsed = reqwest::Url::parse(url).unwrap();
            assert!(public_url(&parsed).is_err(), "{url}");
        }
    }

    #[test]
    fn decodes_the_declared_page_charset() {
        assert_eq!(
            decode_page_body(b"caf\xe9", "text/html; charset=windows-1252"),
            "café"
        );
        assert_eq!(decode_page_body("café".as_bytes(), "text/html"), "café");
    }

    #[tokio::test]
    async fn agent_fetch_does_not_receive_user_fetch_cookies() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let worker = std::thread::spawn(move || {
            for _ in 0..3 {
                let request = server.recv().unwrap();
                let cookie = request
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("Cookie"))
                    .map(|header| header.value.as_str().to_string())
                    .unwrap_or_default();
                let mut response = tiny_http::Response::from_string(cookie);
                if request.url() == "/set" {
                    response.add_header(
                        tiny_http::Header::from_bytes("Set-Cookie", "mesa_user=private; Path=/")
                            .unwrap(),
                    );
                }
                request.respond(response).unwrap();
            }
        });
        client_for_agent(false)
            .unwrap()
            .get(format!("{base}/set"))
            .send()
            .await
            .unwrap();
        let agent = client_for_agent(true)
            .unwrap()
            .get(format!("{base}/echo"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        let user = client_for_agent(false)
            .unwrap()
            .get(format!("{base}/echo"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        worker.join().unwrap();
        assert!(agent.is_empty());
        assert!(user.contains("mesa_user=private"));
    }

    #[tokio::test]
    async fn bounded_page_read_reports_truncation() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.server_addr());
        let worker = std::thread::spawn(move || {
            let request = server.recv().unwrap();
            request
                .respond(tiny_http::Response::from_data(vec![
                    b'x';
                    MAX_BODY_BYTES + 1
                ]))
                .unwrap();
        });
        let mut response = client_for_agent(false)
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap();
        let (body, truncated) = read_text_body(&mut response, "text/plain").await.unwrap();
        worker.join().unwrap();
        assert_eq!(body.len(), MAX_BODY_BYTES);
        assert!(truncated);
    }
}
