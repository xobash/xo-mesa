// sync_core.rs — pure, dependency-free sync logic.
//
// Everything here is std-only (no tauri / reqwest / rustls / tiny_http), which
// keeps it unit-testable with a bare `cargo test` and makes the cross-language
// contract explicit: `fnv1a_hex`, `diff_manifests`, and `conflict_name` MUST
// stay byte-for-byte compatible with their reference twins in
// `src/lib/sync.ts` (which pin the same vectors in vitest).
//
// The impure halves — TLS identity, the HTTPS server, the pinned client, and
// the `sync_run` engine — live in `sync.rs` and call into this module.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Epoch milliseconds now (0 if the clock is before 1970, which it isn't).
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// === Hashing =============================================================

/// FNV-1a/64 running hasher. Chunk-feeding N buffers is byte-for-byte
/// identical to hashing their concatenation, so streamed file hashing matches
/// the TypeScript whole-buffer implementation exactly.
pub struct Fnv1a {
    h: u64,
}

impl Fnv1a {
    pub fn new() -> Self {
        Fnv1a {
            h: 0xcbf2_9ce4_8422_2325,
        }
    }

    pub fn update(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.h ^= b as u64;
            self.h = self.h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }

    /// 16-char lowercase hex digest, identical to `fnv1a` in src/lib/sync.ts.
    pub fn hex(&self) -> String {
        format!("{:016x}", self.h)
    }
}

/// One-shot FNV-1a/64 of a byte slice.
pub fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut f = Fnv1a::new();
    f.update(bytes);
    f.hex()
}

/// Hash a file by streaming 64 KiB chunks — never loads the file into memory.
/// Returns (size, hash).
pub fn hash_file_streaming(path: &Path) -> std::io::Result<(u64, String)> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Fnv1a::new();
    let mut buf = [0u8; 64 * 1024];
    let mut size: u64 = 0;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        hasher.update(&buf[..n]);
    }
    Ok((size, hasher.hex()))
}

// === Hash cache ==========================================================

/// Content-hash cache keyed by (size, mtime). Manifest builds re-hash only
/// files that changed since the last build, which is what makes repeated
/// syncs of a hundreds-of-files vault cheap on both the serving and the
/// initiating side.
#[derive(Default)]
pub struct HashCache {
    entries: HashMap<PathBuf, (u64, u128, String)>, // size, mtime_ns, hash
}

impl HashCache {
    pub fn new() -> Self {
        HashCache {
            entries: HashMap::new(),
        }
    }

    /// (size, hash) of `path`, re-hashing only when size or mtime changed.
    pub fn hash_file(&mut self, path: &Path) -> std::io::Result<(u64, String)> {
        let meta = std::fs::metadata(path)?;
        let size = meta.len();
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        if let Some((s, m, h)) = self.entries.get(path) {
            if *s == size && *m == mtime_ns && mtime_ns != 0 {
                return Ok((size, h.clone()));
            }
        }
        let (real_size, hash) = hash_file_streaming(path)?;
        self.entries
            .insert(path.to_path_buf(), (real_size, mtime_ns, hash.clone()));
        Ok((real_size, hash))
    }
}

// === Vault walking =======================================================

/// Files/dirs sync ignores. Matches the frontend vault walker
/// (`src/lib/vault.ts` `walk`): dot-prefixed names (covers `.git`,
/// `.obsidian`, `.DS_Store`) and `node_modules`.
pub fn ignored_name(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

/// Recursively list every syncable file under `root` as
/// (vault-relative path with forward slashes, absolute path), sorted by rel
/// path for deterministic manifests. Unreadable directories are skipped.
pub fn list_vault_files(root: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if ignored_name(&name) {
            continue;
        }
        let path = entry.path();
        let ftype = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ftype.is_dir() {
            walk(root, &path, out);
        } else if ftype.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                out.push((rel, path));
            }
        }
    }
}

// === Manifest ============================================================

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ManifestEntry {
    pub rel: String,
    pub size: u64,
    pub hash: String,
}

