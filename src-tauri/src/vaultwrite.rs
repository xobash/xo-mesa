use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

pub(crate) static WRITE_LOCK: Mutex<()> = Mutex::new(());
static ARTIFACT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExpectedCurrent {
    Any,
    Missing,
    Hash { sha256: String, size: u64 },
}

fn file_hash(path: &Path) -> io::Result<([u8; 32], u64)> {
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
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("cannot stage vault write: {error}"))?;
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
    let from = wide(from);
    let to = wide(to);
    let displaced = wide(displaced);
    let result = unsafe {
        ReplaceFileW(
            to.as_ptr(),
            from.as_ptr(),
            displaced.as_ptr(),
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
    if data.len() > 1024 * 1024 * 1024 {
        return Err("vault file exceeds the 1 GiB save limit".into());
    }
    let initial = observed(target)?;
    matches_expected(initial, expected)?;
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
        at_commit();
        if let Some(original) = before_commit {
            replace_preserving(&temporary, target, &displaced)
                .map_err(|e| format!("cannot publish vault file: {e}"))?;
            sync_parent(target).map_err(|e| e.to_string())?;
            // A writer can change the destination after the last comparison.
            // Compare the version retained by the OS at the instant of commit.
            if observed(&displaced)? != Some(original) {
                return Err("Current file bytes changed during the verified write.".into());
            }
        } else {
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
        fs::remove_file(&displaced)
            .map_err(|e| format!("saved, but rescue cleanup failed: {e}"))?;
        sync_parent(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// One native transaction for approved-vault writes. Heavy IO runs outside the
/// webview thread and only one Mesa save can compare and publish at a time.
#[tauri::command]
pub async fn vault_write_atomic(
    app: AppHandle,
    path: String,
    data: Vec<u8>,
    expected: ExpectedCurrent,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = WRITE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let target = super::vaultscope::require_approved_write_target(&app, &path)?;
        crate::vaulttransaction::require_recovered_target(&target)?;
        write_atomic(&target, &data, &expected)
    })
    .await
    .map_err(|error| format!("vault write worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_folder(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("mesa-atomic-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
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
