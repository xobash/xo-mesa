//! The one atomic replace primitive for in-vault replacement (saves, research
//! apply and sync edits). In a single OS step the new bytes take the target's
//! name and the displaced original keeps a name of its own: Linux
//! `RENAME_EXCHANGE`, macOS `RENAME_SWAP`, Windows `ReplaceFileW` with a
//! backup. There is no two-rename or overwrite fallback; a filesystem without
//! the primitive refuses and leaves the target untouched.
use std::io;
use std::path::Path;

#[cfg(unix)]
use std::ffi::CStr;
#[cfg(unix)]
use std::os::fd::RawFd;

/// The typed refusal for a platform without atomic replace.
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn atomic_replace_unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "filesystem does not support replacement with displaced-byte preservation",
    )
}

/// Whether a replace failure means the filesystem lacks the primitive (the
/// target is intact), as opposed to an ordinary I/O failure.
pub(crate) fn is_atomic_replace_unsupported(error: &io::Error) -> bool {
    #[cfg(target_os = "linux")]
    let native = matches!(
        error.raw_os_error(),
        Some(libc::EINVAL | libc::ENOSYS | libc::EOPNOTSUPP)
    );
    #[cfg(target_os = "macos")]
    let native = matches!(
        error.raw_os_error(),
        Some(libc::ENOTSUP | libc::EINVAL | libc::ENOSYS)
    );
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let native = false;
    native || error.kind() == io::ErrorKind::Unsupported
}

/// Atomically swap two directory entries, each named relative to a directory
/// descriptor (`libc::AT_FDCWD` for a path relative to the working directory).
/// Both entries must exist on one filesystem; neither is ever missing.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn exchange_at(
    from_dir: RawFd,
    from: &CStr,
    to_dir: RawFd,
    to: &CStr,
) -> io::Result<()> {
    // SAFETY: both names are NUL-terminated and outlive the call; the caller
    // keeps both directory descriptors open (or passes AT_FDCWD).
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            from_dir,
            from.as_ptr(),
            to_dir,
            to.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    // SAFETY: as above.
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            from_dir,
            from.as_ptr(),
            to_dir,
            to.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub(crate) fn exchange_at(
    _from_dir: RawFd,
    _from: &CStr,
    _to_dir: RawFd,
    _to: &CStr,
) -> io::Result<()> {
    Err(atomic_replace_unsupported())
}

/// Path form. On success `to` holds the bytes `from` held and `displaced` (an
/// unused name on `to`'s volume) holds the bytes `to` held at the instant of
/// replacement. On failure `to` is untouched.
///
/// Unix first names the candidate `displaced`, so an interruption never
/// leaves the displaced original under the candidate's disposable name.
#[cfg(unix)]
pub(crate) fn replace_preserving(from: &Path, to: &Path, displaced: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let to_c = CString::new(to.as_os_str().as_bytes())?;
    let displaced_c = CString::new(displaced.as_os_str().as_bytes())?;
    super::move_file_no_replace(from, displaced)?;
    if let Err(error) = exchange_at(libc::AT_FDCWD, &displaced_c, libc::AT_FDCWD, &to_c) {
        // The destination is intact; only the moved candidate is dropped.
        let _ = std::fs::remove_file(displaced);
        return Err(error);
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn replace_preserving(from: &Path, to: &Path, displaced: &Path) -> io::Result<()> {
    use super::platform_fs;
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
        |error| {
            platform_fs::is_transient_lock(error) && std::fs::symlink_metadata(displaced).is_err()
        },
        std::thread::sleep,
    );
    result.map_err(|error| restore_unmoved_replacement(error, to, displaced))
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn replace_preserving(_from: &Path, _to: &Path, _displaced: &Path) -> io::Result<()> {
    Err(atomic_replace_unsupported())
}

/// ReplaceFileW's ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 leaves the original only
/// at the backup name. Put it back unless another writer created the target.
#[cfg(any(windows, test))]
pub(crate) fn restore_unmoved_replacement(
    error: io::Error,
    to: &Path,
    displaced: &Path,
) -> io::Error {
    const ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: i32 = 1177;
    if error.raw_os_error() != Some(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2)
        || std::fs::symlink_metadata(to).is_ok()
    {
        return error;
    }
    match super::move_file_no_replace(displaced, to) {
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
