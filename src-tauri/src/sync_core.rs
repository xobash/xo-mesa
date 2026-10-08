#[path = "file_metadata.rs"]
pub(crate) mod file_metadata;
#[path = "sync_fs.rs"]
mod filesystem;
pub use filesystem::*;

#[path = "sync_journal.rs"]
mod journal;
#[path = "sync_paths.rs"]
mod paths;
#[path = "sync_wire.rs"]
mod wire;
pub use journal::*;
pub use paths::*;
pub use wire::*;

// Sync manifests, journals, conflict names, and verified filesystem operations.
// Network transport and TLS identity live in sync.rs.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Keep every ancestor stable until a path-based Windows operation finishes.
/// Denying write/delete sharing also denies junction retargeting and renames.
#[cfg(windows)]
pub struct WindowsParentGuard(Vec<std::fs::File>);

#[cfg(windows)]
impl WindowsParentGuard {
    pub fn acquire(target: &Path, create: bool) -> std::io::Result<Self> {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
        };
        if !target.is_absolute() {
            return Err(invalid_data("sync path must be absolute"));
        }
        let parent = target
            .parent()
            .ok_or_else(|| invalid_data("sync path has no parent"))?;
        let mut path = PathBuf::new();
        let mut handles = Vec::new();
        for component in parent.components() {
            path.push(component.as_os_str());
            if matches!(component, std::path::Component::Prefix(_)) {
                continue;
            }
            let open = || {
                std::fs::OpenOptions::new()
                    .access_mode(FILE_READ_ATTRIBUTES)
                    .share_mode(FILE_SHARE_READ)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(&path)
            };
            let handle = match open() {
                Err(error) if create && error.kind() == std::io::ErrorKind::NotFound => {
                    match std::fs::create_dir(&path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                        Err(error) => return Err(error),
                    }
                    open()?
                }
                result => result?,
            };
            let metadata = handle.metadata()?;
            if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
                return Err(invalid_data("sync ancestor is not a real directory"));
            }
            handles.push(handle);
        }
        Ok(Self(handles))
    }
}

#[cfg(windows)]
impl Drop for WindowsParentGuard {
    fn drop(&mut self) {
        // Descendants release before their ancestors.
        while self.0.pop().is_some() {}
    }
}

pub fn open_file_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        let _parents = WindowsParentGuard::acquire(path, false)?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 {
            return Err(invalid_data("sync input is not a regular file"));
        }
        Ok(file)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)?;
        if !file.metadata()?.is_file() {
            return Err(invalid_data("sync input is not a regular file"));
        }
        Ok(file)
    }
    #[cfg(not(any(windows, unix)))]
    {
        std::fs::File::open(path)
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Stable walker output: vault-relative spelling and the corresponding path.
pub type VaultPath = (String, PathBuf);
/// A completed manifest plus read failures that the caller must surface.
pub type ManifestBuild = (Vec<ManifestEntry>, Vec<(String, String)>);
type VaultWalk = (Vec<VaultPath>, Vec<(String, String)>);

// === Hashing =============================================================

/// SHA-256 content identity shared by manifests, transfers and journal guards.
pub struct ContentHasher(Sha256);
impl ContentHasher {
    pub fn new() -> Self {
        Self(Sha256::new())
    }
    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }
    pub fn hex(&self) -> String {
        format!("{:x}", self.0.clone().finalize())
    }
}
#[cfg(test)]
pub fn content_hash_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Hash a file by streaming 64 KiB chunks — never loads the file into memory.
/// Returns (size, hash).
pub fn hash_file_streaming(path: &Path) -> std::io::Result<(u64, String)> {
    hash_file_streaming_until(path, None).unwrap_or_else(|| {
        Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "hash cancelled",
        ))
    })
}

/// Stream a file without allocating it whole. When cancellation is supplied,
/// return `None` at the next 64 KiB boundary so sync can return control without
/// publishing a partial manifest.
fn hash_file_streaming_until(
    path: &Path,
    cancelled: Option<&AtomicBool>,
) -> Option<std::io::Result<(u64, String)>> {
    let file = match open_file_no_follow(path) {
        Ok(file) => file,
        Err(error) => return Some(Err(error)),
    };
    hash_open_file_until(file, cancelled)
}

