// sync_core.rs — dependency-light sync logic.
//
// This stays independent of tauri / reqwest / rustls / tiny_http. The only
// platform bindings are libc and windows-sys for atomic no-replace rename.
// That keeps it unit-testable with `cargo test` and makes the cross-language
// contract explicit: `fnv1a_hex`, `diff_manifests`, and `conflict_name` MUST
// stay byte-for-byte compatible with their reference twins in `src/lib/sync.ts`
// (which pin the same vectors in vitest).
//
// The impure halves — TLS identity, the HTTPS server, the pinned client, and
// the `sync_run` engine — live in `sync.rs` and call into this module.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};

/// Hidden, vault-local state for delete/rename replication.  It is deliberately
/// outside the normal manifest: syncing the journal as an ordinary vault file
/// would make it visible to users and let one device overwrite another's log.
pub const JOURNAL_FILE: &str = ".mesa-sync-journal.json";
const JOURNAL_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct JournalEntry {
    pub rel: String,
    pub size: u64,
    pub hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct JournalOperation {
    pub id: String,
    pub device: String,
    pub sequence: u64,
    pub at_ms: u64,
    #[serde(rename = "kind")]
    pub kind: JournalOperationKind,
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub size: u64,
    pub hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JournalOperationKind { Delete, Rename }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncJournal {
    pub version: u32,
    pub device: String,
    pub next_sequence: u64,
    pub operations: Vec<JournalOperation>,
    #[serde(default)]
    pub applied: Vec<String>,
    /// The last known vault manifest lets the next sync reconstruct an action
    /// after a crash or an edit made outside Mesa.
    pub known: Vec<JournalEntry>,
}

impl SyncJournal {
    fn empty(device: String) -> Self {
        Self { version: JOURNAL_VERSION, device, next_sequence: 1, operations: Vec::new(), applied: Vec::new(), known: Vec::new() }
    }
}

fn journal_path(root: &Path) -> PathBuf { root.join(JOURNAL_FILE) }

fn journal_device(root: &Path) -> String {
    // This is only an operation-origin identifier, never an authentication
    // credential. It is persisted in the journal and combined with a sequence.
    format!("{:x}-{:x}", std::process::id(), now_ms() ^ root.to_string_lossy().bytes().fold(0u64, |a, b| a.wrapping_mul(33).wrapping_add(b as u64)))
}

pub fn load_journal(root: &Path) -> std::io::Result<SyncJournal> {
    let path = journal_path(root);
    let body = match std::fs::read(&path) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(SyncJournal::empty(journal_device(root))),
        Err(error) => return Err(error),
    };
    let journal: SyncJournal = serde_json::from_slice(&body).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, format!("invalid Mesa sync journal: {error}")))?;
    if journal.version != JOURNAL_VERSION || journal.device.is_empty() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "unsupported Mesa sync journal"));
    }
    Ok(journal)
}

/// Atomically replace Mesa's own metadata. A crash leaves either the prior
/// complete journal or the complete new journal; the uniquely named temp is
/// ignored and can never enter a vault scan or sync manifest.
pub fn save_journal(root: &Path, journal: &SyncJournal) -> std::io::Result<()> {
    let path = journal_path(root);
    let tmp = root.join(format!(".mesa-sync-journal-{:x}.tmp", now_ms()));
    let bytes = serde_json::to_vec(journal).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn append_operation(journal: &mut SyncJournal, kind: JournalOperationKind, from: String, to: Option<String>, size: u64, hash: String) {
    if journal.operations.iter().any(|op| op.kind == kind && op.from == from && op.to == to && op.size == size && op.hash.eq_ignore_ascii_case(&hash)) { return; }
    let sequence = journal.next_sequence;
    journal.next_sequence = journal.next_sequence.saturating_add(1);
    let device = journal.device.clone();
    journal.operations.push(JournalOperation { id: format!("{device}:{sequence}"), device, sequence, at_ms: now_ms(), kind, from, to, size, hash });
}

/// Reconcile the durable snapshot with the current manifest. A deleted entry
/// becomes a tombstone. A unique same-byte disappearance/appearance becomes a
/// rename; ambiguous copies deliberately remain delete + add so content is not
/// guessed away.
pub fn reconcile_journal(root: &Path, manifest: &[ManifestEntry]) -> std::io::Result<SyncJournal> {
    let mut journal = load_journal(root)?;
    let current: HashMap<&str, &ManifestEntry> = manifest.iter().map(|entry| (entry.rel.as_str(), entry)).collect();
    let local_device = journal.device.clone();
    journal.operations.retain(|op| {
        if op.device != local_device {
            return true;
        }
        let Some(entry) = current.get(op.from.as_str()) else {
            return true;
        };
        !(entry.size == op.size && entry.hash.eq_ignore_ascii_case(&op.hash))
    });
    let old: HashMap<&str, &JournalEntry> = journal.known.iter().map(|entry| (entry.rel.as_str(), entry)).collect();
    let mut added: Vec<&ManifestEntry> = manifest.iter().filter(|entry| !old.contains_key(entry.rel.as_str())).collect();
    let prior_known = journal.known.clone();
    for entry in &prior_known {
        if current.contains_key(entry.rel.as_str()) { continue; }
        let matches: Vec<usize> = added.iter().enumerate().filter_map(|(index, candidate)| (candidate.size == entry.size && candidate.hash.eq_ignore_ascii_case(&entry.hash)).then_some(index)).collect();
        if matches.len() == 1 {
            let candidate = added.swap_remove(matches[0]);
            append_operation(&mut journal, JournalOperationKind::Rename, entry.rel.clone(), Some(candidate.rel.clone()), entry.size, entry.hash.clone());
        } else {
            append_operation(&mut journal, JournalOperationKind::Delete, entry.rel.clone(), None, entry.size, entry.hash.clone());
        }
    }
    journal.known = manifest.iter().map(|entry| JournalEntry { rel: entry.rel.clone(), size: entry.size, hash: entry.hash.clone() }).collect();
    save_journal(root, &journal)?;
    Ok(journal)
}

pub fn merge_journal(root: &Path, remote: &SyncJournal) -> std::io::Result<SyncJournal> {
    if remote.version != JOURNAL_VERSION { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "unsupported peer sync journal")); }
    let mut local = load_journal(root)?;
    for op in &remote.operations {
        if !local.operations.iter().any(|existing| existing.id == op.id) { local.operations.push(op.clone()); }
    }
    local.operations.sort_by(|a, b| a.id.cmp(&b.id));
    save_journal(root, &local)?;
    Ok(local)
}

#[derive(Debug, PartialEq, Eq)]
pub enum JournalApply { Applied, AlreadyApplied, Conflict }

fn move_no_replace(from: &Path, to: &Path, size: u64, hash: &str) -> std::io::Result<()> {
    if let Some(parent) = to.parent() { std::fs::create_dir_all(parent)?; }
    match publish_candidate(&StdCommitFs, from, to)? {
        PublishMethod::ExclusiveRename => {}
        PublishMethod::HardLink => { std::fs::remove_file(from)?; }
    }
    let actual = hash_file_streaming(to)?;
    if fingerprint_matches(&actual, size, hash) { Ok(()) } else { Err(invalid_data("journal move failed final verification")) }
}

