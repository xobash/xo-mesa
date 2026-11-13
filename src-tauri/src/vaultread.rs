// Read ordered vault-file batches into one binary IPC response.
// Return bytes and distinct failure/skip markers; the frontend owns UTF-8 decoding.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Marker length meaning "this file could not be read". `u32::MAX` can never be
/// a real length here: a file that large would have failed the read anyway.
const READ_FAILED: u32 = u32::MAX;
const READ_SKIPPED: u32 = u32::MAX - 1;
/// An online-only cloud file (OneDrive Files On-Demand) left unread so that
/// background indexing never downloads the vault. Opening the note still loads
/// it through the ordinary read, which downloads on demand.
const READ_OFFLINE: u32 = u32::MAX - 2;
const DEFAULT_MAX_TEXT_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// Requests above this are refused; the frontend sends at most 64 paths.
const MAX_TEXT_READ_BATCH: usize = 128;

/// A renderer may lower the automatic text limit but never raise it.
fn text_file_limit(requested: Option<u64>) -> u64 {
    requested.map_or(DEFAULT_MAX_TEXT_FILE_BYTES, |limit| {
        limit.min(DEFAULT_MAX_TEXT_FILE_BYTES)
    })
}
/// A bulk read is background work.  Eight concurrent filesystem reads retain
/// capacity for the WebView2 UI thread and active editor work on high-core PCs.
const DEFAULT_BULK_READ_WORKERS: usize = 8;

enum ReadResult {
    Content(Vec<u8>),
    Skipped,
    Offline,
    Failed,
}

/// Validate vault-relative paths before filesystem access. Keep vault-read policy independent of sync policy.
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let mut p = root.to_path_buf();
    for seg in rel.replace('\\', "/").split('/') {
        // Hidden entries (`.git`, `.env`, recovery folders) and `node_modules`
        // are not vault documents; `vault_scan` never lists them.
        if seg.is_empty() || crate::vault_names::is_hidden_name(seg) {
            return None;
        }
        // Only plain names: a Windows drive prefix such as `D:x` would make
        // `push` replace the whole path.
        let mut parts = Path::new(seg).components();
        if !matches!(
            (parts.next(), parts.next()),
            (Some(std::path::Component::Normal(_)), None)
        ) {
            return None;
        }
        p.push(seg);
    }
    Some(p)
}

/// The joined path must still resolve to a visible vault entry once links and
/// Windows 8.3 short names (`GIT~1`) are resolved.
fn confined(canonical_root: &Path, path: &Path) -> bool {
    std::fs::canonicalize(path).is_ok_and(|resolved| visible_under(canonical_root, &resolved))
}

fn visible_under(canonical_root: &Path, resolved: &Path) -> bool {
    resolved.strip_prefix(canonical_root).is_ok_and(|rel| {
        rel.components().all(|part| {
            matches!(part, std::path::Component::Normal(name)
                if name.to_str().is_some_and(|name| !crate::vault_names::is_hidden_name(name)))
        })
    })
}

/// Run `job` for every index on workers that pull from a shared cursor.
/// Results come back in index order; a slot stays `None` only if its worker
/// panicked.
fn map_in_order<T: Send>(
    len: usize,
    worker_limit: Option<usize>,
    job: impl Fn(usize) -> T + Sync,
) -> Vec<Option<T>> {
    let mut out: Vec<Option<T>> = (0..len).map(|_| None).collect();
    if len == 0 {
        return out;
    }
    let available = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(len);
    let threads = worker_limit
        .unwrap_or(DEFAULT_BULK_READ_WORKERS)
        .clamp(1, available);
    let cursor = AtomicUsize::new(0);
    let job = &job;

    // Each worker collects (index, result) locally and the results are placed
    // after the join, so no shared mutable buffer is needed.
    let collected: Vec<Vec<(usize, T)>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                let cursor = &cursor;
                scope.spawn(move || {
                    let mut mine = Vec::new();
                    loop {
                        let i = cursor.fetch_add(1, Ordering::Relaxed);
                        if i >= len {
                            break;
                        }
                        mine.push((i, job(i)));
                    }
                    mine
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_default())
            .collect()
    });

    for chunk in collected {
        for (i, value) in chunk {
            debug_assert!(out[i].is_none(), "index {i} was handed out twice");
            out[i] = Some(value);
        }
    }
    debug_assert_eq!(out.len(), len);
    out
}