/// Build a manifest for `root`. Returns (entries, skipped) where `skipped`
/// is (rel, error) for every file that could not be read — callers surface
/// these instead of silently dropping files from the sync set.
pub fn build_manifest(
    root: &Path,
    cache: &mut HashCache,
) -> (Vec<ManifestEntry>, Vec<(String, String)>) {
    let mut entries = Vec::new();
    let mut skipped = Vec::new();
    for (rel, path) in list_vault_files(root) {
        match cache.hash_file(&path) {
            Ok((size, hash)) => entries.push(ManifestEntry { rel, size, hash }),
            Err(e) => skipped.push((rel, e.to_string())),
        }
    }
    (entries, skipped)
}

/// Serialize a manifest as the wire JSON: {"files":[{"rel","size","hash"}]}.
pub fn manifest_to_json(entries: &[ManifestEntry]) -> String {
    let mut s = String::from("{\"files\":[");
    for (i, e) in entries.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"rel\":{},\"size\":{},\"hash\":\"{}\"}}",
            json_str(&e.rel),
            e.size,
            e.hash
        ));
    }
    s.push_str("]}");
    s
}

// === Diff ================================================================

#[derive(Debug, Default)]
pub struct ManifestDiff {
    /// Present on remote only → create locally.
    pub pull: Vec<String>,
    /// Present locally only → send to remote.
    pub push: Vec<String>,
    /// Present on both sides with differing content → conflict copy.
    pub conflict: Vec<String>,
    /// Present on both sides with identical content.
    pub same: u32,
}

/// Safe two-way diff — mirrors `diffManifests` in src/lib/sync.ts exactly
/// (including output order: remote order for pull/conflict, local for push).
pub fn diff_manifests(local: &[ManifestEntry], remote: &[ManifestEntry]) -> ManifestDiff {
    let l: HashMap<&str, &ManifestEntry> =
        local.iter().map(|e| (e.rel.as_str(), e)).collect();
    let r: HashMap<&str, &ManifestEntry> =
        remote.iter().map(|e| (e.rel.as_str(), e)).collect();
    let mut d = ManifestDiff::default();
    for e in remote {
        match l.get(e.rel.as_str()) {
            None => d.pull.push(e.rel.clone()),
            Some(le) if le.hash != e.hash => d.conflict.push(e.rel.clone()),
            Some(_) => d.same += 1,
        }
    }
    for e in local {
        if !r.contains_key(e.rel.as_str()) {
            d.push.push(e.rel.clone());
        }
    }
    d
}

// === Conflict copies =====================================================

/// Hostname part of a peer base URL ("https://100.64.0.2:8787/x" → "100.64.0.2").
/// Mirrors the host extraction inside `conflictName` in src/lib/sync.ts.
pub fn host_of_base(base: &str) -> String {
    let no_scheme = base
        .strip_prefix("https://")
        .or_else(|| base.strip_prefix("http://"))
        .unwrap_or(base);
    let end = no_scheme
        .find(|c| c == ':' || c == '/')
        .unwrap_or(no_scheme.len());
    no_scheme[..end].to_string()
}

/// Filename for a conflict copy, e.g. "Note (conflict from peer 2026-06-23).md".
/// Mirrors `conflictName` in src/lib/sync.ts; `date` is "YYYY-MM-DD".
pub fn conflict_name(rel: &str, host: &str, date: &str) -> String {
    let tag = format!(" (conflict from {} {})", host, date);
    let dot = rel.rfind('.').map(|i| i as i64).unwrap_or(-1);
    let slash = rel.rfind('/').map(|i| i as i64).unwrap_or(-1);
    if dot > slash {
        let d = dot as usize;
        format!("{}{}{}", &rel[..d], tag, &rel[d..])
    } else {
        format!("{}{}", rel, tag)
    }
}

/// Today as "YYYY-MM-DD" (UTC), matching the TS `toISOString().slice(0,10)`.
pub fn utc_date_string() -> String {
    // Days-since-epoch → civil date (Howard Hinnant's algorithm), no chrono dep.
    let days = (now_ms() / 86_400_000) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

// === Paths & atomic writes ===============================================

/// Join a vault-relative path safely (reject traversal / absolute segments).
pub fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let mut p = root.to_path_buf();
    for seg in rel.replace('\\', "/").split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        p.push(seg);
    }
    Some(p)
}