#[cfg(unix)]
fn hash_rooted_file_until(
    root: &Path,
    rel: &str,
    cancelled: Option<&AtomicBool>,
) -> Option<std::io::Result<(u64, String)>> {
    let file = match RootedTarget::resolve(root, rel, false).and_then(|target| target.open_read()) {
        Ok(file) => file,
        Err(error) => return Some(Err(error)),
    };
    hash_open_file_until(file, cancelled)
}

fn hash_open_file_until(
    mut file: std::fs::File,
    cancelled: Option<&AtomicBool>,
) -> Option<std::io::Result<(u64, String)>> {
    let mut hasher = ContentHasher::new();
    let mut buf = [0u8; 64 * 1024];
    let mut size: u64 = 0;
    loop {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        let n = match file.read(&mut buf) {
            Ok(n) => n,
            Err(error) => return Some(Err(error)),
        };
        if n == 0 {
            break;
        }
        size += n as u64;
        hasher.update(&buf[..n]);
    }
    Some(Ok((size, hasher.hex())))
}

// === Vault walking =======================================================

/// Files/dirs sync ignores. Matches the frontend vault walker
/// (`src/lib/vault.ts` `walk`): dot-prefixed names (covers `.git`,
/// `.obsidian`, `.DS_Store`) and `node_modules`.
pub fn ignored_name(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

/// Peer-facing sync path policy: everything `safe_join` accepts, minus any
/// segment the vault walk ignores. Peers may never read or change `.git/`,
/// `.obsidian/`, `.mesa-trash/`, the journal or `node_modules`; Mesa's own
/// recovery paths use `safe_join` directly and never come from a peer.
pub fn is_peer_rel(rel: &str) -> bool {
    safe_join(Path::new("."), rel).is_some() && !rel.split('/').any(ignored_name)
}

/// `safe_join_confined` restricted to `is_peer_rel` paths.
pub fn peer_join_confined(root: &Path, rel: &str) -> Option<PathBuf> {
    if !is_peer_rel(rel) {
        return None;
    }
    safe_join_confined(root, rel)
}

/// Recursively list every syncable file under `root` as
/// (vault-relative path with forward slashes, absolute path), sorted by rel
/// path for deterministic manifests. The compatibility helper keeps its old
/// file-only shape for tests; production callers use the error-carrying walk
/// below and must treat any error as incomplete coverage.
#[cfg(test)]
pub fn list_vault_files(root: &Path) -> Vec<VaultPath> {
    list_vault_files_with_errors_until(root, None)
        .map(|(files, _)| files)
        .unwrap_or_default()
}

#[cfg(not(unix))]
fn rel_for_error(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .filter(|rel| !rel.is_empty())
        .unwrap_or_else(|| ".".to_string())
}

fn list_vault_files_with_errors_until(
    root: &Path,
    cancelled: Option<&AtomicBool>,
) -> Option<VaultWalk> {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    let mut names = Vec::new();
    #[cfg(unix)]
    let completed = match RootedTarget::open_root_dir(root) {
        Ok(root_dir) => walk_rooted(
            root,
            &root_dir,
            "",
            &mut out,
            &mut names,
            &mut errors,
            cancelled,
        ),
        Err(error) => {
            errors.push((".".to_string(), format!("open vault root failed: {error}")));
            true
        }
    };
    #[cfg(not(unix))]
    let completed = walk(root, root, &mut out, &mut names, &mut errors, cancelled);
    if !completed {
        return None;
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    // Check directories as well as files: differently cased folder names can
    // collide even when their contained file names differ.
    let mut seen = std::collections::HashMap::<String, String>::new();
    for rel in &names {
        let key = rel.to_lowercase();
        if let Some(first) = seen.get(&key) {
            if first != rel {
                errors.push((
                    first.clone(),
                    format!("portable name collision with {rel:?}"),
                ));
                errors.push((
                    rel.clone(),
                    format!("portable name collision with {first:?}"),
                ));
            }
        } else {
            seen.insert(key, rel.clone());
        }
    }
    Some((out, errors))
}

#[cfg(not(unix))]
fn walk(
    root: &Path,
    dir: &Path,
    out: &mut Vec<VaultPath>,
    names: &mut Vec<String>,
    errors: &mut Vec<(String, String)>,
    cancelled: Option<&AtomicBool>,
) -> bool {
    #[cfg(windows)]
    let _parents = match WindowsParentGuard::acquire(&dir.join("candidate"), false) {
        Ok(guard) => guard,
        Err(error) => {
            errors.push((
                rel_for_error(root, dir),
                format!("lock directory failed: {error}"),
            ));
            return true;
        }
    };

    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return false;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(error) => {
            errors.push((
                rel_for_error(root, dir),
                format!("read directory failed: {error}"),
            ));
            return true;
        }
    };
    for entry in rd {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return false;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                errors.push((
                    rel_for_error(root, dir),
                    format!("read directory entry failed: {error}"),
                ));
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if ignored_name(&name) {
            continue;
        }
        let path = entry.path();
        let rel = rel_for_error(root, &path);
        if safe_join(root, &rel).is_none() {
            errors.push((
                rel,
                "name cannot sync to Windows; rename this file or folder before syncing"
                    .to_string(),
            ));
            continue;
        }
        names.push(rel);
        let ftype = match entry.file_type() {
            Ok(t) => t,
            Err(error) => {
                errors.push((
                    rel_for_error(root, &path),
                    format!("file type failed: {error}"),
                ));
                continue;
            }
        };
        if ftype.is_dir() {
            if !walk(root, &path, out, names, errors, cancelled) {
                return false;
            }
        } else if ftype.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                out.push((rel, path));
            }
        }
    }
    true
}