/// Bulk read in request order.
fn read_all(
    root: &Path,
    rels: &[String],
    max_text_file_bytes: u64,
    worker_limit: Option<usize>,
) -> Vec<ReadResult> {
    let Ok(canonical_root) = std::fs::canonicalize(root) else {
        return (0..rels.len()).map(|_| ReadResult::Failed).collect();
    };
    let canonical_root = &canonical_root;
    // An unreadable file is reported per-file, never as a failure of the
    // batch: one bad file must not cost the other 127 their content.
    map_in_order(rels.len(), worker_limit, |i| {
        safe_join(root, &rels[i])
            .filter(|path| confined(canonical_root, path))
            .map(|path| read_file(&path, max_text_file_bytes))
            .unwrap_or(Ok(ReadResult::Failed))
            .unwrap_or(ReadResult::Failed)
    })
    .into_iter()
    .map(|slot| slot.unwrap_or(ReadResult::Failed))
    .collect()
}

/// Open a regular file without following a final link or blocking on a FIFO
/// or device; the type check uses the opened handle, so a swap cannot slip in.
fn open_regular(path: &Path) -> io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    // Cloud placeholders (OneDrive Files On-Demand) read as files; links do not.
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        !crate::sync_core::platform_fs::handle_is_in_place(&file, meta.file_attributes())?
    };
    #[cfg(not(windows))]
    let reparse = false;
    if !meta.is_file() || reparse {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a file"));
    }
    Ok(file)
}

