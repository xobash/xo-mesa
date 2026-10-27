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
    #[serde(rename = "subresourceToken", skip_serializing_if = "Option::is_none")]
    pub subresource_token: Option<String>,
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
    let meta = if charset.is_none() {
        meta_charset(bytes)
    } else {
        None
    };
    let encoding = charset
        .or(meta.as_deref())
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .map(|encoding| {
            if charset.is_none()
                && (encoding == encoding_rs::UTF_16LE || encoding == encoding_rs::UTF_16BE)
            {
                encoding_rs::UTF_8
            } else {
                encoding
            }
        })
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
pub async fn browse_fetch(
    window: tauri::Window,
    app: tauri::AppHandle,
    url: String,
) -> Result<BrowsePage, String> {
    crate::require_agent_surface(window.label())?;
    use tauri::Emitter;
    let mut page = fetch_inner(url, false).await?;
    page.subresource_token = Some(create_resource_token(window.label())?);
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

fn fetch_error(error: reqwest::Error) -> String {
    // Preserve the broker's explicit DNS/redirect rejection before classifying transport errors.
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&error);
    while let Some(cause) = source {
        for reason in [
            "private network address is blocked",
            "redirect to a private network is blocked",
        ] {
            if cause.to_string().contains(reason) {
                return reason.into();
            }
        }
        source = cause.source();
    }
    if error.is_connect() || error.is_timeout() {
        "Direct connection failed. Mesa does not use system proxies. Check your connection; networks that require a proxy need a direct connection for Mesa's reader.".into()
    } else {
        format!("Page request failed: {}", error.without_url())
    }
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
        .map_err(fetch_error)?;

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
        subresource_token: None,
    };
    *current_page()
        .lock()
        .map_err(|_| "browser source state unavailable")? =
        Some((page.clone(), std::time::Instant::now()));
    Ok(page)
}

fn meta_charset(bytes: &[u8]) -> Option<String> {
    let ascii: String = bytes
        .iter()
        .take(1024)
        .map(|b| if b.is_ascii() { *b as char } else { ' ' })
        .collect();
    let mut rest = ascii.as_str();
    while let Some(start) = rest.find('<') {
        rest = &rest[start + 1..];
        if rest.starts_with("!--") {
            let end = rest.find("-->")?;
            rest = &rest[end + 3..];
            continue;
        }
        let end = rest.find('>')?;
        let tag = &rest[..end];
        rest = &rest[end + 1..];
        let mut chars = tag.char_indices().peekable();
        let name: String = chars
            .by_ref()
            .take_while(|(_, c)| !c.is_ascii_whitespace())
            .map(|(_, c)| c)
            .collect();
        if !name.eq_ignore_ascii_case("meta") {
            continue;
        }
        let mut attrs = std::collections::HashMap::new();
        while chars.peek().is_some() {
            while chars
                .peek()
                .is_some_and(|(_, c)| c.is_ascii_whitespace() || *c == '/')
            {
                chars.next();
            }
            let mut key = String::new();
            while chars
                .peek()
                .is_some_and(|(_, c)| !c.is_ascii_whitespace() && *c != '=')
            {
                key.push(chars.next().unwrap().1);
            }
            while chars.peek().is_some_and(|(_, c)| c.is_ascii_whitespace()) {
                chars.next();
            }
            if chars.peek().is_none_or(|(_, c)| *c != '=') {
                continue;
            }
            chars.next();
            while chars.peek().is_some_and(|(_, c)| c.is_ascii_whitespace()) {
                chars.next();
            }
            let quote = chars
                .peek()
                .and_then(|(_, c)| (*c == '\'' || *c == '"').then_some(*c));
            if quote.is_some() {
                chars.next();
            }
            let mut value = String::new();
            for (_, c) in chars.by_ref() {
                if quote.map_or(c.is_ascii_whitespace(), |q| c == q) {
                    break;
                }
                value.push(c);
            }
            attrs.entry(key.to_ascii_lowercase()).or_insert(value);
        }
        if let Some(label) = attrs.get("charset") {
            if encoding_rs::Encoding::for_label(label.as_bytes()).is_some() {
                return Some(label.clone());
            }
        }
        if attrs
            .get("http-equiv")
            .is_some_and(|s| s.eq_ignore_ascii_case("content-type"))
        {
            if let Some(content) = attrs.get("content") {
                let lower = content.to_ascii_lowercase();
                if let Some((_, label)) = lower.split_once("charset=") {
                    let label = label
                        .trim()
                        .trim_matches(['\'', '"'])
                        .split([';', ' '])
                        .next()
                        .unwrap_or("");
                    if encoding_rs::Encoding::for_label(label.as_bytes()).is_some() {
                        return Some(label.to_string());
                    }
                }
            }
        }
    }
    None
}