/// Apply a remote operation only when its old content still matches exactly.
/// A concurrent local edit is retained and reported as a conflict; deletion
/// therefore never silently wins over user content.
pub fn apply_journal_operation(root: &Path, op: &JournalOperation) -> std::io::Result<JournalApply> {
    let from = safe_join(root, &op.from).ok_or_else(|| invalid_data("unsafe journal source"))?;
    match op.kind {
        JournalOperationKind::Delete => match hash_file_streaming(&from) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(JournalApply::AlreadyApplied),
            Err(error) => Err(error),
            Ok(actual) if !fingerprint_matches(&actual, op.size, &op.hash) => Ok(JournalApply::Conflict),
            Ok(_) => {
                let tomb = from.with_file_name(format!(".{}.mesa-sync-delete-{:x}", from.file_name().and_then(|name| name.to_str()).unwrap_or("file"), now_ms()));
                std::fs::rename(&from, &tomb)?;
                let moved = hash_file_streaming(&tomb)?;
                if !fingerprint_matches(&moved, op.size, &op.hash) { return Ok(JournalApply::Conflict); }
                std::fs::remove_file(&tomb)?;
                Ok(JournalApply::Applied)
            }
        },
        JournalOperationKind::Rename => {
            let Some(to_rel) = op.to.as_deref() else { return Err(invalid_data("rename journal entry missing destination")); };
            let to = safe_join(root, to_rel).ok_or_else(|| invalid_data("unsafe journal destination"))?;
            match (hash_file_streaming(&from), hash_file_streaming(&to)) {
                (Err(from_error), Ok(target)) if from_error.kind() == std::io::ErrorKind::NotFound && fingerprint_matches(&target, op.size, &op.hash) => Ok(JournalApply::AlreadyApplied),
                (Err(from_error), Err(to_error)) if from_error.kind() == std::io::ErrorKind::NotFound && to_error.kind() == std::io::ErrorKind::NotFound => Ok(JournalApply::Conflict),
                (Ok(source), Err(target_error)) if target_error.kind() == std::io::ErrorKind::NotFound && fingerprint_matches(&source, op.size, &op.hash) => { move_no_replace(&from, &to, op.size, &op.hash)?; Ok(JournalApply::Applied) }
                (Ok(source), Ok(target)) if fingerprint_matches(&source, op.size, &op.hash) && fingerprint_matches(&target, op.size, &op.hash) => { std::fs::remove_file(&from)?; Ok(JournalApply::AlreadyApplied) }
                _ => Ok(JournalApply::Conflict),
            }
        }
    }
}

/// Stable walker output: vault-relative spelling and the corresponding path.
pub type VaultPath = (String, PathBuf);
/// A completed manifest plus read failures that the caller must surface.
pub type ManifestBuild = (Vec<ManifestEntry>, Vec<(String, String)>);

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
#[cfg(test)]
pub fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut f = Fnv1a::new();
    f.update(bytes);
    f.hex()
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
fn hash_file_streaming_until(path: &Path, cancelled: Option<&AtomicBool>) -> Option<std::io::Result<(u64, String)>> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) => return Some(Err(error)),
    };
    let mut hasher = Fnv1a::new();
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

// === Hash cache ==========================================================

/// Outcome of consulting the cache for one file, without reading its contents.
pub enum CacheProbe {
    /// `(size, hash)` answered from the cache — the file is not read at all.
    Hit(u64, String),
    /// The file must be hashed. Carries the mtime observed BEFORE hashing,
    /// which is what gets stored alongside the new digest: if the file changes
    /// while it is being read, the stored mtime is already stale and the next
    /// build re-hashes it rather than trusting a torn digest.
    Miss(u128),
}

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

    /// Metadata-only cache probe. Cheap enough to run over a whole vault
    /// serially (~13 ms for 4,094 files) before any file is opened, which is
    /// what lets `build_manifest` hash only the misses, and hash them in
    /// parallel.
    pub fn probe(&self, path: &Path) -> std::io::Result<CacheProbe> {
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
                return Ok(CacheProbe::Hit(size, h.clone()));
            }
        }
        Ok(CacheProbe::Miss(mtime_ns))
    }

    /// Record a freshly computed digest. `size` is the byte count the streaming
    /// read actually saw, `mtime_ns` the pre-hash mtime from `probe`.
    pub fn store(&mut self, path: &Path, size: u64, mtime_ns: u128, hash: &str) {
        self.entries
            .insert(path.to_path_buf(), (size, mtime_ns, hash.to_string()));
    }

    /// Keep cache ownership bounded to the current vault snapshot. This also
    /// removes renamed/deleted paths instead of retaining them for the life of
    /// the process. A hard cap protects a vault with unusually many files.
    pub fn prune(&mut self, live: &[PathBuf], max_entries: usize) {
        let live: std::collections::HashSet<&Path> = live.iter().map(PathBuf::as_path).collect();
        self.entries.retain(|path, _| live.contains(path.as_path()));
        if self.entries.len() > max_entries {
            let remove = self.entries.len() - max_entries;
            let keys: Vec<PathBuf> = self.entries.keys().take(remove).cloned().collect();
            for key in keys { self.entries.remove(&key); }
        }
    }

    /// (size, hash) of `path`, re-hashing only when size or mtime changed.
    /// `build_manifest` does not call this — it splits the same two steps so
    /// the reads can run in parallel — but it is the reference definition of
    /// what that split must add up to, and the tests hold it to that.
    #[cfg(test)]
    pub fn hash_file(&mut self, path: &Path) -> std::io::Result<(u64, String)> {
        match self.probe(path)? {
            CacheProbe::Hit(size, hash) => Ok((size, hash)),
            CacheProbe::Miss(mtime_ns) => {
                let (real_size, hash) = hash_file_streaming(path)?;
                self.store(path, real_size, mtime_ns, &hash);
                Ok((real_size, hash))
            }
        }
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
#[cfg(test)]
pub fn list_vault_files(root: &Path) -> Vec<VaultPath> {
    list_vault_files_until(root, None).unwrap_or_default()
}

fn list_vault_files_until(root: &Path, cancelled: Option<&AtomicBool>) -> Option<Vec<VaultPath>> {
    let mut out = Vec::new();
    if !walk(root, root, &mut out, cancelled) {
        return None;
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Some(out)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<VaultPath>, cancelled: Option<&AtomicBool>) -> bool {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return false;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return true,
    };
    for entry in rd.flatten() {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return false;
        }
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
            if !walk(root, &path, out, cancelled) {
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

// === Manifest ============================================================

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ManifestEntry {
    pub rel: String,
    pub size: u64,
    pub hash: String,
}

/// Below this many cache misses the hashing stays inline: spawning threads
/// costs more than it saves, and the common warm-cache build has zero misses.
const PARALLEL_HASH_MIN_FILES: usize = 8;

/// Hashing threads. Keep a small application-owned budget so a cold sync does
/// not consume every core needed by editing, PDF rendering, or Pi.
fn hash_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(2)
}

/// `(index into files, pre-hash mtime, streamed hash result)`.
type HashOutcome = (usize, u128, std::io::Result<(u64, String)>);

/// Hash `work` (indices into `files`, each with its pre-hash mtime) within the
/// application-owned worker budget, returning `(index, mtime_ns, result)` per
/// item in completion order.
///
/// FNV-1a/64 is a strictly serial recurrence — `h = (h ^ byte) * prime` — so a
/// single file's digest cannot be computed in parallel. Whole FILES are
/// independent though, and a manifest is thousands of them, so the parallelism
/// goes there. Every digest is still produced by the same `hash_file_streaming`
/// over the same bytes, so the wire hashes are byte-identical to the serial
/// build; only the order the work is dispatched in changes.
///
/// Files vary from empty to 39 MB in the reference vault, so threads pull from
/// a shared atomic cursor rather than taking a fixed slice — a static split
/// would leave one thread holding the large tail while the rest idled.
fn hash_missing(files: &[(String, PathBuf)], work: &[(usize, u128)], cancelled: Option<&AtomicBool>) -> Option<Vec<HashOutcome>> {
    let threads = hash_threads().min(work.len());
    if work.len() < PARALLEL_HASH_MIN_FILES || threads <= 1 {
        let mut outcomes = Vec::with_capacity(work.len());
        for &(i, mtime) in work {
            let result = hash_file_streaming_until(&files[i].1, cancelled)?;
            outcomes.push((i, mtime, result));
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
                        if n >= work.len() {
                            break;
                        }
                        let (i, mtime) = work[n];
                        let result = hash_file_streaming_until(&files[i].1, cancelled)?;
                        local.push((i, mtime, result));
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
pub fn build_manifest(
    root: &Path,
    cache: &mut HashCache,
) -> ManifestBuild {
    build_manifest_until(root, cache, None).expect("uncancelled manifest must complete")
}

/// Cancellation-aware manifest build for the client sync path. `None` means
/// the caller requested cancellation; no partial manifest is returned.
pub fn build_manifest_cancellable(
    root: &Path,
    cache: &mut HashCache,
    cancelled: &AtomicBool,
) -> Option<ManifestBuild> {
    build_manifest_until(root, cache, Some(cancelled))
}

fn build_manifest_until(
    root: &Path,
    cache: &mut HashCache,
    cancelled: Option<&AtomicBool>,
) -> Option<ManifestBuild> {
    let files = list_vault_files_until(root, cancelled)?;
    cache.prune(
        &files.iter().map(|(_, path)| path.clone()).collect::<Vec<_>>(),
        4096,
    );

    // Phase 1 — serial, metadata only. Resolves every file the cache already
    // knows without opening it, and collects the rest as work items.
    let mut resolved: Vec<Result<Option<(u64, String)>, String>> = Vec::with_capacity(files.len());
    let mut work: Vec<(usize, u128)> = Vec::new();
    for (i, (_, path)) in files.iter().enumerate() {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        match cache.probe(path) {
            Ok(CacheProbe::Hit(size, hash)) => resolved.push(Ok(Some((size, hash)))),
            Ok(CacheProbe::Miss(mtime_ns)) => {
                work.push((i, mtime_ns));
                resolved.push(Ok(None));
            }
            Err(e) => resolved.push(Err(e.to_string())),
        }
    }

    // Phase 2 — read and hash the misses across all cores.
    let hashed = hash_missing(&files, &work, cancelled)?;

    // Phase 3 — fold results back into rel order and update the cache.
    for (i, mtime_ns, result) in hashed {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        resolved[i] = match result {
            Ok((real_size, hash)) => {
                cache.store(&files[i].1, real_size, mtime_ns, &hash);
                Ok(Some((real_size, hash)))
            }
            Err(e) => Err(e.to_string()),
        };
    }

    let mut entries = Vec::with_capacity(files.len());
    let mut skipped = Vec::new();
    for ((rel, _), slot) in files.into_iter().zip(resolved) {
        match slot {
            Ok(Some((size, hash))) => entries.push(ManifestEntry { rel, size, hash }),
            // `None` is unreachable: every work item is written back above.
            Ok(None) => skipped.push((rel, "hash not computed".to_string())),
            Err(e) => skipped.push((rel, e)),
        }
    }
    Some((entries, skipped))
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
    let l: HashMap<&str, &ManifestEntry> = local.iter().map(|e| (e.rel.as_str(), e)).collect();
    let r: HashMap<&str, &ManifestEntry> = remote.iter().map(|e| (e.rel.as_str(), e)).collect();
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
    let end = no_scheme.find([':', '/']).unwrap_or(no_scheme.len());
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

// === Paths & verified commits ============================================

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitOutcome {
    Created,
    Unchanged,
}

static ARTIFACT_COUNTER: AtomicU64 = AtomicU64::new(0);

fn artifact_token() -> (u64, String) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let counter = ARTIFACT_COUNTER.fetch_add(1, Ordering::Relaxed);
    (
        stamp,
        format!("s{:x}{:x}{:x}", std::process::id(), stamp, counter),
    )
}

fn candidate_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let (stamp, token) = artifact_token();
    path.with_file_name(format!(
        ".mesa-sync-tmp-{}-{stamp}-{token}-{file_name}",
        std::process::id()
    ))
}

fn collision_error(path: &Path) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!(
            "destination already exists with different content: {}",
            path.display()
        ),
    )
}

fn invalid_data(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.into())
}

trait CommitFs {
    #[cfg(test)]
    fn create_dir_all(&self, path: &Path) -> std::io::Result<()>;
    #[cfg(test)]
    fn write_new(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()>;
    fn fingerprint(&self, path: &Path) -> std::io::Result<(u64, String)>;
    fn exclusive_publish(&self, from: &Path, to: &Path) -> Result<(), ExclusivePublishError>;
    fn hard_link(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    fn remove_file(&self, path: &Path) -> std::io::Result<()>;
}

#[derive(Debug)]
enum ExclusivePublishError {
    Unsupported(std::io::Error),
    Failed(std::io::Error),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PublishMethod {
    ExclusiveRename,
    HardLink,
}

struct StdCommitFs;

impl CommitFs for StdCommitFs {
    #[cfg(test)]
    fn create_dir_all(&self, path: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(path)
    }

    #[cfg(test)]
    fn write_new(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(bytes)?;
        file.sync_all()
    }

    fn fingerprint(&self, path: &Path) -> std::io::Result<(u64, String)> {
        hash_file_streaming(path)
    }

    fn exclusive_publish(&self, from: &Path, to: &Path) -> Result<(), ExclusivePublishError> {
        platform_exclusive_publish(from, to)
    }

    fn hard_link(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::hard_link(from, to)
    }

    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn unix_path(path: &Path) -> Result<std::ffi::CString, ExclusivePublishError> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        ExclusivePublishError::Failed(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "sync path contains an interior NUL",
        ))
    })
}

#[cfg(target_os = "linux")]
fn platform_exclusive_publish(from: &Path, to: &Path) -> Result<(), ExclusivePublishError> {
    let from = unix_path(from)?;
    let to = unix_path(to)?;
    // SAFETY: both C strings are NUL-terminated and live through the call.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ENOSYS) | Some(libc::EINVAL) | Some(libc::EOPNOTSUPP) => {
            Err(ExclusivePublishError::Unsupported(error))
        }
        _ => Err(ExclusivePublishError::Failed(error)),
    }
}

