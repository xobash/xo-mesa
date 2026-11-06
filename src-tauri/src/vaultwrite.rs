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

fn hex_hash(hash: &[u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for byte in hash {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 15) as usize] as char);
    }
    out
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
                length == *size && hex_hash(&hash) == sha256.to_ascii_lowercase()
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

#[cfg(unix)]
fn sync_parent(target: &Path) -> io::Result<()> {
    File::open(
        target
            .parent()
            .ok_or_else(|| io::Error::other("vault file has no parent"))?,
    )?
    .sync_all()
}

#[cfg(windows)]
fn sync_parent(_target: &Path) -> io::Result<()> {
    // Windows directory durability still
    // requires platform acceptance and is not claimed as a power-loss guarantee.
    Ok(())
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
    let path_bytes = path_hex
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |byte: u8| (byte as char).to_digit(16).map(|value| value as u8);
            Some(digit(pair[0])? << 4 | digit(pair[1])?)
        })
        .collect::<Option<Vec<u8>>>()
        .ok_or("invalid vault write path")?;
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
mod tests {
    use super::*;
    #[test]
    fn unmoved_replacement_restores_the_original_only_into_a_missing_target() {
        let dir = std::env::temp_dir().join(format!("mesa-replace-2-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (target, displaced) = (
            dir.join("note.md"),
            dir.join(".note.md.mesa-backup-1-a.tmp"),
        );
        fs::write(&displaced, b"original").unwrap();
        let error =
            restore_unmoved_replacement(io::Error::from_raw_os_error(1177), &target, &displaced);
        assert_eq!(error.raw_os_error(), Some(1177));
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert!(!displaced.exists());
        fs::write(&displaced, b"second").unwrap();
        restore_unmoved_replacement(io::Error::from_raw_os_error(1177), &target, &displaced);
        assert_eq!(
            fs::read(&target).unwrap(),
            b"original",
            "an existing target is never replaced"
        );
        assert_eq!(fs::read(&displaced).unwrap(), b"second");
        restore_unmoved_replacement(
            io::Error::from_raw_os_error(5),
            &dir.join("gone.md"),
            &displaced,
        );
        assert!(displaced.exists(), "other failures keep the displaced file");
        fs::remove_dir_all(dir).unwrap();
    }

    fn headers(path_hex: &str, expected: &str) -> tauri::http::HeaderMap {
        let mut map = tauri::http::HeaderMap::new();
        map.insert(PATH_HEADER, path_hex.parse().unwrap());
        map.insert(EXPECTED_HEADER, expected.parse().unwrap());
        map
    }

    #[test]
    fn write_request_headers_and_raw_body_are_validated() {
        let body = tauri::ipc::InvokeBody::Raw(vec![0, 255, 7]);
        let hex: String = "/v/näme.md"
            .bytes()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let (path, expected, data) =
            parse_write_request(&headers(&hex, r#"{"kind":"missing"}"#), &body).unwrap();
        assert_eq!(path, "/v/näme.md");
        assert!(matches!(expected, ExpectedCurrent::Missing));
        assert_eq!(data, vec![0, 255, 7]);

        let hash = r#"{"kind":"hash","sha256":"ab","size":3}"#;
        assert!(parse_write_request(&headers(&hex, hash), &body).is_ok());
        for (path_hex, expected) in [
            ("", r#"{"kind":"missing"}"#),
            ("abc", r#"{"kind":"missing"}"#),
            ("zz", r#"{"kind":"missing"}"#),
            ("ff", r#"{"kind":"missing"}"#),
            (hex.as_str(), "not json"),
            (hex.as_str(), r#"{"kind":"bogus"}"#),
        ] {
            assert!(
                parse_write_request(&headers(path_hex, expected), &body).is_err(),
                "{path_hex} {expected}"
            );
        }
        assert!(parse_write_request(&tauri::http::HeaderMap::new(), &body).is_err());
        let json_body = tauri::ipc::InvokeBody::Json(serde_json::json!({"data": [1, 2]}));
        assert!(parse_write_request(&headers(&hex, r#"{"kind":"missing"}"#), &json_body).is_err());
    }

    fn test_folder(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("mesa-atomic-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn different_save_targets_overlap_but_destructive_operations_wait() {
        let dir = test_folder("parallel-save");
        let gate = Arc::new(RwLock::new(()));
        let first_gate = gate.clone();
        let a = dir.join("a.md");
        let b = dir.join("b.md");
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            with_save_gate(&first_gate, &a, || {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            })
        });
        entered_rx.recv().unwrap();
        assert!(gate.try_write().is_err());
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let other_gate = gate.clone();
        let other = std::thread::spawn(move || {
            with_save_gate(&other_gate, &b, || done_tx.send(()).unwrap())
        });
        let done = done_rx.recv_timeout(std::time::Duration::from_secs(2));
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        other.join().unwrap();
        assert!(done.is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn same_save_target_serializes_including_case_aliases() {
        let dir = test_folder("serial-save");
        let target = dir.join("a.md");
        fs::write(&target, b"old").unwrap();
        let first = target.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            with_save_lock(&first, || {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            })
        });
        entered_rx.recv().unwrap();
        #[cfg(any(target_os = "macos", windows))]
        let target = target.with_file_name("A.md");
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let second =
            std::thread::spawn(move || with_save_lock(&target, || done_tx.send(()).unwrap()));
        assert!(done_rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        second.join().unwrap();
        done_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unsupported_replacement_leaves_original_and_clear_error() {
        let dir = test_folder("unsupported");
        let target = dir.join("note.md");
        fs::write(&target, b"old").unwrap();
        let error = write_atomic_with_replace(
            &target,
            b"new",
            &ExpectedCurrent::Any,
            || {},
            |_, _, _| Err(io::Error::new(io::ErrorKind::Unsupported, "unsupported")),
        )
        .unwrap_err();
        // All platforms recognize typed unsupported errors as well as native codes.
        assert!(error.contains("atomic replace"));
        assert_eq!(fs::read(&target).unwrap(), b"old");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        for code in [libc::EINVAL, libc::ENOSYS, libc::ENOTSUP] {
            assert!(replacement_error(io::Error::from_raw_os_error(code))
                .contains("unsupported-filesystem:"));
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn published_save_succeeds_when_rescue_cleanup_fails() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return; // root ignores directory permissions
        }
        let dir = test_folder("cleanup-fails");
        let target = dir.join("note.md");
        fs::write(&target, b"old").unwrap();
        let locked = dir.clone();
        let result = write_atomic_with_replace(
            &target,
            b"new",
            &ExpectedCurrent::Any,
            || {},
            |from, to, displaced| {
                replace_preserving(from, to, displaced)?;
                // The rescue can no longer be removed, as when another process
                // holds it on Windows.
                fs::set_permissions(&locked, fs::Permissions::from_mode(0o555))
            },
        );
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        // The new bytes were published and read back, so the save succeeded.
        assert_eq!(result, Ok(()));
        assert_eq!(fs::read(&target).unwrap(), b"new");
        let rescues: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".mesa-rescue-"))
            .collect();
        assert_eq!(rescues.len(), 1, "the old version stays recoverable");
        assert_eq!(fs::read(dir.join(&rescues[0])).unwrap(), b"old");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn read_only_targets_get_a_clear_message() {
        let error = refuse_read_only_target(true).unwrap_err();
        assert!(error.starts_with("read-only:"));
        assert!(error.contains("edits are still open"));
        assert!(refuse_read_only_target(false).is_ok());
        // Only Windows refuses read-only replacement; Unix saves keep working.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = test_folder("read-only");
            let target = dir.join("note.md");
            fs::write(&target, b"old").unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o444)).unwrap();
            assert!(!target_is_read_only(&target));
            write_atomic(&target, b"new", &ExpectedCurrent::Any).unwrap();
            assert_eq!(fs::read(&target).unwrap(), b"new");
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn recovery_copy_requires_new_file_outside_vault_and_verifies_text() {
        let dir = test_folder("export");
        let root = dir.join("vault");
        fs::create_dir(&root).unwrap();
        let vaults = [root.clone()];
        assert!(export_copy(&root.join("copy.md"), &vaults, b"draft").is_err());
        let target = dir.join("copy.md");
        export_copy(&target, &vaults, b"draft").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"draft");
        assert!(export_copy(&target, &vaults, b"other").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"draft");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&root, dir.join("alias")).unwrap();
            assert!(export_copy(&dir.join("alias/copy.md"), &vaults, b"draft").is_err());
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn research_export_refuses_every_approved_vault_and_other_windows() {
        let dir = test_folder("research-export");
        let (first, second) = (dir.join("first"), dir.join("second"));
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let vaults = [dir.join("unplugged"), first, second.clone()];
        let error = export_copy(&second.join("kit.md"), &vaults, b"kit").unwrap_err();
        assert!(error.contains("outside the vault"));
        assert!(!second.join("kit.md").exists());
        export_copy(&dir.join("kit.md"), &vaults, b"kit").unwrap();
        assert_eq!(fs::read(dir.join("kit.md")).unwrap(), b"kit");
        for label in ["main", "agent-1", "research-1"] {
            assert!(research_export_caller(label), "{label}");
        }
        for label in ["doc-1", "panel-graph", "tray", "pi-harness"] {
            assert!(!research_export_caller(label), "{label}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replaces_existing_bytes_and_leaves_no_artifacts() {
        let dir = test_folder("replace");
        let target = dir.join("note.md");
        fs::write(&target, b"old").unwrap();
        let expected = ExpectedCurrent::Hash {
            sha256: hex_hash(&Sha256::digest(b"old").into()),
            size: 3,
        };
        write_atomic(&target, b"new", &expected).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn edit_in_final_check_window_is_preserved_and_reported() {
        let dir = test_folder("raced");
        let target = dir.join("note.md");
        fs::write(&target, b"old").unwrap();
        let expected = ExpectedCurrent::Hash {
            sha256: hex_hash(&Sha256::digest(b"old").into()),
            size: 3,
        };
        let error = write_atomic_at_commit(&target, b"mine", &expected, || {
            fs::write(&target, b"external raced edit").unwrap();
        })
        .unwrap_err();
        assert!(error.contains("changed during"));
        let rescue = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains("mesa-rescue")
            })
            .unwrap();
        assert_eq!(fs::read(rescue).unwrap(), b"external raced edit");
        assert_eq!(fs::read(&target).unwrap(), b"mine");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn creator_in_final_check_window_is_never_overwritten() {
        let dir = test_folder("create-race");
        let target = dir.join("note.md");
        assert!(
            write_atomic_at_commit(&target, b"mine", &ExpectedCurrent::Missing, || {
                fs::write(&target, b"external").unwrap();
            })
            .is_err()
        );
        assert_eq!(fs::read(&target).unwrap(), b"external");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_precondition_cannot_replace_a_file() {
        let dir = test_folder("missing");
        let target = dir.join("note.md");
        fs::write(&target, b"external").unwrap();
        assert!(write_atomic(&target, b"mine", &ExpectedCurrent::Missing).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"external");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn creates_a_new_file_without_artifacts() {
        let dir = test_folder("create");
        let target = dir.join("note.md");
        write_atomic(&target, b"new", &ExpectedCurrent::Missing).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let _ = fs::remove_dir_all(dir);
    }
}

#[cfg(all(test, unix))]
mod metadata_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn stage_and_new_files_are_private_and_existing_modes_survive() {
        let dir = std::env::temp_dir().join(format!("mesa-save-metadata-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let stage = dir.join("stage");
        write_staged(&stage, b"private").unwrap();
        assert_eq!(
            fs::metadata(&stage).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let target = dir.join("note");
        write_atomic(&target, b"new", &ExpectedCurrent::Missing).unwrap();
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
        for mode in [0o600, 0o640, 0o604] {
            fs::set_permissions(&target, fs::Permissions::from_mode(mode)).unwrap();
            write_atomic(&target, b"edited", &ExpectedCurrent::Any).unwrap();
            assert_eq!(
                fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                mode
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_acl_and_xattrs_survive_save_and_inherited_acl_is_removed() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("mesa-save-acl-{}", std::process::id()));
        if dir.exists() {
            let _ = Command::new("chmod").arg("-RN").arg(&dir).status();
            let _ = fs::remove_dir_all(&dir);
        }
        fs::create_dir_all(&dir).unwrap();
        assert!(Command::new("chmod")
            .args(["+a", "everyone allow read,file_inherit,directory_inherit"])
            .arg(&dir)
            .status()
            .unwrap()
            .success());
        let target = dir.join("note");
        write_atomic(&target, b"private", &ExpectedCurrent::Missing).unwrap();
        let acl = |path: &Path| {
            let result = Command::new("ls").args(["-le"]).arg(path).output().unwrap();
            assert!(result.status.success());
            String::from_utf8(result.stdout)
                .unwrap()
                .lines()
                .skip(1)
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert!(
            acl(&target).is_empty(),
            "New plaintext must not inherit broad ACL grants"
        );
        assert!(Command::new("chmod")
            .args(["+a", "everyone allow read"])
            .arg(&target)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("xattr")
            .args(["-w", "org.mesa.test", "synthetic-value"])
            .arg(&target)
            .status()
            .unwrap()
            .success());
        let before = acl(&target);
        assert!(!before.is_empty());
        write_atomic(&target, b"edited", &ExpectedCurrent::Any).unwrap();
        assert_eq!(acl(&target), before);
        let value = Command::new("xattr")
            .args(["-p", "org.mesa.test"])
            .arg(&target)
            .output()
            .unwrap();
        assert!(value.status.success());
        assert_eq!(value.stdout, b"synthetic-value\n");
        assert!(Command::new("chmod")
            .arg("-RN")
            .arg(&dir)
            .status()
            .unwrap()
            .success());
        fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_posix_acl_and_user_xattr_survive_replacement() {
        use std::ffi::CString;
        use std::os::fd::AsRawFd;
        let dir = std::env::temp_dir().join(format!("mesa-save-acl-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("note");
        write_atomic(&target, b"private", &ExpectedCurrent::Missing).unwrap();
        let file = File::open(&target).unwrap();
        let mut acl = 2u32.to_le_bytes().to_vec();
        for (tag, perm, id) in [
            (1u16, 6u16, u32::MAX),
            (2, 4, 65534),
            (4, 0, u32::MAX),
            (16, 0, u32::MAX),
            (32, 0, u32::MAX),
        ] {
            acl.extend(tag.to_le_bytes());
            acl.extend(perm.to_le_bytes());
            acl.extend(id.to_le_bytes());
        }
        for (name, bytes) in [
            ("system.posix_acl_access", acl.as_slice()),
            ("user.mesa_test", b"synthetic-value".as_slice()),
        ] {
            let name = CString::new(name).unwrap();
            // SAFETY: live fd, terminated name and valid buffer length.
            assert_eq!(
                unsafe {
                    libc::fsetxattr(
                        file.as_raw_fd(),
                        name.as_ptr(),
                        bytes.as_ptr().cast(),
                        bytes.len(),
                        0,
                    )
                },
                0
            );
        }
        write_atomic(&target, b"edited", &ExpectedCurrent::Any).unwrap();
        let file = File::open(&target).unwrap();
        for (name, expected) in [
            ("system.posix_acl_access", acl.as_slice()),
            ("user.mesa_test", b"synthetic-value".as_slice()),
        ] {
            let name = CString::new(name).unwrap();
            let mut value = vec![0u8; 1024];
            // SAFETY: live fd, terminated name and allocated output buffer.
            let n = unsafe {
                libc::fgetxattr(
                    file.as_raw_fd(),
                    name.as_ptr(),
                    value.as_mut_ptr().cast(),
                    value.len(),
                )
            };
            assert!(n >= 0);
            assert_eq!(&value[..n as usize], expected);
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