const RESOURCE_LIMIT: usize = 6 * 1024 * 1024;
const VIEW_LIMIT: usize = 48 * 1024 * 1024;
struct ResourceBudget {
    owner: String,
    requests: u32,
    bytes: usize,
    created: std::time::Instant,
}
fn resource_tokens() -> &'static Mutex<std::collections::HashMap<String, ResourceBudget>> {
    static TOKENS: OnceLock<Mutex<std::collections::HashMap<String, ResourceBudget>>> =
        OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}
fn create_resource_token(owner: &str) -> Result<String, String> {
    let token = crate::activity::make_token()?;
    let mut tokens = resource_tokens()
        .lock()
        .map_err(|_| "resources unavailable")?;
    if tokens.len() >= 8 {
        if let Some(oldest) = tokens
            .iter()
            .min_by_key(|(_, b)| b.created)
            .map(|(key, _)| key.clone())
        {
            tokens.remove(&oldest);
        }
    }
    tokens.insert(
        token.clone(),
        ResourceBudget {
            owner: owner.into(),
            requests: 0,
            bytes: 0,
            created: std::time::Instant::now(),
        },
    );
    Ok(token)
}
fn charge_resource(owner: &str, token: &str, bytes: usize, request: bool) -> Result<(), String> {
    charge_resource_at(owner, token, bytes, request, std::time::Instant::now())
}
fn charge_resource_at(
    owner: &str,
    token: &str,
    bytes: usize,
    request: bool,
    now: std::time::Instant,
) -> Result<(), String> {
    let mut tokens = resource_tokens()
        .lock()
        .map_err(|_| "resources unavailable")?;
    let budget = tokens.get_mut(token).ok_or("resources expired")?;
    if budget.owner != owner
        || now.saturating_duration_since(budget.created) > std::time::Duration::from_secs(600)
        || (request && budget.requests >= 400)
        || bytes > VIEW_LIMIT.saturating_sub(budget.bytes)
    {
        return Err("resource budget exceeded".into());
    }
    if request {
        budget.requests += 1;
    }
    budget.bytes += bytes;
    Ok(())
}
fn resource_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; MesaBrowser/0.1)")
        .no_proxy()
        .referer(false)
        .dns_resolver(Arc::new(PublicResolver))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 || public_url(attempt.url()).is_err() {
                attempt.error("blocked redirect")
            } else {
                attempt.follow()
            }
        }))
        .timeout(std::time::Duration::from_secs(15))
}
fn resource_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            resource_client_builder()
                .build()
                .map_err(|_| "resource client unavailable".into())
        })
        .as_ref()
        .map_err(Clone::clone)
}
fn allowed_resource_type(mime: &str) -> bool {
    matches!(
        mime,
        "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "image/avif"
            | "image/svg+xml"
            | "image/x-icon"
            | "image/vnd.microsoft.icon"
            | "font/woff"
            | "font/woff2"
            | "font/ttf"
            | "font/otf"
            | "font/sfnt"
            | "application/font-woff"
            | "application/x-font-ttf"
            | "application/vnd.ms-fontobject"
    )
}
fn sniff_resource_type(body: &[u8]) -> Option<&'static str> {
    match body {
        [b'w', b'O', b'F', b'F', ..] => Some("font/woff"),
        [b'w', b'O', b'F', b'2', ..] => Some("font/woff2"),
        [0, 1, 0, 0, ..] | [b't', b'r', b'u', b'e', ..] => Some("font/ttf"),
        [b'O', b'T', b'T', b'O', ..] => Some("font/otf"),
        [0x89, b'P', b'N', b'G', 13, 10, 26, 10, ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        [_, _, _, _, b'f', b't', b'y', b'p', b'a', b'v', b'i', b'f', ..] => Some("image/avif"),
        [0, 0, 1, 0, ..] => Some("image/x-icon"),
        [b'B', b'M', ..] => Some("image/bmp"),
        _ => None,
    }
}