#[cfg(unix)]
fn walk_rooted(
    root: &Path,
    dir: &std::fs::File,
    prefix: &str,
    out: &mut Vec<VaultPath>,
    names: &mut Vec<String>,
    errors: &mut Vec<(String, String)>,
    cancelled: Option<&AtomicBool>,
) -> bool {
    use std::os::fd::{AsRawFd, FromRawFd};
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return false;
    }
    let children = match RootedTarget::list_dir_names(dir) {
        Ok(children) => children,
        Err(error) => {
            errors.push((
                if prefix.is_empty() {
                    ".".to_string()
                } else {
                    prefix.to_string()
                },
                format!("read directory failed: {error}"),
            ));
            return true;
        }
    };
    for name in children {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return false;
        }
        if ignored_name(&name) {
            continue;
        }
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if safe_join(root, &rel).is_none() {
            errors.push((
                rel,
                "name cannot sync to Windows; rename this file or folder before syncing"
                    .to_string(),
            ));
            continue;
        }
        let cname = match std::ffi::CString::new(name) {
            Ok(name) => name,
            Err(_) => {
                errors.push((rel, "name contains NUL".to_string()));
                continue;
            }
        };
        // SAFETY: libc::stat is a plain C output structure; zero initialization is valid before fstatat fills it.
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: dir stays open, cname is NUL-terminated, and stat is writable for this call.
        if unsafe {
            libc::fstatat(
                dir.as_raw_fd(),
                cname.as_ptr(),
                &mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } < 0
        {
            errors.push((
                rel,
                format!("file type failed: {}", std::io::Error::last_os_error()),
            ));
            continue;
        }
        names.push(rel.clone());
        match stat.st_mode & libc::S_IFMT {
            libc::S_IFDIR => {
                // SAFETY: dir stays open and cname is NUL-terminated; O_NOFOLLOW rejects symlink directories.
                let raw = unsafe {
                    libc::openat(
                        dir.as_raw_fd(),
                        cname.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if raw < 0 {
                    errors.push((
                        rel,
                        format!("open directory failed: {}", std::io::Error::last_os_error()),
                    ));
                    continue;
                }
                // SAFETY: openat returned a nonnegative descriptor that has not been transferred or closed.
                let child = unsafe { std::fs::File::from_raw_fd(raw) };
                if !walk_rooted(root, &child, &rel, out, names, errors, cancelled) {
                    return false;
                }
            }
            libc::S_IFREG => out.push((rel.clone(), root.join(rel))),
            _ => {}
        }
    }
    true
}

// === Manifest ============================================================

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ManifestEntry {
    pub rel: String,
    pub size: u64,
    pub hash: String,
}

/// Below this many files hashing stays inline to avoid thread startup costs.
const PARALLEL_HASH_MIN_FILES: usize = 8;

/// Hashing threads. Keep a small application-owned budget so a cold sync does
/// not consume every core needed by editing, PDF rendering, or Pi.
fn hash_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(2)
}

