// Explicit local HTML execution in an opaque, token-scoped frame.
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::http::{Request, Response, StatusCode};

const MAX_BYTES: u64 = 32 * 1024 * 1024;
const SOURCES: &str = "mesa-html: http://mesa-html.localhost https://mesa-html.localhost";
struct Session {
    owner: String,
    root: PathBuf,
    entry: PathBuf,
    digest: [u8; 32],
    /// Bytes of every other resource as first served; later changes are refused.
    served: HashMap<PathBuf, [u8; 32]>,
    online: bool,
    created: Instant,
    touched: Instant,
}
fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(Default::default)
}
fn document_surface(owner: &str) -> bool {
    owner == "main"
        || owner.starts_with("doc-")
        || owner.starts_with("panel-")
        || owner.starts_with("agent-")
}
fn create_session(
    owner: &str,
    entry: &Path,
    online: bool,
    expected_text: &str,
) -> Result<String, String> {
    if !document_surface(owner) {
        return Err("document surface required".into());
    }
    if !matches!(
        entry
            .extension()
            .and_then(|s| s.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("html" | "htm")
    ) {
        return Err("HTML file required".into());
    }
    let bytes = read_file(entry)?;
    let text_bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    if expected_text.len() > 8 * 1024 * 1024 || text_bytes != expected_text.as_bytes() {
        return Err(
            "HTML changed before script consent could be applied. Reload and try again.".into(),
        );
    }
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    let root = entry
        .parent()
        .ok_or("document folder missing")?
        .canonicalize()
        .map_err(|_| "document folder unavailable")?;
    let name = entry
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("document name unavailable")?;
    let token = crate::activity::make_token()?;
    let now = Instant::now();
    let mut map = sessions().lock().map_err(|_| "HTML sessions unavailable")?;
    map.retain(|_, s| now.duration_since(s.touched) <= Duration::from_secs(600));
    if map.values().filter(|s| s.owner == owner).count() >= 8 {
        if let Some(oldest) = map
            .iter()
            .filter(|(_, s)| s.owner == owner)
            .min_by_key(|(_, s)| s.created)
            .map(|(k, _)| k.clone())
        {
            map.remove(&oldest);
        }
    }
    map.insert(
        token.clone(),
        Session {
            owner: owner.into(),
            root,
            entry: entry.to_path_buf(),
            digest,
            served: HashMap::new(),
            online,
            created: now,
            touched: now,
        },
    );
    let encoded: String = name
        .as_bytes()
        .iter()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(b) {
                (*b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    Ok(format!("{token}/{encoded}"))
}
#[tauri::command(async)]
pub fn html_run_session(
    window: tauri::Window,
    app: tauri::AppHandle,
    path: String,
    online: bool,
    expected_text: String,
) -> Result<String, String> {
    // WebView2 injects Tauri initialization into subframes. Do not expose this
    // mode there until the absent-IPC boundary is established independently.
    if cfg!(windows) {
        return Err("Run scripts is unavailable on Windows until frame isolation is verified. Use the system browser.".into());
    }
    let entry = crate::vaultscope::require_approved_file(&app, &path)?;
    create_session(window.label(), &entry, online, &expected_text)
}
#[tauri::command]
pub fn html_run_revoke(window: tauri::Window, token: String) {
    if let Ok(mut map) = sessions().lock() {
        if map.get(&token).is_some_and(|s| s.owner == window.label()) {
            map.remove(&token);
        }
    }
}
pub(crate) fn revoke_window(owner: &str) {
    if let Ok(mut map) = sessions().lock() {
        map.retain(|_, s| s.owner != owner);
    }
}
fn decode_path(raw: &str) -> Result<String, String> {
    let mut bytes = Vec::new();
    let mut at = 0;
    while at < raw.len() {
        let b = raw.as_bytes()[at];
        if b == b'%' {
            let hex = raw.get(at + 1..at + 3).ok_or("invalid escape")?;
            bytes.push(u8::from_str_radix(hex, 16).map_err(|_| "invalid escape")?);
            at += 3;
        } else {
            bytes.push(b);
            at += 1;
        }
    }
    String::from_utf8(bytes).map_err(|_| "invalid path".into())
}
fn resolve(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let rel = decode_path(raw)?;
    if rel.is_empty()
        || rel.contains(['\\', '\0', ':'])
        || rel.starts_with('/')
        || rel
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err("path blocked".into());
    }
    let path = root
        .join(&rel)
        .canonicalize()
        .map_err(|_| "file unavailable")?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("path blocked".into());
    }
    Ok(path)
}
fn mime(path: &Path) -> Option<&'static str> {
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "html" | "htm" => "text/html; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "js" | "mjs" => "text/javascript; charset=utf-8",
            "json" => "application/json",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "avif" => "image/avif",
            "ico" => "image/x-icon",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            "ttf" => "font/ttf",
            "otf" => "font/otf",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "ogg" => "audio/ogg",
            "txt" => "text/plain; charset=utf-8",
            "csv" => "text/csv; charset=utf-8",
            "wasm" => "application/wasm",
            _ => return None,
        },
    )
}
fn policy(online: bool) -> String {
    let on = if online { " https:" } else { "" };
    format!("default-src 'none'; script-src {SOURCES} 'unsafe-inline' 'unsafe-eval' blob:{on}; style-src {SOURCES} 'unsafe-inline'{on}; img-src {SOURCES} data: blob:{on}; font-src {SOURCES} data:{on}; media-src {SOURCES} data: blob:{on}; connect-src {SOURCES}{on}; worker-src {SOURCES} blob:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'")
}
fn read_session(owner: &str, uri: &tauri::http::Uri) -> Result<(String, PathBuf, bool), String> {
    let (token, raw) = uri
        .path()
        .strip_prefix('/')
        .ok_or("invalid path")?
        .split_once('/')
        .ok_or("invalid path")?;
    let mut map = sessions().lock().map_err(|_| "HTML sessions unavailable")?;
    let now = Instant::now();
    map.retain(|_, s| now.duration_since(s.touched) <= Duration::from_secs(600));
    let session = map
        .get_mut(token)
        .filter(|s| s.owner == owner)
        .ok_or("session denied")?;
    let path = resolve(&session.root, raw)?;
    session.touched = now;
    Ok((token.to_string(), path, session.online))
}
/// Consent covers the exact entry bytes and each resource's bytes as first served.
fn admit_resource(session: &mut Session, path: &Path, digest: [u8; 32]) -> Result<(), String> {
    let expected = if path == session.entry {
        session.digest
    } else {
        *session.served.entry(path.to_path_buf()).or_insert(digest)
    };
    if expected == digest {
        Ok(())
    } else {
        Err("HTML changed after consent".into())
    }
}
fn admit_served(owner: &str, token: &str, path: &Path, body: &[u8]) -> Result<(), String> {
    let mut map = sessions().lock().map_err(|_| "HTML sessions unavailable")?;
    let session = map
        .get_mut(token)
        .filter(|s| s.owner == owner)
        .ok_or("session denied")?;
    admit_resource(session, path, Sha256::digest(body).into())
}
pub(crate) fn navigation_allowed(owner: &str, url: &tauri::Url) -> bool {
    let origin = (url.scheme() == "mesa-html" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("mesa-html.localhost"));
    if !origin || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return false;
    }
    let mut target = url.clone();
    target.set_fragment(None);
    target
        .as_str()
        .parse::<tauri::http::Uri>()
        .is_ok_and(|uri| read_session(owner, &uri).is_ok())
}

fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|_| "file unavailable")?;
    if !file
        .metadata()
        .is_ok_and(|m| m.is_file() && m.len() <= MAX_BYTES)
    {
        return Err("file too large".into());
    }
    let mut body = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| "file unavailable")?;
    if body.len() as u64 > MAX_BYTES {
        return Err("file too large".into());
    }
    Ok(body)
}
pub(crate) fn serve(
    app: &tauri::AppHandle,
    owner: &str,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let result = (|| {
        if request.method() != "GET" {
            return Err("method blocked".into());
        }
        let (token, path, online) = read_session(owner, request.uri())?;
        crate::vaultscope::require_approved_file(app, path.to_str().ok_or("path unavailable")?)?;
        let content_type = mime(&path).ok_or("type blocked")?;
        let body = read_file(&path)?;
        admit_served(owner, &token, &path, &body)?;
        Ok::<_, String>((body, content_type, online))
    })();
    let (status, body, content_type, online) = match result {
        Ok((body, content_type, online)) => (StatusCode::OK, body, content_type, online),
        Err(_) => (
            StatusCode::FORBIDDEN,
            b"HTML resource blocked".to_vec(),
            "text/plain",
            false,
        ),
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    for (name, value) in [
        ("Content-Type", content_type.to_string()),
        ("Content-Security-Policy", policy(online)),
        ("X-Content-Type-Options", "nosniff".into()),
        ("Referrer-Policy", "no-referrer".into()),
        ("Cache-Control", "no-store".into()),
        ("Access-Control-Allow-Origin", "*".into()),
    ] {
        if let (Ok(name), Ok(value)) = (
            name.parse::<tauri::http::header::HeaderName>(),
            value.parse(),
        ) {
            response.headers_mut().insert(name, value);
        }
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        let now = Instant::now();
        Session {
            owner: "main".into(),
            root: PathBuf::from("/vault/site"),
            entry: PathBuf::from("/vault/site/index.html"),
            digest: Sha256::digest(b"<script src=app.js></script>").into(),
            served: HashMap::new(),
            online: false,
            created: now,
            touched: now,
        }
    }

    #[test]
    fn consent_refuses_changed_entry_and_resources_after_first_serve() {
        let mut s = session();
        let entry = s.entry.clone();
        let app = PathBuf::from("/vault/site/app.js");
        assert!(admit_resource(
            &mut s,
            &entry,
            Sha256::digest(b"<script src=app.js></script>").into()
        )
        .is_ok());
        assert!(admit_resource(
            &mut s,
            &entry,
            Sha256::digest(b"<script>changed</script>").into()
        )
        .is_err());
        assert!(admit_resource(&mut s, &app, Sha256::digest(b"run()").into()).is_ok());
        assert!(admit_resource(&mut s, &app, Sha256::digest(b"run()").into()).is_ok());
        assert!(admit_resource(&mut s, &app, Sha256::digest(b"steal()").into()).is_err());
    }
}