#[cfg(target_os = "macos")]
fn platform_exclusive_publish(from: &Path, to: &Path) -> Result<(), ExclusivePublishError> {
    let from = unix_path(from)?;
    let to = unix_path(to)?;
    // SAFETY: both C strings are NUL-terminated and live through the call.
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::EINVAL) | Some(libc::EOPNOTSUPP) => {
            Err(ExclusivePublishError::Unsupported(error))
        }
        _ => Err(ExclusivePublishError::Failed(error)),
    }
}

#[cfg(windows)]
fn platform_exclusive_publish(from: &Path, to: &Path) -> Result<(), ExclusivePublishError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED,
    };
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let mut from_wide: Vec<u16> = from.as_os_str().encode_wide().collect();
    let mut to_wide: Vec<u16> = to.as_os_str().encode_wide().collect();
    from_wide.push(0);
    to_wide.push(0);
    // The replacement flag is deliberately absent. MoveFileExW therefore
    // fails if another writer already created the destination.
    // SAFETY: both UTF-16 buffers are NUL-terminated and live through the call.
    let result =
        unsafe { MoveFileExW(from_wide.as_ptr(), to_wide.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if result != 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_FILE_EXISTS) | Some(ERROR_ALREADY_EXISTS) => Err(ExclusivePublishError::Failed(
            std::io::Error::new(std::io::ErrorKind::AlreadyExists, error),
        )),
        Some(ERROR_INVALID_FUNCTION) | Some(ERROR_NOT_SUPPORTED) => {
            Err(ExclusivePublishError::Unsupported(error))
        }
        _ => Err(ExclusivePublishError::Failed(error)),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn platform_exclusive_publish(_from: &Path, _to: &Path) -> Result<(), ExclusivePublishError> {
    Err(ExclusivePublishError::Unsupported(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "no native exclusive-rename implementation for this platform",
    )))
}

fn fingerprint_matches(actual: &(u64, String), size: u64, hash: &str) -> bool {
    actual.0 == size && actual.1.eq_ignore_ascii_case(hash)
}

