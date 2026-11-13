use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock, Weak};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::sync_core::platform_fs;

// Destructive operations exclude every ordinary save; unrelated saves may overlap.
pub(crate) static WRITE_LOCK: RwLock<()> = RwLock::new(());
static SAVE_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn with_save_lock<T>(target: &Path, run: impl FnOnce() -> T) -> T {
    with_save_gate(&WRITE_LOCK, target, run)
}

fn with_save_gate<T>(gate: &RwLock<()>, target: &Path, run: impl FnOnce() -> T) -> T {
    let identity = target.canonicalize().unwrap_or_else(|_| {
        target
            .parent()
            .and_then(|parent| parent.canonicalize().ok())
            .and_then(|parent| target.file_name().map(|name| parent.join(name)))
            .unwrap_or_else(|| target.to_path_buf())
    });
    #[cfg(any(target_os = "macos", windows))]
    let identity = PathBuf::from(identity.to_string_lossy().to_lowercase());
    let lock = {
        let mut locks = SAVE_LOCKS.lock().unwrap_or_else(|p| p.into_inner());
        locks.retain(|_, value| value.strong_count() > 0);
        if let Some(lock) = locks.get(&identity).and_then(Weak::upgrade) {
            lock
        } else {
            let lock = Arc::new(Mutex::new(()));
            locks.insert(identity, Arc::downgrade(&lock));
            lock
        }
    };
    let _file = lock.lock().unwrap_or_else(|p| p.into_inner());
    let _gate = gate.read().unwrap_or_else(|p| p.into_inner());
    run()
}
static ARTIFACT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExpectedCurrent {
    Any,
    Missing,
    Hash { sha256: String, size: u64 },
}

/// Hash a file. On Windows a short antivirus or indexer lock is retried, so a
/// published save is never reported as failed only because read-back raced it.
fn file_hash(path: &Path) -> io::Result<([u8; 32], u64)> {
    platform_fs::retry_transient_lock(|| file_hash_once(path))
}

fn file_hash_once(path: &Path) -> io::Result<([u8; 32], u64)> {
    let mut file = File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("vault target is not a regular file"));
    }
    let mut hasher = Sha256::new();
    let mut length = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        length += count as u64;
    }
    Ok((hasher.finalize().into(), length))
}

fn observed(path: &Path) -> Result<Option<([u8; 32], u64)>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => file_hash(path)
            .map(Some)
            .map_err(|error| format!("cannot read vault file: {error}")),
        Ok(_) => Err("vault write requires a regular file or missing target".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot inspect vault file: {error}")),
    }
}

fn matches_expected(
    actual: Option<([u8; 32], u64)>,
    expected: &ExpectedCurrent,
) -> Result<(), String> {
    let matches = match expected {
        ExpectedCurrent::Any => true,
        ExpectedCurrent::Missing => actual.is_none(),
        ExpectedCurrent::Hash { sha256, size } => {
            if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("invalid expected vault hash".into());
            }
            actual.is_some_and(|(hash, length)| {
                length == *size && crate::hex::encode(&hash) == sha256.to_ascii_lowercase()
            })
        }
    };
    if matches {
        Ok(())
    } else {
        Err("Current file bytes changed before the verified write.".into())
    }
}

fn artifact_path(target: &Path, label: &str) -> Result<PathBuf, String> {
    let base = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("invalid vault file name")?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let id = ARTIFACT_ID.fetch_add(1, Ordering::Relaxed);
    Ok(target.with_file_name(format!(
        ".{base}.mesa-{label}-{stamp}-{:x}{:x}.tmp",
        std::process::id(),
        id
    )))
}