/// `(index into files, streamed hash result)`.
type HashOutcome = (usize, std::io::Result<(u64, String)>);

/// Read every file within the application-owned worker budget. Metadata and
/// watcher events cannot prove content equality on every supported filesystem.
/// Always obtain fresh bytes for manifest, baseline and journal decisions.
///
/// Each file uses streaming SHA-256. Independent files share a bounded worker
/// queue; every digest matches the serial reference regardless of scheduling.
fn hash_manifest_files(
    root: &Path,
    files: &[(String, PathBuf)],
    cancelled: Option<&AtomicBool>,
) -> Option<Vec<HashOutcome>> {
    #[cfg(not(unix))]
    let _ = root;
    let threads = hash_threads().min(files.len());
    if files.len() < PARALLEL_HASH_MIN_FILES || threads <= 1 {
        let mut outcomes = Vec::with_capacity(files.len());
        for (i, (_rel, _path)) in files.iter().enumerate() {
            #[cfg(unix)]
            let result = hash_rooted_file_until(root, _rel, cancelled)?;
            #[cfg(not(unix))]
            let result = hash_file_streaming_until(_path, cancelled)?;
            outcomes.push((i, result));
        }
        return Some(outcomes);
    }
    let cursor = AtomicUsize::new(0);
    let collected: Option<Vec<Vec<HashOutcome>>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                let cursor = &cursor;
                s.spawn(move || {
                    let mut local = Vec::new();
                    loop {
                        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                            return None;
                        }
                        let n = cursor.fetch_add(1, Ordering::Relaxed);
                        if n >= files.len() {
                            break;
                        }
                        let i = n;
                        #[cfg(unix)]
                        let result = hash_rooted_file_until(root, &files[i].0, cancelled)?;
                        #[cfg(not(unix))]
                        let result = hash_file_streaming_until(&files[i].1, cancelled)?;
                        local.push((i, result));
                    }
                    Some(local)
                })
            })
            .collect();
        handles
            .into_iter()
            // A panicking hash thread would poison the whole manifest; there is
            // nothing in `hash_file_streaming` that panics on I/O (errors come
            // back as `Err`), so propagate rather than silently dropping files.
            .map(|h| h.join().expect("hash thread panicked"))
            .collect::<Option<Vec<_>>>()
    });
    Some(collected?.into_iter().flatten().collect())
}

/// Build a manifest for `root`. Returns (entries, skipped) where `skipped`
/// is (rel, error) for every file that could not be read — callers surface
/// these instead of silently dropping files from the sync set.
///
/// Both outputs stay in `list_vault_files` rel order regardless of the order
/// the hashing threads finish in, so the serialized manifest is deterministic.
pub fn build_manifest(root: &Path) -> ManifestBuild {
    build_manifest_until(root, None).expect("uncancelled manifest must complete")
}

/// Cancellation-aware manifest build for the client sync path. `None` means
/// the caller requested cancellation; no partial manifest is returned.
pub fn build_manifest_cancellable(root: &Path, cancelled: &AtomicBool) -> Option<ManifestBuild> {
    build_manifest_until(root, Some(cancelled))
}