fn destination_state<F: CommitFs>(
    fs: &F,
    path: &Path,
    size: u64,
    hash: &str,
) -> std::io::Result<Option<bool>> {
    match fs.fingerprint(path) {
        Ok(actual) => Ok(Some(fingerprint_matches(&actual, size, hash))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
fn stage_candidate<F: CommitFs>(
    fs: &F,
    path: &Path,
    bytes: &[u8],
    size: u64,
    hash: &str,
) -> std::io::Result<PathBuf> {
    for _ in 0..16 {
        let candidate = candidate_path(path);
        match fs.write_new(&candidate, bytes) {
            Ok(()) => {
                let staged = match fs.fingerprint(&candidate) {
                    Ok(staged) => staged,
                    Err(e) => {
                        let _ = fs.remove_file(&candidate);
                        return Err(std::io::Error::new(
                            e.kind(),
                            format!(
                                "sync candidate read-back failed at {}: {e}",
                                candidate.display()
                            ),
                        ));
                    }
                };
                if !fingerprint_matches(&staged, size, hash) {
                    let _ = fs.remove_file(&candidate);
                    return Err(invalid_data(format!(
                        "sync candidate failed read-back verification: {}",
                        candidate.display()
                    )));
                }
                return Ok(candidate);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                // `write_all` or `sync_all` can fail after creating a partial
                // candidate. It is uniquely ours and safe to remove.
                let _ = fs.remove_file(&candidate);
                return Err(e);
            }
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate a unique sync candidate",
    ))
}

fn publish_candidate<F: CommitFs>(
    fs: &F,
    candidate: &Path,
    target: &Path,
) -> std::io::Result<PublishMethod> {
    match fs.exclusive_publish(candidate, target) {
        Ok(()) => Ok(PublishMethod::ExclusiveRename),
        Err(ExclusivePublishError::Failed(e)) => Err(e),
        Err(ExclusivePublishError::Unsupported(exclusive_error)) => {
            match fs.hard_link(candidate, target) {
                Ok(()) => Ok(PublishMethod::HardLink),
                Err(link_error) => Err(std::io::Error::new(
                    link_error.kind(),
                    format!(
                        "native exclusive rename is unsupported ({exclusive_error}); safe hard-link fallback failed: {link_error}"
                    ),
                )),
            }
        }
    }
}

#[cfg(test)]
fn commit_verified_create_with_fs<F: CommitFs>(
    fs: &F,
    path: &Path,
    bytes: &[u8],
    size: u64,
    hash: &str,
) -> std::io::Result<CommitOutcome> {
    if let Some(parent) = path.parent() {
        fs.create_dir_all(parent)?;
    }
    match destination_state(fs, path, size, hash)? {
        Some(true) => return Ok(CommitOutcome::Unchanged),
        Some(false) => return Err(collision_error(path)),
        None => {}
    }

    let candidate = stage_candidate(fs, path, bytes, size, hash)?;
    let mut preserve_candidate = false;
    let result =
        publish_verified_candidate(fs, &candidate, path, size, hash, &mut preserve_candidate);
    if !preserve_candidate {
        let _ = fs.remove_file(&candidate);
    }
    result
}

fn publish_verified_candidate<F: CommitFs>(
    fs: &F,
    candidate: &Path,
    path: &Path,
    size: u64,
    hash: &str,
    preserve_candidate: &mut bool,
) -> std::io::Result<CommitOutcome> {
    match publish_candidate(fs, candidate, path) {
        Ok(method) => match fs.fingerprint(path) {
            Ok(committed) if fingerprint_matches(&committed, size, hash) => {
                if method == PublishMethod::HardLink {
                    let _ = fs.remove_file(candidate);
                }
                Ok(CommitOutcome::Created)
            }
            Ok(_) => {
                *preserve_candidate = method == PublishMethod::HardLink;
                Err(invalid_data(format!(
                "sync target failed final read-back verification; target was preserved because portable file-identity proof is unavailable{}",
                if method == PublishMethod::HardLink {
                    format!("; staged link remains at {}", candidate.display())
                } else {
                    String::new()
                }
            )))
            }
            Err(e) => {
                *preserve_candidate = method == PublishMethod::HardLink;
                Err(invalid_data(format!(
                "sync target final read-back failed ({e}); target was preserved because portable file-identity proof is unavailable{}",
                if method == PublishMethod::HardLink {
                    format!("; staged link remains at {}", candidate.display())
                } else {
                    String::new()
                }
            )))
            }
        },
        Err(publish_error) => {
            let state = destination_state(fs, path, size, hash);
            match state {
                Ok(Some(true)) => Ok(CommitOutcome::Unchanged),
                Ok(Some(false)) => Err(collision_error(path)),
                Ok(None) => Err(std::io::Error::new(
                    publish_error.kind(),
                    format!("safe create failed; destination was not modified: {publish_error}"),
                )),
                Err(e) => Err(e),
            }
        }
    }
}

/// Commit a verified candidate only when `path` is missing. The platform's
/// native exclusive-rename primitive publishes the complete sibling candidate
/// without a check-then-rename race. A hard link is used only when the native
/// primitive reports that the filesystem does not support exclusive rename.
#[cfg(test)]
pub fn commit_verified_create(path: &Path, bytes: &[u8]) -> std::io::Result<CommitOutcome> {
    let size = bytes.len() as u64;
    let hash = fnv1a_hex(bytes);
    commit_verified_create_with_fs(&StdCommitFs, path, bytes, size, &hash)
}

/// The reason a streamed receive failed, kept distinct for HTTP diagnostics.
#[derive(Debug)]
pub enum ReceiveError {
    TooLarge { limit: u64 },
    SizeMismatch { expected: u64, actual: u64 },
    HashMismatch { expected: String, actual: String },
    Read(std::io::Error),
    Write(std::io::Error),
}

impl std::fmt::Display for ReceiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { limit } => write!(f, "transfer exceeds {limit} byte limit"),
            Self::SizeMismatch { expected, actual } => write!(
                f,
                "content size mismatch after transfer (expected {expected}, got {actual})"
            ),
            Self::HashMismatch { expected, actual } => write!(
                f,
                "content hash mismatch after transfer (expected {expected}, got {actual})"
            ),
            Self::Read(e) => write!(f, "transfer read failed: {e}"),
            Self::Write(e) => write!(f, "staged write failed: {e}"),
        }
    }
}

impl std::error::Error for ReceiveError {}

/// Verified, private sibling file. Dropping an interrupted receive removes only
/// this create-new candidate. Publication never replaces an existing target.
pub struct StagedFile {
    path: PathBuf,
    pub size: u64,
    hash: String,
    preserve: bool,
}

pub struct StagedReceive {
    staged: StagedFile,
    file: std::fs::File,
    hasher: Fnv1a,
    max_bytes: u64,
    expected_size: Option<u64>,
    expected_hash: Option<String>,
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if !self.preserve {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl StagedFile {
    pub fn begin(
        target: &Path,
        max_bytes: u64,
        expected_size: Option<u64>,
        expected_hash: Option<&str>,
    ) -> Result<StagedReceive, ReceiveError> {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(ReceiveError::Write)?;
        }
        let mut opened = None;
        for _ in 0..16 {
            let path = candidate_path(target);
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(file) => {
                    opened = Some((path, file));
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(ReceiveError::Write(e)),
            }
        }
        let (path, file) = opened.ok_or_else(|| {
            ReceiveError::Write(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "could not allocate a unique sync candidate",
            ))
        })?;
        Ok(StagedReceive {
            staged: Self {
                path,
                size: 0,
                hash: String::new(),
                preserve: false,
            },
            file,
            hasher: Fnv1a::new(),
            max_bytes,
            expected_size,
            expected_hash: expected_hash.map(str::to_string),
        })
    }

    /// Receive with fixed 64 KiB memory, hash during the write, then verify the
    /// staged disk bytes. The target remains untouched on every receive error.
    pub fn receive(
        target: &Path,
        mut reader: impl Read,
        max_bytes: u64,
        expected_size: Option<u64>,
        expected_hash: Option<&str>,
    ) -> Result<Self, ReceiveError> {
        let mut receive = Self::begin(target, max_bytes, expected_size, expected_hash)?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = match reader.read(&mut buffer) {
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                result => result.map_err(ReceiveError::Read)?,
            };
            if n == 0 {
                break;
            }
            receive.write_chunk(&buffer[..n])?;
        }
        receive.finish()
    }

    fn publish(&mut self, target: &Path) -> std::io::Result<CommitOutcome> {
        // Repeat the existing-file check for idempotency and numbered conflicts.
        // The exclusive rename remains authoritative for a race after this check.
        match destination_state(&StdCommitFs, target, self.size, &self.hash)? {
            Some(true) => return Ok(CommitOutcome::Unchanged),
            Some(false) => return Err(collision_error(target)),
            None => {}
        }
        publish_verified_candidate(
            &StdCommitFs,
            &self.path,
            target,
            self.size,
            &self.hash,
            &mut self.preserve,
        )
    }

    pub fn commit(mut self, target: &Path) -> std::io::Result<CommitOutcome> {
        self.publish(target)
    }

    pub fn commit_conflict(
        mut self,
        root: &Path,
        base_rel: &str,
    ) -> std::io::Result<(CommitOutcome, String)> {
        for ordinal in 1..=10_000 {
            let rel = numbered_conflict_name(base_rel, ordinal);
            let target = safe_join(root, &rel).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("unsafe destination path {rel:?}"),
                )
            })?;
            match self.publish(&target) {
                Ok(outcome) => return Ok((outcome, rel)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "too many same-day conflict copies",
        ))
    }
}