fn write_staged(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("cannot stage vault write: {error}"))?;
    #[cfg(unix)]
    super::sync_core::file_metadata::private(&file)
        .map_err(|error| format!("cannot restrict staged vault file: {error}"))?;
    file.write_all(data)
        .map_err(|error| format!("cannot stage vault write: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("cannot flush staged vault file: {error}"))
}

/// Persist `target`'s directory entry (no-op on Windows; see `sync_directory`).
fn sync_parent(target: &Path) -> io::Result<()> {
    match target.parent() {
        Some(parent) => super::sync_core::platform_fs::sync_directory(parent),
        None if cfg!(unix) => Err(io::Error::other("vault file has no parent")),
        None => Ok(()),
    }
}

// Retain the actual destination displaced at publication, not a preflight copy.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn replace_preserving(from: &Path, to: &Path, displaced: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let to_c = CString::new(to.as_os_str().as_bytes())?;
    // Before swapping, name the candidate as rescue so a process interruption
    // never leaves displaced user bytes under a disposable save-artifact name.
    super::sync_core::move_file_no_replace(from, displaced)?;
    let displaced_c = CString::new(displaced.as_os_str().as_bytes())?;
    // SAFETY: both C strings are NUL-terminated and outlive the call;
    // AT_FDCWD resolves them relative to the working directory like rename(2).
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            displaced_c.as_ptr(),
            libc::AT_FDCWD,
            to_c.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    // SAFETY: both C strings are NUL-terminated and outlive the call.
    #[cfg(target_os = "macos")]
    let result =
        unsafe { libc::renamex_np(displaced_c.as_ptr(), to_c.as_ptr(), libc::RENAME_SWAP) };
    if result != 0 {
        let error = io::Error::last_os_error();
        // No unsupported-filesystem overwrite fallback: destination is intact.
        let _ = fs::remove_file(displaced);
        return Err(error);
    }
    Ok(())
}