fn build_manifest_until(root: &Path, cancelled: Option<&AtomicBool>) -> Option<ManifestBuild> {
    let (files, mut skipped) = list_vault_files_with_errors_until(root, cancelled)?;
    let mut resolved: Vec<Option<std::io::Result<(u64, String)>>> =
        (0..files.len()).map(|_| None).collect();
    for (i, result) in hash_manifest_files(root, &files, cancelled)? {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        resolved[i] = Some(result);
    }

    let mut entries = Vec::with_capacity(files.len());
    for ((rel, _), slot) in files.into_iter().zip(resolved) {
        match slot {
            Some(Ok((size, hash))) => entries.push(ManifestEntry { rel, size, hash }),
            // `None` is unreachable: every work item is written back above.
            None => skipped.push((rel, "hash not computed".to_string())),
            Some(Err(e)) => skipped.push((rel, e.to_string())),
        }
    }
    Some((entries, skipped))
}

/// Serialize a manifest as the wire JSON: {"files":[{"rel","size","hash"}]}.
pub fn manifest_to_json(entries: &[ManifestEntry]) -> String {
    let mut s = format!("{{\"journalVersion\":{JOURNAL_VERSION},\"syncProtocolVersion\":{SYNC_PROTOCOL_VERSION},\"files\":[");
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
    /// Remote changed since the shared base; local still has base bytes.
    pub pull_replace: Vec<String>,
    /// Local changed since the shared base; remote still has base bytes.
    pub push_replace: Vec<String>,
    /// Present on both sides with differing content → conflict copy.
    pub conflict: Vec<String>,
    /// Present on both sides with identical content.
    pub same: u32,
}

pub fn diff_manifests_from_base(
    local: &[ManifestEntry],
    remote: &[ManifestEntry],
    base: &[JournalEntry],
) -> ManifestDiff {
    let l: HashMap<&str, &ManifestEntry> = local.iter().map(|e| (e.rel.as_str(), e)).collect();
    let r: HashMap<&str, &ManifestEntry> = remote.iter().map(|e| (e.rel.as_str(), e)).collect();
    let b: HashMap<&str, &JournalEntry> = base.iter().map(|e| (e.rel.as_str(), e)).collect();
    let mut d = ManifestDiff::default();
    for e in remote {
        match l.get(e.rel.as_str()) {
            None => d.pull.push(e.rel.clone()),
            Some(le) if le.size != e.size || le.hash != e.hash => match b.get(e.rel.as_str()) {
                Some(previous) if previous.size == le.size && previous.hash == le.hash => {
                    d.pull_replace.push(e.rel.clone())
                }
                Some(previous) if previous.size == e.size && previous.hash == e.hash => {
                    d.push_replace.push(e.rel.clone())
                }
                _ => d.conflict.push(e.rel.clone()),
            },
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

pub fn common_baseline(local: &[ManifestEntry], remote: &[ManifestEntry]) -> Vec<JournalEntry> {
    let remote_by_rel: HashMap<&str, &ManifestEntry> = remote
        .iter()
        .map(|entry| (entry.rel.as_str(), entry))
        .collect();
    local
        .iter()
        .filter_map(|entry| {
            remote_by_rel
                .get(entry.rel.as_str())
                .filter(|other| other.size == entry.size && other.hash == entry.hash)
                .map(|_| JournalEntry {
                    rel: entry.rel.clone(),
                    size: entry.size,
                    hash: entry.hash.clone(),
                })
        })
        .collect()
}

// === Conflict copies =====================================================

/// Filesystem-safe host label from a peer base URL.
pub fn host_of_base(base: &str) -> String {
    let url = if base.contains("://") {
        base.to_string()
    } else {
        format!("https://{base}")
    };
    url::Url::parse(&url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "peer".into())
        .trim_matches(['[', ']'])
        .replace([':', '%'], "-")
}

pub fn conflict_source(name: &str, fallback: &str) -> String {
    let label: String = name
        .chars()
        .filter(|ch| ch.is_alphanumeric() || matches!(ch, ' ' | '-' | '_'))
        .take(40)
        .collect();
    let label = label.trim();
    if label.is_empty() {
        fallback.to_string()
    } else {
        label.to_string()
    }
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

// === Paths & verified commits ============================================