impl StagedReceive {
    pub fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), ReceiveError> {
        if bytes.len() as u64 > self.max_bytes.saturating_sub(self.staged.size) {
            return Err(ReceiveError::TooLarge { limit: self.max_bytes });
        }
        self.file.write_all(bytes).map_err(ReceiveError::Write)?;
        self.hasher.update(bytes);
        self.staged.size += bytes.len() as u64;
        Ok(())
    }

    pub fn finish(mut self) -> Result<StagedFile, ReceiveError> {
        if let Some(expected) = self.expected_size {
            if self.staged.size != expected {
                return Err(ReceiveError::SizeMismatch {
                    expected,
                    actual: self.staged.size,
                });
            }
        }
        self.staged.hash = self.hasher.hex();
        if let Some(expected) = &self.expected_hash {
            if !expected.eq_ignore_ascii_case(&self.staged.hash) {
                return Err(ReceiveError::HashMismatch {
                    expected: expected.clone(),
                    actual: self.staged.hash.clone(),
                });
            }
        }
        self.file.sync_all().map_err(ReceiveError::Write)?;
        drop(self.file);
        let actual = hash_file_streaming(&self.staged.path).map_err(ReceiveError::Write)?;
        if !fingerprint_matches(&actual, self.staged.size, &self.staged.hash) {
            return Err(ReceiveError::Write(invalid_data(format!(
                "sync candidate failed read-back verification: {}",
                self.staged.path.display()
            ))));
        }
        Ok(self.staged)
    }
}

/// Add a numeric collision suffix before the extension. The base conflict
/// name remains mirrored with TypeScript; this Rust-only helper prevents a
/// second same-day conflict from overwriting the first one.
pub fn numbered_conflict_name(base: &str, ordinal: u32) -> String {
    if ordinal <= 1 {
        return base.to_string();
    }
    let tag = format!(" ({ordinal})");
    let dot = base.rfind('.').map(|i| i as i64).unwrap_or(-1);
    let slash = base.rfind('/').map(|i| i as i64).unwrap_or(-1);
    if dot > slash {
        let d = dot as usize;
        format!("{}{}{}", &base[..d], tag, &base[d..])
    } else {
        format!("{base}{tag}")
    }
}

/// Commit a conflict copy without replacing any existing same-day copy.
/// Identical bytes reuse the first matching numbered destination; different
/// bytes advance until an unused sibling is available.
#[cfg(test)]
pub fn commit_conflict_verified(
    root: &Path,
    base_rel: &str,
    bytes: &[u8],
) -> std::io::Result<(CommitOutcome, String)> {
    for ordinal in 1..=10_000 {
        let dest_rel = numbered_conflict_name(base_rel, ordinal);
        let dest = safe_join(root, &dest_rel).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("unsafe destination path {dest_rel:?}"),
            )
        })?;
        match commit_verified_create(&dest, bytes) {
            Ok(outcome) => return Ok((outcome, dest_rel)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "too many same-day conflict copies",
    ))
}