#[cfg(windows)]
fn replace_preserving(from: &Path, to: &Path, displaced: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<u16>>()
    };
    let (from_wide, to_wide, displaced_wide) = (wide(from), wide(to), wide(displaced));
    let replace_once = || {
        // SAFETY: all three paths are NUL-terminated and outlive the call.
        let result = unsafe {
            ReplaceFileW(
                to_wide.as_ptr(),
                from_wide.as_ptr(),
                displaced_wide.as_ptr(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    };
    // Sharing, lock, access and ERROR_UNABLE_TO_REMOVE_REPLACED failures leave
    // both files under their original names. Retry only while that is still
    // true: a backup that already exists means the OS moved something.
    let result = platform_fs::retry_with(
        replace_once,
        |error| platform_fs::is_transient_lock(error) && fs::symlink_metadata(displaced).is_err(),
        std::thread::sleep,
    );
    result.map_err(|error| restore_unmoved_replacement(error, to, displaced))
}

/// ReplaceFileW's ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 leaves the original only
/// at the backup name. Put it back unless another writer created the target.
#[cfg(any(windows, test))]
fn restore_unmoved_replacement(error: io::Error, to: &Path, displaced: &Path) -> io::Error {
    const ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: i32 = 1177;
    if error.raw_os_error() != Some(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2)
        || fs::symlink_metadata(to).is_ok()
    {
        return error;
    }
    match crate::sync_core::move_file_no_replace(displaced, to) {
        Ok(()) => error,
        Err(restore) => io::Error::new(
            error.kind(),
            format!(
                "{error}; original kept at {}: {restore}",
                displaced.display()
            ),
        ),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn replace_preserving(_from: &Path, _to: &Path, _displaced: &Path) -> io::Result<()> {
    Err(io::Error::other(
        "filesystem does not support replacement with displaced-byte preservation",
    ))
}

pub(crate) fn write_atomic(
    target: &Path,
    data: &[u8],
    expected: &ExpectedCurrent,
) -> Result<(), String> {
    write_atomic_at_commit(target, data, expected, || {})
}

fn write_atomic_at_commit(
    target: &Path,
    data: &[u8],
    expected: &ExpectedCurrent,
    at_commit: impl FnOnce(),
) -> Result<(), String> {
    write_atomic_with_replace(target, data, expected, at_commit, replace_preserving)
}

/// A read-only target cannot be replaced on Windows; say so instead of a bare
/// "Access is denied".
const READ_ONLY_TARGET: &str = "read-only: This file is marked read-only, so Mesa cannot save it. Your edits are still open. Clear the file's Read-only attribute in its Properties, then save again.";

fn refuse_read_only_target(read_only: bool) -> Result<(), String> {
    if read_only {
        Err(READ_ONLY_TARGET.into())
    } else {
        Ok(())
    }
}

/// Windows refuses to replace a read-only file. Unix replacement swaps
/// directory entries and keeps working for a mode-0444 file, so only Windows checks.
fn target_is_read_only(target: &Path) -> bool {
    cfg!(windows) && fs::symlink_metadata(target).is_ok_and(|meta| meta.permissions().readonly())
}

/// Remove the retained original after a verified publication. The save has
/// already succeeded, so a cleanup failure must not be reported as a failed
/// save; the leftover keeps a recognised rescue name that recovery lists.
fn discard_displaced(displaced: &Path, remove: impl Fn(&Path) -> io::Result<()>) {
    match platform_fs::retry_transient_lock(|| remove(displaced)) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => eprintln!("[mesa] saved; previous version kept as a recovery copy: {error}"),
    }
}

fn replacement_error(error: io::Error) -> String {
    #[cfg(target_os = "linux")]
    let unsupported = matches!(
        error.raw_os_error(),
        Some(libc::EINVAL | libc::ENOSYS | libc::EOPNOTSUPP)
    );
    #[cfg(target_os = "macos")]
    let unsupported = matches!(
        error.raw_os_error(),
        Some(libc::ENOTSUP | libc::EINVAL | libc::ENOSYS)
    );
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let unsupported = error.kind() == io::ErrorKind::Unsupported;
    if unsupported || error.kind() == io::ErrorKind::Unsupported {
        "unsupported-filesystem: This folder's filesystem does not support Mesa's atomic replace, so edits to existing files cannot be saved here. Your edits are still open; save copies outside the vault or move the vault to a filesystem that supports atomic replacement.".into()
    } else {
        format!("cannot publish vault file: {error}")
    }
}

fn write_atomic_with_replace(
    target: &Path,
    data: &[u8],
    expected: &ExpectedCurrent,
    at_commit: impl FnOnce(),
    replace: impl FnOnce(&Path, &Path, &Path) -> io::Result<()>,
) -> Result<(), String> {
    if data.len() > 1024 * 1024 * 1024 {
        return Err("vault file exceeds the 1 GiB save limit".into());
    }
    let initial = observed(target)?;
    matches_expected(initial, expected)?;
    refuse_read_only_target(initial.is_some() && target_is_read_only(target))?;
    let temporary = artifact_path(target, "save")?;
    let displaced = artifact_path(target, "rescue")?;
    let candidate = (Sha256::digest(data).into(), data.len() as u64);
    let result = (|| {
        write_staged(&temporary, data)?;
        if file_hash(&temporary).map_err(|e| e.to_string())? != candidate {
            return Err("staged vault file failed verification".into());
        }
        sync_parent(&temporary).map_err(|e| e.to_string())?;
        let before_commit = observed(target)?;
        matches_expected(before_commit, expected)?;
        if initial != before_commit {
            return Err("Current file bytes changed before the verified write.".into());
        }
        #[cfg(unix)]
        if before_commit.is_some() {
            let mut options = OpenOptions::new();
            use std::os::unix::fs::OpenOptionsExt;
            let original = options
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(target)
                .map_err(|e| e.to_string())?;
            let staged = OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&temporary)
                .map_err(|e| e.to_string())?;
            super::sync_core::file_metadata::preserve(&original, &staged)
                .map_err(|e| format!("cannot preserve vault access metadata: {e}"))?;
        }
        at_commit();
        if let Some(original) = before_commit {
            replace(&temporary, target, &displaced).map_err(replacement_error)?;
            sync_parent(target).map_err(|e| e.to_string())?;
            // A writer can change the destination after the last comparison.
            // Compare the version retained by the OS at the instant of commit.
            if observed(&displaced)? != Some(original) {
                return Err("Current file bytes changed during the verified write.".into());
            }
        } else {
            // The no-replace primitive retries short Windows locks itself.
            super::sync_core::move_file_no_replace(&temporary, target)
                .map_err(|e| format!("cannot publish vault file: {e}"))?;
            sync_parent(target).map_err(|e| e.to_string())?;
        }
        if observed(target)? != Some(candidate) {
            return Err("Published vault file changed before read-back completed.".into());
        }
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    if let Err(error) = result {
        // Never restore over a later writer. Even a failed ReplaceFileW can
        // leave a backup; preserve it and name it in the error.
        if displaced.exists() {
            return Err(format!(
                "{error} Displaced file preserved at {}. Review both versions before retrying.",
                displaced.display()
            ));
        }
        return Err(error);
    }
    if displaced.exists() {
        discard_displaced(&displaced, |path| fs::remove_file(path));
        // The publication was already flushed; this only persists the cleanup.
        let _ = sync_parent(target);
    }
    Ok(())
}

fn export_copy(path: &Path, vaults: &[PathBuf], data: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("copy has no parent")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    // An unavailable vault cannot contain the existing, canonical parent.
    if vaults
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| parent.starts_with(root))
    {
        return Err("Choose a destination outside the vault.".into());
    }
    let name = path.file_name().ok_or("copy has no filename")?;
    let target = parent.join(name);
    write_staged(&target, data)?;
    if file_hash(&target).map_err(|e| e.to_string())?
        != (Sha256::digest(data).into(), data.len() as u64)
    {
        return Err("Saved copy failed verification; choose another path.".into());
    }
    sync_parent(&target).map_err(|e| e.to_string())
}

/// Only a native user-selected, new file outside the vault may receive recovery text.
#[tauri::command]
pub async fn text_save_copy(
    app: AppHandle,
    window: tauri::Window,
    root: String,
    name: String,
    content: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    if window.label() != "main" {
        return Err("recovery copies belong to the main workspace".into());
    }
    if content.len() > 64 * 1024 * 1024 {
        return Err("recovery copy exceeds 64 MiB".into());
    }
    let root = crate::vaultscope::require_approved(&app, &root)?;
    let name = Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("note-copy.txt")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .set_title("Save unsaved text copy (choose a new file outside the vault)")
            .set_file_name(name)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        export_copy(&path, &[root], content.as_bytes())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn research_export_caller(label: &str) -> bool {
    label == "main" || label.starts_with("agent-") || label.starts_with("research-")
}

/// Deep Research exports leave Mesa only as a native user-selected, new file
/// outside every approved vault; the renderer never names the destination.
#[tauri::command]
pub async fn research_kit_save(
    app: AppHandle,
    window: tauri::Window,
    name: String,
    content: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    if !research_export_caller(window.label()) {
        return Err("research exports belong to Pi and research windows".into());
    }
    if content.len() > 64 * 1024 * 1024 {
        return Err("research export exceeds 64 MiB".into());
    }
    let vaults = crate::vaultscope::approved_roots(&app)?;
    let name = Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("mesa-deep-research.md")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .set_title("Save Deep Research export (choose a new file outside the vault)")
            .add_filter("Markdown", &["md"])
            .set_file_name(name)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        export_copy(&path, &vaults, content.as_bytes())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

const PATH_HEADER: &str = "x-mesa-path";
const EXPECTED_HEADER: &str = "x-mesa-expected";

/// Target path (UTF-8 bytes as hex, because header values are ASCII) and the
/// expected-current state travel in headers; the file bytes are the raw
/// request body, so a large save never becomes a JSON number array.
fn parse_write_request(
    headers: &tauri::http::HeaderMap,
    body: &tauri::ipc::InvokeBody,
) -> Result<(String, ExpectedCurrent, Vec<u8>), String> {
    let tauri::ipc::InvokeBody::Raw(data) = body else {
        return Err("vault write needs a raw byte body".into());
    };
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| format!("missing {name} header"))
    };
    let path_hex = header(PATH_HEADER)?;
    if path_hex.is_empty() || !path_hex.len().is_multiple_of(2) {
        return Err("invalid vault write path".into());
    }
    let path_bytes = crate::hex::decode(path_hex).ok_or("invalid vault write path")?;
    let path = String::from_utf8(path_bytes).map_err(|_| "invalid vault write path")?;
    let expected: ExpectedCurrent = serde_json::from_str(header(EXPECTED_HEADER)?)
        .map_err(|_| "invalid expected vault state".to_string())?;
    Ok((path, expected, data.clone()))
}

/// One native transaction for approved-vault writes. Heavy IO runs outside the
/// webview thread. One target serializes; unrelated saves may overlap.
#[tauri::command]
pub async fn vault_write_atomic(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let (path, expected, data) = parse_write_request(request.headers(), request.body())?;
    if matches!(expected, ExpectedCurrent::Any) {
        return Err("verified saves require an expected hash or missing target".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let target = super::vaultscope::require_approved_write_target(&app, &path)?;
        with_save_lock(&target, || {
            let current = super::vaultscope::require_approved_write_target(&app, &path)?;
            if current != target {
                return Err("Vault target moved while waiting to save.".into());
            }
            crate::vaulttransaction::require_recovered_target(&target)?;
            write_atomic(&target, &data, &expected)
        })
    })
    .await
    .map_err(|error| format!("vault write worker failed: {error}"))?
}

#[cfg(test)]
#[path = "vaultwrite_tests.rs"]
mod tests;

#[cfg(all(test, unix))]
#[path = "vaultwrite_metadata_tests.rs"]
mod metadata_tests;