fn read_file(path: &Path, max_text_file_bytes: u64) -> io::Result<ReadResult> {
    use std::io::Read;
    if crate::sync_core::platform_fs::path_is_not_downloaded(path) {
        return Ok(ReadResult::Offline);
    }
    // Regular files only, matching `vault_scan`'s `is_file` rule: a directory
    // or a device node named in `rels` must read as a failure, not hang.
    let file = open_regular(path)?;
    let len = file.metadata()?.len();
    if len > max_text_file_bytes {
        return Ok(ReadResult::Skipped);
    }
    // A file that grows after the size check still stops at the limit. Sizing
    // the buffer from the checked length avoids doubling copies and up to 2x
    // slack held until the whole batch is encoded.
    let mut bytes = Vec::with_capacity(len as usize);
    file.take(max_text_file_bytes + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_text_file_bytes {
        return Ok(ReadResult::Skipped);
    }
    Ok(ReadResult::Content(bytes))
}

/// Frame the results into one response body.
///
/// ```text
///   u32  count
///   repeat count times:
///     u32  len   (READ_FAILED = unreadable, READ_SKIPPED = over limit,
///                 READ_OFFLINE = online-only cloud file)
///     u8   bytes[len]
/// ```
///
/// All integers are little-endian. `src/lib/vault.ts` `decodeTextChunkOutcomes`
/// is the other half; `vaultReadWire.test.ts` checks the frontend decoder.
fn encode(results: &[ReadResult]) -> Vec<u8> {
    let total: usize = results
        .iter()
        .map(|r| {
            4 + match r {
                ReadResult::Content(bytes) => bytes.len(),
                _ => 0,
            }
        })
        .sum();
    let mut out = Vec::with_capacity(4 + total);
    out.extend_from_slice(&(results.len() as u32).to_le_bytes());
    for result in results {
        match result {
            // A file at or above 4 GiB would collide with the failure marker.
            // It cannot be read into memory here anyway, so report it as one.
            ReadResult::Content(bytes) if bytes.len() < READ_OFFLINE as usize => {
                out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                out.extend_from_slice(bytes);
            }
            ReadResult::Skipped => out.extend_from_slice(&READ_SKIPPED.to_le_bytes()),
            ReadResult::Offline => out.extend_from_slice(&READ_OFFLINE.to_le_bytes()),
            _ => out.extend_from_slice(&READ_FAILED.to_le_bytes()),
        }
    }
    out
}

/// Read many vault files in one round-trip.
///
/// `rels` are vault-relative, forward-slashed paths as produced by
/// `vault_scan`. The response is the framed body described on `encode`.
#[tauri::command]
pub async fn vault_read_text(
    app: tauri::AppHandle,
    root: String,
    rels: Vec<String>,
    max_text_file_bytes: Option<u64>,
    worker_limit: Option<usize>,
) -> Result<tauri::ipc::Response, String> {
    if rels.len() > MAX_TEXT_READ_BATCH {
        return Err("Text read batch exceeds 128 files".into());
    }
    let path = crate::vaultscope::require_approved(&app, &root)?;
    // Blocking syscall work: keep it off the async runtime's worker so other
    // IPC (the editor's own saves, terminal traffic) stays responsive while a
    // batch is in flight.
    let max_text_file_bytes = text_file_limit(max_text_file_bytes);
    let body = tauri::async_runtime::spawn_blocking(move || {
        encode(&read_all(&path, &rels, max_text_file_bytes, worker_limit))
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(body))
}

/// Bounded read-only access replaces generic file handles in privileged renderers.
#[tauri::command]
pub async fn vault_read_bytes(
    app: tauri::AppHandle,
    path: String,
    max_bytes: usize,
    require_complete: bool,
) -> Result<tauri::ipc::Response, String> {
    if max_bytes > 8 * 1024 * 1024 {
        return Err("invalid bounded read limit".into());
    }
    let (root, rel) = crate::vaultscope::approved_path(&app, &path)?;
    let access = crate::vaulttransaction::access(&root).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _access = access;
        read_bounded(&root, &rel, max_bytes, require_complete).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Hidden entries (`.git`, `.env`, recovery folders) are not renderer-readable
/// vault documents, as spelled or after OS resolution.
fn read_bounded(
    root: &Path,
    rel: &str,
    max_bytes: usize,
    require_complete: bool,
) -> Result<Vec<u8>, String> {
    use std::io::Read;
    if !crate::vaultscope::resolves_visible(root, rel) {
        return Err("path is not a visible vault file".into());
    }
    #[cfg(unix)]
    let file = crate::sync_core::RootedTarget::resolve(root, rel, false)
        .map_err(|e| e.to_string())?
        .open_read()
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let _guard = crate::sync_core::WindowsParentGuard::acquire(&root.join(rel), false)
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let file = crate::sync_core::open_file_no_follow(&root.join(rel)).map_err(|e| e.to_string())?;
    let limit = max_bytes + usize::from(require_complete);
    // Capacity hint only; a failed stat keeps the growing buffer.
    let expected = file.metadata().map_or(0, |m| m.len()).min(limit as u64);
    let mut bytes = Vec::with_capacity(expected as usize);
    file.take(limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > max_bytes {
        return Err("File exceeds the inline review limit. Open each copy to review it.".into());
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "vaultread_tests.rs"]
mod tests;

/// Content identity for a reusable frontend index. Never trusts mtime alone.
#[tauri::command]
pub async fn vault_text_fingerprints(
    app: tauri::AppHandle,
    root: String,
    rels: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    if rels.len() > 128 {
        return Err("Fingerprint batch exceeds 128 files".into());
    }
    let root = crate::vaultscope::require_approved(&app, &root)?;
    tauri::async_runtime::spawn_blocking(move || fingerprint_all(&root, &rels, None))
        .await
        .map_err(|e| e.to_string())
}

/// Hash in request order on the bulk-read workers; a miss is per file.
fn fingerprint_all(
    root: &Path,
    rels: &[String],
    worker_limit: Option<usize>,
) -> Vec<Option<String>> {
    let canonical_root = match root.canonicalize() {
        Ok(root) => root,
        Err(_) => return vec![None; rels.len()],
    };
    let canonical_root = &canonical_root;
    map_in_order(rels.len(), worker_limit, |i| {
        fingerprint_file(canonical_root, &rels[i])
    })
    .into_iter()
    .map(Option::flatten)
    .collect()
}

fn fingerprint_file(canonical_root: &Path, rel: &str) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let path = safe_join(canonical_root, rel)?.canonicalize().ok()?;
    // An online-only cloud file is a miss: hashing would download it.
    if !visible_under(canonical_root, &path)
        || crate::sync_core::platform_fs::path_is_not_downloaded(&path)
    {
        return None;
    }
    let mut file = open_regular(&path).ok()?;
    let before = file.metadata().ok()?;
    let mut remaining = before.len();
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    while remaining > 0 {
        let take = remaining.min(buffer.len() as u64) as usize;
        let count = file.read(&mut buffer[..take]).ok()?;
        if count == 0 {
            return None;
        }
        remaining -= count as u64;
        hasher.update(&buffer[..count]);
    }
    let after = file.metadata().ok()?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return None;
    }
    Some(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod fingerprint_tests {
    use super::*;
    /// Parallel hashing must keep request order, per-file misses and the
    /// digests of the serial pass.
    #[test]
    fn parallel_fingerprints_match_the_serial_pass_in_request_order() {
        let root =
            std::env::temp_dir().join(format!("mesa-read-fingerprint-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let mut rels: Vec<String> = Vec::new();
        for i in 0..96usize {
            let rel = format!("n{i}.md");
            std::fs::write(root.join(&rel), vec![(i % 251) as u8; 1 + i * 997]).unwrap();
            rels.push(rel);
            if i % 16 == 0 {
                rels.push(format!("missing{i}.md"));
            }
        }
        rels.push("n3.md".into());
        let serial = fingerprint_all(&root, &rels, Some(1));
        let parallel = fingerprint_all(&root, &rels, Some(8));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(serial, parallel);
        assert_eq!(serial.iter().filter(|digest| digest.is_none()).count(), 6);
        assert_eq!(serial[4], serial[rels.len() - 1]);
        assert_ne!(serial[0], serial[2]);
    }

    #[cfg(unix)]
    #[test]
    fn fifo_and_hidden_paths_never_block_or_read() {
        let root = std::env::temp_dir().join(format!("mesa-read-fifo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join(".mesa-trash")).unwrap();
        std::fs::write(root.join(".git/config"), b"secret").unwrap();
        std::fs::write(root.join(".env"), b"TOKEN=1").unwrap();
        std::fs::write(root.join(".mesa-trash/old.md"), b"deleted").unwrap();
        std::fs::write(root.join("note.md"), b"visible").unwrap();
        let fifo = std::ffi::CString::new(root.join("pipe.md").to_str().unwrap()).unwrap();
        // SAFETY: the path is NUL-terminated and owned for the call.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert_eq!(fingerprint_all(&root, &["pipe.md".into()], None), [None]);
        assert!(read_file(&root.join("pipe.md"), 1024).is_err());
        for hidden in [".git/config", ".env", ".mesa-trash/old.md"] {
            assert!(read_bounded(&root, hidden, 1024, true).is_err(), "{hidden}");
        }
        assert_eq!(
            read_bounded(&root, "note.md", 1024, true).unwrap(),
            b"visible"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_traversal_and_hashes_content_including_empty_files() {
        let root = std::env::temp_dir().join(format!("mesa-index-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("note.md"), b"abc").unwrap();
        std::fs::write(root.join("empty.md"), b"").unwrap();
        let hashes = fingerprint_all(
            &root,
            &[
                "note.md".into(),
                "empty.md".into(),
                "../outside".into(),
                "missing".into(),
            ],
            None,
        );
        assert_eq!(
            hashes[0].as_deref(),
            Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        assert_eq!(
            hashes[1].as_deref(),
            Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
        assert!(hashes[2].is_none() && hashes[3].is_none());
        std::fs::write(root.join("note.md"), b"xyz").unwrap();
        assert_ne!(
            fingerprint_all(&root, &["note.md".into()], None)[0],
            hashes[0]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