/// Check the contiguous conflict-copy sequence for identical bytes. Mesa's
/// own numbering is gap-free, so this avoids downloading and reporting the
/// same conflict on every later sync without scanning 10,000 missing paths.
pub fn conflict_copy_already_present(
    root: &Path,
    base_rel: &str,
    expected_size: u64,
    expected_hash: &str,
) -> std::io::Result<bool> {
    for ordinal in 1..=10_000 {
        let dest_rel = numbered_conflict_name(base_rel, ordinal);
        let dest = safe_join(root, &dest_rel).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("unsafe destination path {dest_rel:?}"),
            )
        })?;
        match hash_file_streaming(&dest) {
            Ok(actual) if fingerprint_matches(&actual, expected_size, expected_hash) => {
                return Ok(true);
            }
            Ok(_) => continue,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e),
        }
    }
    Ok(false)
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
    use std::cell::{Cell, RefCell};

    #[derive(Clone, Copy, Default)]
    enum ExclusiveMode {
        #[default]
        Supported,
        Unsupported,
        Fail,
    }

    #[derive(Default)]
    struct MemoryCommitFs {
        files: RefCell<HashMap<PathBuf, Vec<u8>>>,
        destination_on_publish: RefCell<Option<Vec<u8>>>,
        corrupt_published_target: Cell<bool>,
        exclusive_mode: Cell<ExclusiveMode>,
        hard_link_fail: Cell<bool>,
        hard_link_calls: Cell<u32>,
    }

    impl MemoryCommitFs {
        fn get(&self, path: &Path) -> Option<Vec<u8>> {
            self.files.borrow().get(path).cloned()
        }
    }

    impl CommitFs for MemoryCommitFs {
        fn create_dir_all(&self, _path: &Path) -> std::io::Result<()> {
            Ok(())
        }

        #[cfg(test)]
        fn write_new(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
            let mut files = self.files.borrow_mut();
            if files.contains_key(path) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "exists",
                ));
            }
            files.insert(path.to_path_buf(), bytes.to_vec());
            Ok(())
        }

        fn fingerprint(&self, path: &Path) -> std::io::Result<(u64, String)> {
            let files = self.files.borrow();
            let bytes = files
                .get(path)
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "not found"))?;
            Ok((bytes.len() as u64, fnv1a_hex(bytes)))
        }

        fn exclusive_publish(&self, from: &Path, to: &Path) -> Result<(), ExclusivePublishError> {
            match self.exclusive_mode.get() {
                ExclusiveMode::Unsupported => {
                    return Err(ExclusivePublishError::Unsupported(std::io::Error::new(
                        std::io::ErrorKind::Unsupported,
                        "injected unsupported exclusive rename",
                    )));
                }
                ExclusiveMode::Fail => {
                    return Err(ExclusivePublishError::Failed(std::io::Error::other(
                        "injected exclusive rename failure",
                    )));
                }
                ExclusiveMode::Supported => {}
            }
            if let Some(bytes) = self.destination_on_publish.borrow_mut().take() {
                self.files.borrow_mut().insert(to.to_path_buf(), bytes);
                return Err(ExclusivePublishError::Failed(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "racing destination",
                )));
            }
            let mut files = self.files.borrow_mut();
            if files.contains_key(to) {
                return Err(ExclusivePublishError::Failed(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "exists",
                )));
            }
            let bytes = files.remove(from).ok_or_else(|| {
                ExclusivePublishError::Failed(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "candidate missing",
                ))
            })?;
            if self.corrupt_published_target.replace(false) {
                files.insert(to.to_path_buf(), b"external-replacement".to_vec());
            } else {
                files.insert(to.to_path_buf(), bytes);
            }
            Ok(())
        }

        fn hard_link(&self, from: &Path, to: &Path) -> std::io::Result<()> {
            self.hard_link_calls
                .set(self.hard_link_calls.get().saturating_add(1));
            if self.hard_link_fail.get() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "injected hard-link failure",
                ));
            }
            if let Some(bytes) = self.destination_on_publish.borrow_mut().take() {
                self.files.borrow_mut().insert(to.to_path_buf(), bytes);
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "racing destination",
                ));
            }
            let bytes = self
                .get(from)
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "not found"))?;
            let mut files = self.files.borrow_mut();
            if files.contains_key(to) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "exists",
                ));
            }
            if self.corrupt_published_target.replace(false) {
                files.insert(to.to_path_buf(), b"external-replacement".to_vec());
            } else {
                files.insert(to.to_path_buf(), bytes);
            }
            Ok(())
        }

        fn remove_file(&self, path: &Path) -> std::io::Result<()> {
            if self.files.borrow_mut().remove(path).is_some() {
                Ok(())
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "not found",
                ))
            }
        }
    }

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

    /// Scratch vault for the manifest tests. Enough files to cross
    /// `PARALLEL_HASH_MIN_FILES`, with sizes that span the streaming buffer.
    struct ManifestVault(PathBuf);
    impl ManifestVault {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "mesa-manifest-{tag}-{}-{:?}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&p).unwrap();
            ManifestVault(p)
        }
        fn write(&self, rel: &str, bytes: &[u8]) {
            let full = self.0.join(rel);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, bytes).unwrap();
        }
        /// 40 files: empty, sub-chunk, and several megabytes (many 64 KiB
        /// reads), nested so the walk order is not the creation order.
        fn populate(&self) -> Vec<(String, Vec<u8>)> {
            let mut made = Vec::new();
            for i in 0..40usize {
                let rel = if i % 3 == 0 {
                    format!("deep/sub{}/file{i}.bin", i % 4)
                } else {
                    format!("file{i}.bin")
                };
                let len = match i % 4 {
                    0 => 0,
                    1 => 11,
                    2 => 70_000,
                    _ => 2_000_000,
                };
                let bytes: Vec<u8> = (0..len).map(|n| ((n + i) % 251) as u8).collect();
                self.write(&rel, &bytes);
                made.push((rel, bytes));
            }
            made
        }
    }
    impl Drop for ManifestVault {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The parallel build must produce exactly the digests the serial
    /// whole-buffer hash produces — the manifest is a wire format shared with
    /// `src/lib/sync.ts` and with peers running older builds.
    #[test]
    fn build_manifest_hashes_match_whole_buffer_hashes() {
        let v = ManifestVault::new("equal");
        let made = v.populate();
        let mut cache = HashCache::new();
        let (entries, skipped) = build_manifest(&v.0, &mut cache);
        assert!(skipped.is_empty(), "unexpected skips: {skipped:?}");
        assert_eq!(entries.len(), made.len());
        for (rel, bytes) in &made {
            let e = entries
                .iter()
                .find(|e| &e.rel == rel)
                .unwrap_or_else(|| panic!("missing {rel}"));
            assert_eq!(e.hash, fnv1a_hex(bytes), "hash mismatch for {rel}");
            assert_eq!(e.size, bytes.len() as u64, "size mismatch for {rel}");
        }
    }

    /// Threads finish in nondeterministic order; the manifest must not.
    #[test]
    fn build_manifest_order_is_deterministic_and_sorted() {
        let v = ManifestVault::new("order");
        v.populate();
        let first = build_manifest(&v.0, &mut HashCache::new()).0;
        let second = build_manifest(&v.0, &mut HashCache::new()).0;
        let rels = |m: &[ManifestEntry]| m.iter().map(|e| e.rel.clone()).collect::<Vec<_>>();
        assert_eq!(rels(&first), rels(&second));
        let mut sorted = rels(&first);
        sorted.sort();
        assert_eq!(rels(&first), sorted, "manifest must stay in rel order");
        // Same bytes ⇒ same digests, whichever thread produced them.
        let hashes = |m: &[ManifestEntry]| m.iter().map(|e| e.hash.clone()).collect::<Vec<_>>();
        assert_eq!(hashes(&first), hashes(&second));
    }

    #[test]
    fn cancellable_manifest_returns_no_partial_result() {
        let v = ManifestVault::new("cancel");
        v.populate();
        let cancelled = AtomicBool::new(true);
        assert!(build_manifest_cancellable(&v.0, &mut HashCache::new(), &cancelled).is_none());
    }

    #[test]
    fn hash_cache_prune_removes_paths_outside_the_snapshot() {
        let v = ManifestVault::new("prune");
        let kept = v.0.join("kept.md");
        let removed = v.0.join("removed.md");
        v.write("kept.md", b"kept");
        v.write("removed.md", b"removed");
        let mut cache = HashCache::new();
        cache.hash_file(&kept).unwrap();
        cache.hash_file(&removed).unwrap();
        cache.prune(&[kept], 4096);
        assert!(matches!(cache.probe(&removed).unwrap(), CacheProbe::Miss(_)));
    }

    /// A warm cache must still short-circuit: the parallel phase may only see
    /// files whose (size, mtime) changed. Rewriting content while preserving
    /// both proves the second build never re-read the file.
    #[test]
    fn build_manifest_reuses_cached_digests() {
        let v = ManifestVault::new("warm");
        v.populate();
        let mut cache = HashCache::new();
        let (first, _) = build_manifest(&v.0, &mut cache);

        let target = v.0.join("file1.bin");
        let meta = std::fs::metadata(&target).unwrap();
        let mtime = meta.modified().unwrap();
        std::fs::write(&target, b"DIFFERENT!!").unwrap(); // same 11-byte length
        let f = std::fs::File::options().write(true).open(&target).unwrap();
        f.set_modified(mtime).unwrap();
        drop(f);

        let (second, _) = build_manifest(&v.0, &mut cache);
        let pick = |m: &[ManifestEntry]| {
            m.iter()
                .find(|e| e.rel == "file1.bin")
                .unwrap()
                .hash
                .clone()
        };
        assert_eq!(pick(&first), pick(&second), "cached digest was not reused");

        // A fresh cache does read it, and sees the new bytes.
        let (third, _) = build_manifest(&v.0, &mut HashCache::new());
        assert_eq!(pick(&third), fnv1a_hex(b"DIFFERENT!!"));
    }

    /// Unreadable files must land in `skipped` rather than dropping out of the
    /// sync set silently, and the readable ones around them must survive.
    #[cfg(unix)]
    #[test]
    fn build_manifest_reports_unreadable_files() {
        use std::os::unix::fs::PermissionsExt;
        let v = ManifestVault::new("perm");
        v.populate();
        let locked = v.0.join("file2.bin");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root ignores the mode bits; skip rather than assert a false negative.
        if std::fs::File::open(&locked).is_ok() {
            return;
        }
        let (entries, skipped) = build_manifest(&v.0, &mut HashCache::new());
        assert_eq!(skipped.len(), 1, "expected one skip, got {skipped:?}");
        assert_eq!(skipped[0].0, "file2.bin");
        assert!(!entries.iter().any(|e| e.rel == "file2.bin"));
        assert_eq!(entries.len(), 39, "other files must still be manifested");
        let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644));
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
    fn numbered_conflicts_preserve_every_same_day_copy() {
        let base = "sub/Note (conflict from peer 2026-06-23).md";
        assert_eq!(numbered_conflict_name(base, 1), base);
        assert_eq!(
            numbered_conflict_name(base, 2),
            "sub/Note (conflict from peer 2026-06-23) (2).md"
        );
        assert_eq!(numbered_conflict_name("README", 3), "README (3)");
    }

    #[test]
    fn conflict_commit_reuses_identical_and_numbers_different_bytes() {
        let dir = std::env::temp_dir().join(format!("mesa-cc-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let base = "Note (conflict from peer 2026-06-23).md";
        std::fs::write(dir.join(base), b"first").unwrap();

        let (created, second_rel) = commit_conflict_verified(&dir, base, b"second").unwrap();
        assert_eq!(created, CommitOutcome::Created);
        assert_eq!(second_rel, "Note (conflict from peer 2026-06-23) (2).md");
        assert_eq!(std::fs::read(dir.join(base)).unwrap(), b"first");
        assert_eq!(std::fs::read(dir.join(&second_rel)).unwrap(), b"second");

        let (same, same_rel) = commit_conflict_verified(&dir, base, b"second").unwrap();
        assert_eq!(same, CommitOutcome::Unchanged);
        assert_eq!(same_rel, second_rel);

        let (third, third_rel) = commit_conflict_verified(&dir, base, b"third").unwrap();
        assert_eq!(third, CommitOutcome::Created);
        assert_eq!(third_rel, "Note (conflict from peer 2026-06-23) (3).md");
        assert_eq!(std::fs::read(dir.join(&third_rel)).unwrap(), b"third");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn conflict_prescan_finds_an_identical_numbered_copy() {
        let dir = std::env::temp_dir().join(format!("mesa-cp-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let base = "Note (conflict from peer 2026-06-23).md";
        std::fs::write(dir.join(base), b"first").unwrap();
        std::fs::write(
            dir.join("Note (conflict from peer 2026-06-23) (2).md"),
            b"remote",
        )
        .unwrap();
        let remote_hash = fnv1a_hex(b"remote");
        assert!(
            conflict_copy_already_present(&dir, base, b"remote".len() as u64, &remote_hash,)
                .unwrap()
        );
        assert!(!conflict_copy_already_present(
            &dir,
            base,
            b"third".len() as u64,
            &fnv1a_hex(b"third"),
        )
        .unwrap());
        let _ = std::fs::remove_dir_all(&dir);
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

    fn stage_test_bytes(target: &Path, bytes: &[u8]) -> StagedFile {
        StagedFile::receive(
            target,
            bytes,
            bytes.len() as u64,
            Some(bytes.len() as u64),
            Some(&fnv1a_hex(bytes)),
        )
        .unwrap()
    }

    fn assert_no_staged_files(dir: &Path) {
        assert!(std::fs::read_dir(dir).unwrap().flatten().all(|entry| !entry
            .file_name()
            .to_string_lossy()
            .starts_with(".mesa-sync-tmp")));
    }

    #[test]
    fn streamed_receive_is_bounded_verified_and_idempotent() {
        let vault = ManifestVault::new("streamed");
        let target = vault.0.join("file.bin");
        let bytes: Vec<_> = (0..170_000).map(|n| (n % 251) as u8).collect();
        struct SmallReads<'a>(&'a [u8]);
        impl Read for SmallReads<'_> {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                assert!(
                    output.len() <= 64 * 1024,
                    "receive allocated a file-sized buffer"
                );
                let size = output.len().min(97).min(self.0.len());
                output[..size].copy_from_slice(&self.0[..size]);
                self.0 = &self.0[size..];
                Ok(size)
            }
        }
        let stage = StagedFile::receive(
            &target,
            SmallReads(&bytes),
            bytes.len() as u64,
            Some(bytes.len() as u64),
            Some(&fnv1a_hex(&bytes).to_uppercase()),
        )
        .unwrap();
        assert!(!target.exists());
        assert_eq!(stage.commit(&target).unwrap(), CommitOutcome::Created);
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        assert_eq!(
            stage_test_bytes(&target, &bytes).commit(&target).unwrap(),
            CommitOutcome::Unchanged
        );
        assert_no_staged_files(&vault.0);
    }

    #[test]
    fn streamed_receive_rejects_limits_truncation_and_hash_failures() {
        let vault = ManifestVault::new("streamed-errors");
        let target = vault.0.join("file.bin");
        vault.write("file.bin", b"existing");
        assert!(matches!(
            StagedFile::receive(&target, &b"abc"[..], 2, None, None),
            Err(ReceiveError::TooLarge { limit: 2 })
        ));
        assert!(matches!(
            StagedFile::receive(&target, &b"abc"[..], 10, Some(4), None),
            Err(ReceiveError::SizeMismatch {
                expected: 4,
                actual: 3
            })
        ));
        assert!(matches!(
            StagedFile::receive(&target, &b"abc"[..], 3, Some(3), Some("bad")),
            Err(ReceiveError::HashMismatch { .. })
        ));
        assert_eq!(std::fs::read(&target).unwrap(), b"existing");
        assert_no_staged_files(&vault.0);
    }

    #[test]
    fn streamed_receive_cleans_partial_read_failure_and_dropped_stage() {
        let vault = ManifestVault::new("streamed-interrupted");
        let target = vault.0.join("file.bin");
        struct BrokenRead(bool);
        impl Read for BrokenRead {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                if self.0 {
                    return Err(std::io::Error::other("connection lost"));
                }
                self.0 = true;
                out[0] = b'x';
                Ok(1)
            }
        }
        assert!(matches!(
            StagedFile::receive(&target, BrokenRead(false), 5, None, None),
            Err(ReceiveError::Read(_))
        ));
        assert_no_staged_files(&vault.0);
        drop(stage_test_bytes(&target, b"pending"));
        assert!(!target.exists());
        assert_no_staged_files(&vault.0);
    }

    #[test]
    fn streamed_receive_retries_interrupted_reads() {
        let vault = ManifestVault::new("streamed-eintr");
        let target = vault.0.join("file.bin");
        struct InterruptedOnce(bool, std::io::Cursor<Vec<u8>>);
        impl Read for InterruptedOnce {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                if !self.0 {
                    self.0 = true;
                    return Err(std::io::Error::from(std::io::ErrorKind::Interrupted));
                }
                self.1.read(out)
            }
        }
        let stage = StagedFile::receive(
            &target,
            InterruptedOnce(false, std::io::Cursor::new(b"bytes".to_vec())),
            5,
            Some(5),
            Some(&fnv1a_hex(b"bytes")),
        )
        .unwrap();
        assert_eq!(stage.commit(&target).unwrap(), CommitOutcome::Created);
        assert_eq!(std::fs::read(&target).unwrap(), b"bytes");
        assert_no_staged_files(&vault.0);
    }

    #[test]
    fn streamed_receive_empty_file_and_write_failure() {
        let vault = ManifestVault::new("streamed-empty");
        let target = vault.0.join("empty.bin");
        assert_eq!(
            stage_test_bytes(&target, b"").commit(&target).unwrap(),
            CommitOutcome::Created
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"");
        vault.write("blocked", b"parent is a file");
        assert!(matches!(
            StagedFile::receive(&vault.0.join("blocked/file.bin"), &b"x"[..], 1, None, None),
            Err(ReceiveError::Write(_))
        ));
        assert_eq!(
            std::fs::read(vault.0.join("blocked")).unwrap(),
            b"parent is a file"
        );
        assert_no_staged_files(&vault.0);
    }

    #[test]
    fn streamed_commit_preserves_late_target_and_reuses_numbered_conflict() {
        let vault = ManifestVault::new("streamed-conflict");
        let target = vault.0.join("file.bin");
        let stage = stage_test_bytes(&target, b"incoming");
        vault.write("file.bin", b"late external edit");
        assert_eq!(
            stage.commit(&target).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"late external edit");
        let (outcome, rel) = stage_test_bytes(&target, b"incoming")
            .commit_conflict(&vault.0, "file.bin")
            .unwrap();
        assert_eq!(
            (outcome, rel.as_str()),
            (CommitOutcome::Created, "file (2).bin")
        );
        let (outcome, rel) = stage_test_bytes(&target, b"incoming")
            .commit_conflict(&vault.0, "file.bin")
            .unwrap();
        assert_eq!(
            (outcome, rel.as_str()),
            (CommitOutcome::Unchanged, "file (2).bin")
        );
        assert_no_staged_files(&vault.0);
    }

    #[test]
    fn staged_publisher_preserves_candidate_for_conflict_retry() {
        let fs = MemoryCommitFs::default();
        let target = Path::new("/vault/n.md");
        let candidate = Path::new("/vault/.candidate");
        fs.write_new(candidate, b"incoming").unwrap();
        *fs.destination_on_publish.borrow_mut() = Some(b"racing external".to_vec());
        let mut preserve = false;
        assert_eq!(
            publish_verified_candidate(
                &fs,
                candidate,
                target,
                8,
                &fnv1a_hex(b"incoming"),
                &mut preserve
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs.get(candidate).unwrap(), b"incoming");
        assert_eq!(fs.get(target).unwrap(), b"racing external");
        assert!(!preserve);
    }

    #[test]
    fn staged_publisher_preserves_link_after_failed_final_readback() {
        let fs = MemoryCommitFs::default();
        let target = Path::new("/vault/n.md");
        let candidate = Path::new("/vault/.candidate");
        fs.write_new(candidate, b"incoming").unwrap();
        fs.exclusive_mode.set(ExclusiveMode::Unsupported);
        fs.corrupt_published_target.set(true);
        let mut preserve = false;
        assert!(publish_verified_candidate(
            &fs,
            candidate,
            target,
            8,
            &fnv1a_hex(b"incoming"),
            &mut preserve
        )
        .is_err());
        assert!(preserve);
        assert_eq!(fs.get(candidate).unwrap(), b"incoming");
        assert_eq!(fs.get(target).unwrap(), b"external-replacement");
    }

    #[test]
    fn verified_create_is_idempotent_and_never_replaces() {
        let dir = std::env::temp_dir().join(format!("mesa-vc-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let target = dir.join("deep/nested/n.md");
        assert_eq!(
            commit_verified_create(&target, b"one").unwrap(),
            CommitOutcome::Created
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"one");
        assert_eq!(
            commit_verified_create(&target, b"one").unwrap(),
            CommitOutcome::Unchanged
        );
        let err = commit_verified_create(&target, b"two").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&target).unwrap(), b"one");
        // No temp litter left behind.
        let litter: Vec<_> = std::fs::read_dir(target.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".mesa-sync-tmp")
            })
            .collect();
        assert!(litter.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn exclusive_publish_race_preserves_the_other_writer() {
        let fs = MemoryCommitFs::default();
        let target = Path::new("/vault/n.md");
        *fs.destination_on_publish.borrow_mut() = Some(b"external".to_vec());
        let incoming = b"remote";
        let err = commit_verified_create_with_fs(
            &fs,
            target,
            incoming,
            incoming.len() as u64,
            &fnv1a_hex(incoming),
        )
        .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs.get(target).unwrap(), b"external");
    }

    #[test]
    fn hard_link_is_only_used_when_exclusive_rename_is_unsupported() {
        let fs = MemoryCommitFs::default();
        let target = Path::new("/vault/n.md");
        fs.exclusive_mode.set(ExclusiveMode::Unsupported);
        let incoming = b"remote";
        let outcome = commit_verified_create_with_fs(
            &fs,
            target,
            incoming,
            incoming.len() as u64,
            &fnv1a_hex(incoming),
        )
        .unwrap();
        assert_eq!(outcome, CommitOutcome::Created);
        assert_eq!(fs.get(target).unwrap(), incoming);
        assert_eq!(fs.hard_link_calls.get(), 1);
    }

    #[test]
    fn supported_exclusive_rename_never_uses_hard_link() {
        let fs = MemoryCommitFs::default();
        let target = Path::new("/vault/n.md");
        let incoming = b"remote";
        let outcome = commit_verified_create_with_fs(
            &fs,
            target,
            incoming,
            incoming.len() as u64,
            &fnv1a_hex(incoming),
        )
        .unwrap();
        assert_eq!(outcome, CommitOutcome::Created);
        assert_eq!(fs.hard_link_calls.get(), 0);
    }

    #[test]
    fn platform_exclusive_publish_refuses_an_existing_target() {
        let dir = std::env::temp_dir().join(format!("mesa-xr-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let candidate = dir.join("candidate");
        let target = dir.join("target");
        std::fs::write(&candidate, b"incoming").unwrap();
        std::fs::write(&target, b"existing").unwrap();

        assert!(platform_exclusive_publish(&candidate, &target).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"existing");
        assert_eq!(std::fs::read(&candidate).unwrap(), b"incoming");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsupported_exclusive_rename_and_hard_link_fail_closed() {
        let fs = MemoryCommitFs::default();
        let target = Path::new("/vault/n.md");
        fs.exclusive_mode.set(ExclusiveMode::Unsupported);
        fs.hard_link_fail.set(true);
        let incoming = b"remote";
        let err = commit_verified_create_with_fs(
            &fs,
            target,
            incoming,
            incoming.len() as u64,
            &fnv1a_hex(incoming),
        )
        .unwrap_err();
        assert!(err
            .to_string()
            .contains("native exclusive rename is unsupported"));
        assert!(err.to_string().contains("safe hard-link fallback failed"));
        assert!(fs.get(target).is_none());
    }

    #[test]
    fn arbitrary_exclusive_rename_failure_does_not_fallback_or_publish() {
        let fs = MemoryCommitFs::default();
        let target = Path::new("/vault/n.md");
        fs.exclusive_mode.set(ExclusiveMode::Fail);
        let incoming = b"remote";
        let err = commit_verified_create_with_fs(
            &fs,
            target,
            incoming,
            incoming.len() as u64,
            &fnv1a_hex(incoming),
        )
        .unwrap_err();
        assert!(err
            .to_string()
            .contains("injected exclusive rename failure"));
        assert_eq!(fs.hard_link_calls.get(), 0);
        assert!(fs.get(target).is_none());
    }

    #[test]
    fn final_readback_failure_preserves_a_possible_replacement() {
        let fs = MemoryCommitFs::default();
        let target = Path::new("/vault/n.md");
        fs.corrupt_published_target.set(true);
        let incoming = b"remote";
        let err = commit_verified_create_with_fs(
            &fs,
            target,
            incoming,
            incoming.len() as u64,
            &fnv1a_hex(incoming),
        )
        .unwrap_err();
        assert!(err
            .to_string()
            .contains("portable file-identity proof is unavailable"));
        assert_eq!(fs.get(target).unwrap(), b"external-replacement");
    }

    #[test]
    fn candidate_names_are_unique_and_recovery_visible() {
        let target = Path::new("/vault/n.md");
        let first = candidate_path(target);
        let second = candidate_path(target);
        assert_ne!(first, second);
        for path in [first, second] {
            assert!(path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(&format!(".mesa-sync-tmp-{}-", std::process::id())));
        }
    }

    #[test]
    fn platform_publish_source_contracts_pin_no_replace_flags() {
        let source = include_str!("sync_core.rs");
        assert!(source.contains("libc::renameat2"));
        assert!(source.contains("libc::RENAME_NOREPLACE"));
        assert!(source.contains("libc::renamex_np"));
        assert!(source.contains("libc::RENAME_EXCL"));
        assert!(source.contains("MoveFileExW"));
        assert!(source.contains("MOVEFILE_WRITE_THROUGH"));
        // The sole occurrence is this assertion string, not an import or flag.
        assert_eq!(source.matches("MOVEFILE_REPLACE_EXISTING").count(), 1);
        // Journal metadata and private deletion staging use ordinary rename
        // only for Mesa-owned hidden files. User-file publication remains
        // pinned to the no-replace primitives above.
        assert!(source.matches("std::fs::rename").count() >= 1);
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
    fn journal_recovers_delete_and_unique_rename_from_snapshot() {
        let dir = std::env::temp_dir().join(format!("mesa-journal-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("old.md"), b"same").unwrap();
        std::fs::write(dir.join("gone.md"), b"gone").unwrap();
        let (first, _) = build_manifest(&dir, &mut HashCache::new());
        reconcile_journal(&dir, &first).unwrap();
        std::fs::rename(dir.join("old.md"), dir.join("new.md")).unwrap();
        std::fs::remove_file(dir.join("gone.md")).unwrap();
        let (second, _) = build_manifest(&dir, &mut HashCache::new());
        let journal = reconcile_journal(&dir, &second).unwrap();
        assert!(journal.operations.iter().any(|op| op.kind == JournalOperationKind::Rename && op.from == "old.md" && op.to.as_deref() == Some("new.md")));
        assert!(journal.operations.iter().any(|op| op.kind == JournalOperationKind::Delete && op.from == "gone.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn journal_delete_preserves_changed_local_content() {
        let dir = std::env::temp_dir().join(format!("mesa-journal-conflict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("note.md"), b"changed locally").unwrap();
        let op = JournalOperation {
            id: "peer:1".to_string(), device: "peer".to_string(), sequence: 1, at_ms: 0,
            kind: JournalOperationKind::Delete, from: "note.md".to_string(), to: None,
            size: 6, hash: fnv1a_hex(b"remote"),
        };
        assert_eq!(apply_journal_operation(&dir, &op).unwrap(), JournalApply::Conflict);
        assert_eq!(std::fs::read(dir.join("note.md")).unwrap(), b"changed locally");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn journal_restore_retracts_local_delete_tombstone() {
        let dir = std::env::temp_dir().join(format!("mesa-journal-restore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("note.md"), b"restore me").unwrap();
        let (first, _) = build_manifest(&dir, &mut HashCache::new());
        reconcile_journal(&dir, &first).unwrap();

        std::fs::remove_file(dir.join("note.md")).unwrap();
        let (deleted, _) = build_manifest(&dir, &mut HashCache::new());
        let with_delete = reconcile_journal(&dir, &deleted).unwrap();
        assert!(with_delete.operations.iter().any(|op| {
            op.kind == JournalOperationKind::Delete && op.from == "note.md"
        }));

        std::fs::write(dir.join("note.md"), b"restore me").unwrap();
        let (restored, _) = build_manifest(&dir, &mut HashCache::new());
        let journal = reconcile_journal(&dir, &restored).unwrap();
        assert!(!journal.operations.iter().any(|op| {
            op.kind == JournalOperationKind::Delete && op.from == "note.md"
        }));
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