async fn fetch_resource(
    owner: &str,
    token: &str,
    url: &str,
    css: bool,
) -> Result<(Vec<u8>, String, String), String> {
    charge_resource(owner, token, 0, true)?;
    check_public_url(url)?;
    let response = resource_client()?
        .get(url)
        .header(
            "Accept",
            if css {
                "text/css"
            } else {
                "image/*,font/*;q=0.9"
            },
        )
        .send()
        .await
        .map_err(|_| "resource failed")?;
    read_resource_response(owner, token, response, css).await
}
async fn read_resource_response(
    owner: &str,
    token: &str,
    mut response: reqwest::Response,
    css: bool,
) -> Result<(Vec<u8>, String, String), String> {
    let final_url = response.url().to_string();
    if !response.status().is_success() {
        return Err("resource failed".into());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if css
        && mime != "text/css"
        && !((mime.is_empty() || mime == "text/plain")
            && response.url().path().to_ascii_lowercase().ends_with(".css"))
    {
        return Err("resource type blocked".into());
    }
    let limit = if css { 2 * 1024 * 1024 } else { RESOURCE_LIMIT };
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("resource too large".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "resource failed")? {
        charge_resource(owner, token, chunk.len(), false)?;
        if chunk.len() > limit - body.len() {
            return Err("resource too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    let served_type = if css || allowed_resource_type(&mime) {
        // Preserve the declared charset until stylesheet bytes are decoded.
        content_type
    } else {
        sniff_resource_type(&body)
            .ok_or("resource type blocked")?
            .to_string()
    };
    Ok((body, served_type, final_url))
}
#[tauri::command]
pub fn browse_resource_session(
    window: tauri::Window,
    token: Option<String>,
) -> Result<Option<String>, String> {
    let owner = window.label();
    if owner != "main"
        && !owner.starts_with("agent-")
        && !owner.starts_with("doc-")
        && !owner.starts_with("panel-")
    {
        return Err("surface denied".into());
    }
    if let Some(token) = token {
        let mut tokens = resource_tokens()
            .lock()
            .map_err(|_| "resources unavailable")?;
        if tokens.get(&token).is_some_and(|b| b.owner == owner) {
            tokens.remove(&token);
        }
        Ok(None)
    } else {
        create_resource_token(owner).map(Some)
    }
}
#[derive(Serialize)]
pub struct BrowseStylesheet {
    css: String,
    #[serde(rename = "finalUrl")]
    final_url: String,
}
#[tauri::command]
pub async fn browse_fetch_stylesheet(
    window: tauri::Window,
    token: String,
    url: String,
) -> Result<BrowseStylesheet, String> {
    let (body, content_type, final_url) =
        fetch_resource(window.label(), &token, &url, true).await?;
    Ok(BrowseStylesheet {
        css: decode_page_body(&body, &content_type),
        final_url,
    })
}
pub async fn serve_subresource(
    owner: &str,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let mut response = tauri::http::Response::builder()
        .header("X-Content-Type-Options", "nosniff")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("Cache-Control", "no-store")
        .header(
            "Content-Security-Policy",
            "default-src 'none'; sandbox; style-src 'unsafe-inline'",
        );
    if request.method() != tauri::http::Method::GET {
        return response.status(405).body(Vec::new()).unwrap();
    }
    let token = request.uri().path().trim_start_matches('/');
    let url = url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
        .find(|(k, _)| k == "u")
        .map(|(_, v)| v.into_owned());
    if let Some(url) = url {
        if let Ok((body, mime, _)) = fetch_resource(owner, token, &url, false).await {
            response = response.header("Content-Type", mime);
            return response.status(200).body(body).unwrap();
        }
    }
    response.status(403).body(Vec::new()).unwrap()
}

#[tauri::command(async)]
pub fn browse_open_saved_html(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let checked = crate::vaultscope::require_approved_file(&app, &path)?;
    if !checked
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("html") || s.eq_ignore_ascii_case("htm"))
    {
        return Err("only saved HTML can be opened".into());
    }
    app.opener()
        .open_path(checked.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|_| "Could not open system browser".into())
}

pub(crate) fn revoke_resource_window(owner: &str) {
    if let Ok(mut tokens) = resource_tokens().lock() {
        tokens.retain(|_, budget| budget.owner != owner);
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn connection_error_classification_preserves_dns_rejection() {
        let error = super::client_for_agent(false)
            .unwrap()
            .get("http://localhost:1")
            .send()
            .await
            .unwrap_err();
        assert_eq!(
            super::fetch_error(error),
            "private network address is blocked"
        );
    }

    #[tokio::test]
    async fn connection_failure_explains_direct_only_browsing() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let error = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap_err();
        let message = super::fetch_error(error);
        assert!(message.contains("Direct connection failed"));
        assert!(message.contains("does not use system proxies"));
        assert!(!message.contains(&address.to_string()));
    }

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

    #[test]
    fn charset_prescan_obeys_headers_comments_and_scan_limit() {
        assert_eq!(
            decode_page_body(b"<meta charset='windows-1252'>caf\xe9", "text/html"),
            "<meta charset='windows-1252'>café"
        );
        let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode(
            "<meta http-equiv='content-type' content='text/html; charset=Shift_JIS'>日本語",
        );
        assert!(decode_page_body(&bytes, "text/html").ends_with("日本語"));
        assert!(meta_charset(b"<!-- <meta charset=shift_jis> -->").is_none());
        assert!(
            meta_charset(format!("{}<meta charset=shift_jis>", " ".repeat(1024)).as_bytes())
                .is_none()
        );
        assert!(decode_page_body(
            "<meta charset=windows-1252>café".as_bytes(),
            "text/html; charset=utf-8"
        )
        .ends_with("café"));
    }
    #[tokio::test]
    async fn resources_enforce_response_types_and_complete_byte_limits() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let base = format!("http://resource.example.com:{}/", address.port());
        let worker = std::thread::spawn(move || {
            for (mime, bytes) in [
                ("text/plain", b"p{color:teal}".to_vec()),
                (
                    "application/octet-stream",
                    b"<script>bad()</script>".to_vec(),
                ),
                ("image/png", vec![0; RESOURCE_LIMIT + 1]),
                ("application/octet-stream", b"wOF2fixture".to_vec()),
                (
                    "text/css; charset=windows-1252",
                    b".caf\xe9::before{content:'caf\xe9'}".to_vec(),
                ),
            ] {
                let request = server.recv().unwrap();
                let mut redirect = tiny_http::Response::empty(302);
                redirect
                    .add_header(tiny_http::Header::from_bytes("Location", "/style.css").unwrap());
                redirect.add_header(
                    tiny_http::Header::from_bytes("Set-Cookie", "redirect_cookie=private").unwrap(),
                );
                request.respond(redirect).unwrap();
                let request = server.recv().unwrap();
                assert_eq!(request.url(), "/style.css");
                let mut response = tiny_http::Response::from_data(bytes);
                response.add_header(tiny_http::Header::from_bytes("Content-Type", mime).unwrap());
                response.add_header(
                    tiny_http::Header::from_bytes("Set-Cookie", "should_not_persist=yes").unwrap(),
                );
                assert!(!request
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv("Cookie") || h.field.equiv("Referer")));
                let _ = request.respond(response);
            }
        });
        let token = create_resource_token("resource-response-test").unwrap();
        // Override only the fixture hostname on the real production client builder.
        let client = resource_client_builder()
            .resolve("resource.example.com", address)
            .build()
            .unwrap();
        let response = client.get(&base).send().await.unwrap();
        assert_eq!(
            read_resource_response("resource-response-test", &token, response, true)
                .await
                .unwrap()
                .0,
            b"p{color:teal}"
        );
        let response = client.get(&base).send().await.unwrap();
        assert!(
            read_resource_response("resource-response-test", &token, response, false)
                .await
                .is_err()
        );
        let response = client.get(&base).send().await.unwrap();
        assert!(
            read_resource_response("resource-response-test", &token, response, false)
                .await
                .is_err()
        );
        let response = client.get(&base).send().await.unwrap();
        let resource = read_resource_response("resource-response-test", &token, response, false)
            .await
            .unwrap();
        assert_eq!(resource.1, "font/woff2");
        assert_eq!(resource.0, b"wOF2fixture");
        let response = client.get(&base).send().await.unwrap();
        let (body, content_type, _) =
            read_resource_response("resource-response-test", &token, response, true)
                .await
                .unwrap();
        assert_eq!(
            decode_page_body(&body, &content_type),
            ".café::before{content:'café'}"
        );
        worker.join().unwrap();
        revoke_resource_window("resource-response-test");
    }

    #[test]
    fn resources_reject_invalid_tokens_owners_expiry_and_budget() {
        assert!(charge_resource("resource-budget-test", "unknown", 0, true).is_err());
        let token = create_resource_token("resource-budget-test").unwrap();
        assert!(charge_resource("doc-test", &token, 0, true).is_err());
        assert!(charge_resource("resource-budget-test", &token, VIEW_LIMIT + 1, false).is_err());
        for _ in 0..400 {
            charge_resource("resource-budget-test", &token, 0, true).unwrap();
        }
        assert!(charge_resource("resource-budget-test", &token, 0, true).is_err());
        let created = resource_tokens()
            .lock()
            .unwrap()
            .get(&token)
            .unwrap()
            .created;
        let expires_at = created + std::time::Duration::from_secs(600);
        assert!(charge_resource_at("resource-budget-test", &token, 0, false, expires_at).is_ok());
        let expired_at = created + std::time::Duration::from_secs(601);
        assert!(charge_resource_at("resource-budget-test", &token, 0, false, expired_at).is_err());
        revoke_resource_window("resource-budget-test");
        assert!(charge_resource("resource-budget-test", &token, 0, false).is_err());
    }
    #[tokio::test]
    async fn resources_reject_private_addresses_and_non_get() {
        let token = create_resource_token("main").unwrap();
        assert!(
            fetch_resource("main", &token, "http://localhost/x.png", false)
                .await
                .is_err()
        );
        assert!(
            fetch_resource("main", &token, "http://127.0.0.1/x.css", true)
                .await
                .is_err()
        );
        let response = serve_subresource(
            "main",
            tauri::http::Request::builder()
                .uri("mesa-web://localhost/unknown?u=https%3A%2F%2Fexample.com")
                .body(Vec::new())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), 403);
        assert!(response.body().is_empty());
        let response = serve_subresource(
            "main",
            tauri::http::Request::builder()
                .method("POST")
                .uri("mesa-web://localhost/unknown")
                .body(Vec::new())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), 405);
        assert!(!allowed_resource_type("text/html"));
        assert!(!allowed_resource_type("application/javascript"));
        assert!(allowed_resource_type("font/woff2"));
        assert!(allowed_resource_type("image/svg+xml"));
        resource_tokens().lock().unwrap().remove(&token);
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