/// Write `bytes` to `path` atomically: write a sibling temp file, then rename
/// over the destination. A crash or dropped connection mid-transfer can never
/// leave a truncated file in the vault. Creates parent directories as needed.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let tmp = path.with_file_name(format!(
        ".mesa-sync-tmp-{}-{}",
        std::process::id(),
        file_name
    ));
    std::fs::write(&tmp, bytes)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Windows: rename fails when the destination exists. Remove + retry;
            // clean the temp file up if even that fails.
            let _ = std::fs::remove_file(path);
            match std::fs::rename(&tmp, path) {
                Ok(()) => Ok(()),
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp);
                    Err(e)
                }
            }
        }
    }
}

// === Wire helpers ========================================================

/// Minimal JSON string escape.
pub fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Percent-decode a URL query value ('+' becomes a space).
pub fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(byte) => {
                    out.push(byte);
                    i += 3;
                }
                Err(_) => {
                    out.push(b'%');
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Extract one query parameter's decoded value from a raw query string.
pub fn query_param(query: &str, key: &str) -> Option<String> {
    for kv in query.split('&') {
        if let Some((k, v)) = kv.split_once('=') {
            if k == key {
                return Some(url_decode(v));
            }
        }
    }
    None
}

// === Tests ===============================================================
//
// Cross-language vectors: several of these assert the exact same inputs and
// outputs as src/lib/sync.test.ts, pinning the Rust/TS contract.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a_matches_ts_vectors() {
        // Same vectors as src/lib/sync.test.ts.
        assert_eq!(fnv1a_hex(b""), "cbf29ce484222325");
        assert_eq!(fnv1a_hex(b"hello world"), fnv1a_hex(b"hello world"));
        assert_ne!(fnv1a_hex(b"a"), fnv1a_hex(b"b"));
        assert_eq!(fnv1a_hex(b"hello world").len(), 16);
    }

    #[test]
    fn streamed_hash_equals_whole_buffer_hash() {
        let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let whole = fnv1a_hex(&data);
        let mut chunked = Fnv1a::new();
        for chunk in data.chunks(7) {
            chunked.update(chunk);
        }
        assert_eq!(whole, chunked.hex());
    }

    #[test]
    fn hash_file_streams_and_caches() {
        let dir = std::env::temp_dir().join(format!("mesa-core-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.bin");
        std::fs::write(&f, b"hello world").unwrap();
        let (size, hash) = hash_file_streaming(&f).unwrap();
        assert_eq!(size, 11);
        assert_eq!(hash, fnv1a_hex(b"hello world"));

        let mut cache = HashCache::new();
        let first = cache.hash_file(&f).unwrap();
        let second = cache.hash_file(&f).unwrap();
        assert_eq!(first, second);

        // Content change (same length ⇒ relies on mtime; force a distinct one).
        std::fs::write(&f, b"HELLO WORLD").unwrap();
        let newer = std::time::SystemTime::now() + std::time::Duration::from_secs(2);
        let ft = std::fs::File::options().write(true).open(&f).unwrap();
        ft.set_modified(newer).unwrap();
        drop(ft);
        let third = cache.hash_file(&f).unwrap();
        assert_eq!(third.1, fnv1a_hex(b"HELLO WORLD"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_matches_ts_vectors() {
        // Same scenario as src/lib/sync.test.ts "diffManifests".
        let e = |rel: &str, hash: &str| ManifestEntry {
            rel: rel.to_string(),
            hash: hash.to_string(),
            size: hash.len() as u64,
        };
        let local = vec![e("a.md", "1"), e("b.md", "x"), e("local.md", "9")];
        let remote = vec![e("a.md", "1"), e("b.md", "y"), e("remote.md", "7")];
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.pull, vec!["remote.md"]);
        assert_eq!(d.push, vec!["local.md"]);
        assert_eq!(d.conflict, vec!["b.md"]);
        assert_eq!(d.same, 1);

        let m = vec![e("a.md", "1"), e("b.md", "2")];
        let d = diff_manifests(&m, &m.clone());
        assert!(d.pull.is_empty() && d.push.is_empty() && d.conflict.is_empty());
        assert_eq!(d.same, 2);
    }

    #[test]
    fn conflict_name_matches_ts() {
        // Same shape as src/lib/sync.test.ts "conflictName".
        assert_eq!(
            conflict_name("sub/Note.md", "100.64.0.2", "2026-06-23"),
            "sub/Note (conflict from 100.64.0.2 2026-06-23).md"
        );
        assert_eq!(
            conflict_name("README", "host", "2026-06-23"),
            "README (conflict from host 2026-06-23)"
        );
        // A dot in a folder name must not be mistaken for an extension.
        assert_eq!(
            conflict_name("v1.2/notes", "h", "2026-01-01"),
            "v1.2/notes (conflict from h 2026-01-01)"
        );
    }

    #[test]
    fn host_of_base_strips_scheme_port_path() {
        assert_eq!(host_of_base("https://100.64.0.2:8787"), "100.64.0.2");
        assert_eq!(host_of_base("http://mac-mini/x"), "mac-mini");
        assert_eq!(host_of_base("mac-mini:8787"), "mac-mini");
    }

    #[test]
    fn utc_date_string_is_iso_shaped() {
        let d = utc_date_string();
        assert_eq!(d.len(), 10);
        assert_eq!(&d[4..5], "-");
        assert_eq!(&d[7..8], "-");
        assert!(d[..4].parse::<u32>().unwrap() >= 2024);
    }

    #[test]
    fn safe_join_rejects_traversal() {
        let root = Path::new("/vault");
        assert!(safe_join(root, "notes/a.md").is_some());
        assert!(safe_join(root, "../etc/passwd").is_none());
        assert!(safe_join(root, "a/../../b").is_none());
        assert!(safe_join(root, "/abs").is_none());
        assert!(safe_join(root, "").is_none());
        assert!(safe_join(root, "a\\..\\b").is_none());
    }

    #[test]
    fn atomic_write_creates_dirs_and_replaces() {
        let dir = std::env::temp_dir().join(format!("mesa-aw-test-{}", std::process::id()));
        let target = dir.join("deep/nested/n.md");
        atomic_write(&target, b"one").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"one");
        atomic_write(&target, b"two").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"two");
        // No temp litter left behind.
        let litter: Vec<_> = std::fs::read_dir(target.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".mesa-sync-tmp"))
            .collect();
        assert!(litter.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_vault_files_skips_hidden_and_node_modules() {
        let dir = std::env::temp_dir().join(format!("mesa-ls-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::write(dir.join("notes/a.md"), b"a").unwrap();
        std::fs::write(dir.join("b.md"), b"b").unwrap();
        std::fs::write(dir.join(".DS_Store"), b"x").unwrap();
        std::fs::write(dir.join(".git/config"), b"x").unwrap();
        std::fs::write(dir.join("node_modules/pkg/i.js"), b"x").unwrap();
        let rels: Vec<String> = list_vault_files(&dir).into_iter().map(|(r, _)| r).collect();
        assert_eq!(rels, vec!["b.md".to_string(), "notes/a.md".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn manifest_json_escapes() {
        let entries = vec![ManifestEntry {
            rel: "we\"ird\nname.md".to_string(),
            size: 3,
            hash: "abc".to_string(),
        }];
        let j = manifest_to_json(&entries);
        assert_eq!(
            j,
            "{\"files\":[{\"rel\":\"we\\\"ird\\nname.md\",\"size\":3,\"hash\":\"abc\"}]}"
        );
    }

    #[test]
    fn query_param_decodes() {
        assert_eq!(
            query_param("rel=notes%2Fa%20b.md&x=1", "rel").as_deref(),
            Some("notes/a b.md")
        );
        assert_eq!(query_param("rel=a+b", "rel").as_deref(), Some("a b"));
        assert_eq!(query_param("x=1", "rel"), None);
    }
}
