// Windows filesystem policy shared by vault reads, saves, recovery and sync.
// The classifiers and the retry policy are pure, so every platform tests them;
// only the thin handle queries are Windows-only. Classifiers that only
// Windows code calls carry a per-item `allow(dead_code)` off Windows.

use std::io;
use std::time::Duration;

/// `FILE_ATTRIBUTE_REPARSE_POINT`.
#[cfg_attr(not(windows), allow(dead_code))]
pub const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

// Reparse tags from winnt.h.
#[cfg_attr(not(windows), allow(dead_code))]
pub const IO_REPARSE_TAG_DEDUP: u32 = 0x8000_0013;
#[cfg_attr(not(windows), allow(dead_code))]
pub const IO_REPARSE_TAG_WOF: u32 = 0x8000_0017;
/// `IO_REPARSE_TAG_CLOUD`; `CLOUD_1`..`CLOUD_F` differ only in bits 12-15.
#[cfg_attr(not(windows), allow(dead_code))]
pub const IO_REPARSE_TAG_CLOUD: u32 = 0x9000_001A;
#[cfg_attr(not(windows), allow(dead_code))]
const CLOUD_TAG_MASK: u32 = 0xFFFF_0FFF;
/// Set on every tag that names another entry (symlink, junction, WSL link).
#[cfg_attr(not(windows), allow(dead_code))]
const NAME_SURROGATE_BIT: u32 = 0x2000_0000;

/// True when a reparse point keeps the entry's own data at this path:
/// cloud placeholders (OneDrive Files On-Demand and other Cloud Files
/// providers), Data Deduplication and WOF-compressed files. Everything else,
/// including every link-like and every unknown tag, is refused, so a new
/// redirecting tag cannot open a path outside the vault.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn reparse_tag_keeps_data_in_place(tag: u32) -> bool {
    if tag & NAME_SURROGATE_BIT != 0 {
        return false;
    }
    tag & CLOUD_TAG_MASK == IO_REPARSE_TAG_CLOUD
        || matches!(tag, IO_REPARSE_TAG_DEDUP | IO_REPARSE_TAG_WOF)
}

/// An entry Mesa may treat as itself: no reparse point, or one whose tag keeps
/// the data in place. Symlinks, junctions and mount points never pass.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn entry_is_in_place(attributes: u32, tag: u32) -> bool {
    attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 || reparse_tag_keeps_data_in_place(tag)
}

/// Read attributes and reparse tag from an open handle. Open it with
/// `FILE_FLAG_OPEN_REPARSE_POINT` so the handle is the entry itself.
#[cfg(windows)]
pub fn handle_attribute_tag(file: &std::fs::File) -> io::Result<(u32, u32)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileAttributeTagInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_TAG_INFO,
    };
    let mut info = FILE_ATTRIBUTE_TAG_INFO {
        FileAttributes: 0,
        ReparseTag: 0,
    };
    // SAFETY: the handle is open for the call and `info` is a valid buffer of
    // the size passed.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileAttributeTagInfo,
            (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((info.FileAttributes, info.ReparseTag))
}

/// [`entry_is_in_place`] for an open handle. `attributes` from the handle's
/// metadata skips the tag query for ordinary entries.
#[cfg(windows)]
pub fn handle_is_in_place(file: &std::fs::File, attributes: u32) -> io::Result<bool> {
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        return Ok(true);
    }
    let (attributes, tag) = handle_attribute_tag(file)?;
    Ok(entry_is_in_place(attributes, tag))
}

/// [`entry_is_in_place`] for a path, without following a final reparse point.
/// `attributes` from existing metadata skips the extra open for ordinary entries.
#[cfg(windows)]
pub fn path_is_in_place(path: &std::path::Path, attributes: u32) -> io::Result<bool> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        return Ok(true);
    }
    let file = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    handle_is_in_place(&file, attributes)
}

/// Data of this file is not on the device: reading it starts a download from
/// the cloud provider (OneDrive Files On-Demand, other Cloud Files providers,
/// HSM). FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN,
/// FILE_ATTRIBUTE_OFFLINE.
#[cfg_attr(not(windows), allow(dead_code))]
pub const NOT_DOWNLOADED_ATTRIBUTES: u32 = 0x0040_0000 | 0x0004_0000 | 0x0000_1000;

#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_not_downloaded(attributes: u32) -> bool {
    attributes & NOT_DOWNLOADED_ATTRIBUTES != 0
}

/// Sync never reads a file that is only in the cloud: hashing it would
/// download the whole vault, and leaving it out of the manifest could look like
/// a deletion to a peer. The scan reports it instead, and sync stops before it
/// plans any change.
#[cfg_attr(not(windows), allow(dead_code))]
pub const NOT_DOWNLOADED_SYNC_ERROR: &str = "file is online-only (not downloaded from cloud storage); make this folder available offline (OneDrive: Always keep on this device), then sync again";

/// Attributes for `path` without opening it, so a cloud file is not recalled.
#[cfg(windows)]
pub fn path_attributes(path: &std::path::Path) -> Option<u32> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetFileAttributesW, INVALID_FILE_ATTRIBUTES};
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is NUL-terminated and outlives the call.
    let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
    (attributes != INVALID_FILE_ATTRIBUTES).then_some(attributes)
}

/// True when `path` is a cloud file whose data is not on this device.
/// Always false off Windows.
pub fn path_is_not_downloaded(path: &std::path::Path) -> bool {
    #[cfg(windows)]
    {
        path_attributes(path).is_some_and(is_not_downloaded)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

/// Windows errors that another process (antivirus, the search indexer, a cloud
/// sync client) commonly causes by holding a file for a moment:
/// ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION and
/// ERROR_UNABLE_TO_REMOVE_REPLACED.
pub const TRANSIENT_LOCK_ERRORS: [i32; 4] = [5, 32, 33, 1175];
/// Waits before each retry: at most five retries, 700 ms in all.
pub const TRANSIENT_RETRY_DELAYS_MS: [u64; 5] = [50, 100, 150, 200, 200];

pub fn is_transient_lock_code(code: i32) -> bool {
    TRANSIENT_LOCK_ERRORS.contains(&code)
}

/// Run `op`, retrying with [`TRANSIENT_RETRY_DELAYS_MS`] while `transient`
/// accepts its error. Returns the first success or the last error.
pub fn retry_with<T>(
    mut op: impl FnMut() -> io::Result<T>,
    transient: impl Fn(&io::Error) -> bool,
    mut sleep: impl FnMut(Duration),
) -> io::Result<T> {
    let mut delays = TRANSIENT_RETRY_DELAYS_MS.iter();
    loop {
        match op() {
            Err(error) if transient(&error) => match delays.next() {
                Some(ms) => sleep(Duration::from_millis(*ms)),
                None => return Err(error),
            },
            result => return result,
        }
    }
}

/// True for a Windows transient-lock error. Always false elsewhere: the same
/// numbers mean unrelated Unix errors (EIO, EPIPE, EDOM).
pub fn is_transient_lock(error: &io::Error) -> bool {
    cfg!(windows) && error.raw_os_error().is_some_and(is_transient_lock_code)
}

/// [`retry_with`] using the Windows transient-lock classification. On other
/// platforms `op` runs exactly once.
pub(crate) fn retry_transient_lock<T>(op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    retry_with(op, is_transient_lock, std::thread::sleep)
}

/// Persist the entries (create, rename, remove) of directory `dir`. Unix only:
/// FlushFileBuffers does not document directory handles, so Windows directory
/// durability is not claimed and this is a no-op there.
#[cfg(unix)]
pub fn sync_directory(dir: &std::path::Path) -> io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
pub fn sync_directory(_dir: &std::path::Path) -> io::Result<()> {
    Ok(())
}

/// Mark a Mesa-owned control entry hidden in Explorer, best effort. Use only for
/// entries that are never published as a user file: a moved or renamed file
/// keeps its attributes, so a hidden save stage would hide the saved note.
pub fn hide_control_entry(path: &std::path::Path) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileAttributesW, SetFileAttributesW, INVALID_FILE_ATTRIBUTES,
        };
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: `wide` is a NUL-terminated path that outlives both calls.
        unsafe {
            let current = GetFileAttributesW(wide.as_ptr());
            if current != INVALID_FILE_ATTRIBUTES
                && current & FILE_ATTRIBUTE_REPARSE_POINT == 0
                && current & FILE_ATTRIBUTE_HIDDEN == 0
            {
                SetFileAttributesW(wide.as_ptr(), current | FILE_ATTRIBUTE_HIDDEN);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = path;
}

/// FILE_ATTRIBUTE_HIDDEN.
#[cfg_attr(not(windows), allow(dead_code))]
pub const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;

/// A Mesa control folder (`.mesa-trash`) that Explorer still shows. Checked
/// each time Mesa uses the folder, so one created by an older version, by
/// another OS or by a sync client becomes hidden too.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn needs_hiding(name: &std::ffi::OsStr, attributes: u32) -> bool {
    name == ".mesa-trash"
        && attributes & FILE_ATTRIBUTE_HIDDEN == 0
        && attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
}

/// Names Windows Explorer and the volume create for itself. Walks, the index
/// and sync skip them on every platform, so peers agree on the file set.
pub fn is_windows_shell_artifact(name: &str) -> bool {
    [
        "desktop.ini",
        "thumbs.db",
        "$recycle.bin",
        "system volume information",
    ]
    .iter()
    .any(|known| name.eq_ignore_ascii_case(known))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    const IO_REPARSE_TAG_SYMLINK: u32 = 0xA000_000C;

    #[test]
    fn links_and_unknown_reparse_tags_are_refused() {
        for tag in [
            IO_REPARSE_TAG_SYMLINK,
            IO_REPARSE_TAG_MOUNT_POINT,
            0xA000_001D, // IO_REPARSE_TAG_LX_SYMLINK
            0xA000_0019, // IO_REPARSE_TAG_GLOBAL_REPARSE
            0x8000_001B, // IO_REPARSE_TAG_APPEXECLINK
            0x8000_0023, // IO_REPARSE_TAG_AF_UNIX
            0x8000_0014, // IO_REPARSE_TAG_NFS
            0x0000_1234, // unknown third-party tag
            // A name-surrogate tag must never pass, even if it looks like cloud.
            IO_REPARSE_TAG_CLOUD | NAME_SURROGATE_BIT,
        ] {
            assert!(!reparse_tag_keeps_data_in_place(tag), "{tag:#x}");
            assert!(!entry_is_in_place(FILE_ATTRIBUTE_REPARSE_POINT, tag));
        }
    }

    #[test]
    fn cloud_dedup_and_wof_placeholders_are_in_place() {
        for tag in [
            IO_REPARSE_TAG_CLOUD,
            0x9000_101A, // CLOUD_1
            0x9000_301A, // CLOUD_3 (OneDrive)
            0x9000_F01A, // CLOUD_F
            IO_REPARSE_TAG_DEDUP,
            IO_REPARSE_TAG_WOF,
        ] {
            assert!(reparse_tag_keeps_data_in_place(tag), "{tag:#x}");
            assert!(entry_is_in_place(FILE_ATTRIBUTE_REPARSE_POINT | 0x20, tag));
        }
        // Without the reparse attribute the tag is meaningless.
        assert!(entry_is_in_place(0x20, IO_REPARSE_TAG_SYMLINK));
    }

    #[test]
    fn transient_locks_retry_with_bounded_backoff() {
        let calls = Cell::new(0);
        let waits = RefCell::new(Vec::new());
        let locked = || io::Error::from_raw_os_error(32);
        let result = retry_with(
            || {
                calls.set(calls.get() + 1);
                if calls.get() < 3 {
                    Err(locked())
                } else {
                    Ok("saved")
                }
            },
            |e| e.raw_os_error().is_some_and(is_transient_lock_code),
            |d| waits.borrow_mut().push(d.as_millis()),
        );
        assert_eq!(result.unwrap(), "saved");
        assert_eq!(*waits.borrow(), [50, 100]);

        // A lock that never clears gives up after five retries and returns it.
        calls.set(0);
        waits.borrow_mut().clear();
        let result: io::Result<()> = retry_with(
            || {
                calls.set(calls.get() + 1);
                Err(locked())
            },
            |e| e.raw_os_error().is_some_and(is_transient_lock_code),
            |d| waits.borrow_mut().push(d.as_millis()),
        );
        assert_eq!(result.unwrap_err().raw_os_error(), Some(32));
        assert_eq!(calls.get(), 6);
        assert_eq!(waits.borrow().iter().sum::<u128>(), 700);

        // Other errors fail at once.
        calls.set(0);
        let result: io::Result<()> = retry_with(
            || {
                calls.set(calls.get() + 1);
                Err(io::Error::from_raw_os_error(2))
            },
            |e| e.raw_os_error().is_some_and(is_transient_lock_code),
            |_| panic!("no wait for a permanent error"),
        );
        assert!(result.is_err());
        assert_eq!(calls.get(), 1);
        for code in [5, 32, 33, 1175] {
            assert!(is_transient_lock_code(code));
        }
        for code in [2, 3, 80, 183, 1176, 1177] {
            assert!(!is_transient_lock_code(code));
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_errors_with_the_same_numbers_are_never_retried() {
        // EIO (5) and EPIPE (32) are not locks; macOS saves must stay single-shot.
        for code in [5, 32, 33] {
            assert!(!is_transient_lock(&io::Error::from_raw_os_error(code)));
        }
        let calls = Cell::new(0);
        let result: io::Result<()> = retry_transient_lock(|| {
            calls.set(calls.get() + 1);
            Err(io::Error::from_raw_os_error(5))
        });
        assert!(result.is_err());
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn online_only_cloud_files_are_recognised_from_attributes() {
        // OneDrive Files On-Demand: placeholder that downloads on read.
        assert!(is_not_downloaded(
            0x0040_0000 | FILE_ATTRIBUTE_REPARSE_POINT | 0x20
        ));
        assert!(is_not_downloaded(0x0004_0000));
        assert!(is_not_downloaded(0x0000_1000));
        // A downloaded or pinned placeholder keeps the reparse point only.
        assert!(!is_not_downloaded(FILE_ATTRIBUTE_REPARSE_POINT | 0x20));
        assert!(!is_not_downloaded(0x20));
        assert!(NOT_DOWNLOADED_SYNC_ERROR.contains("available offline"));
    }

    #[test]
    fn recovery_storage_is_hidden_whenever_it_is_still_visible() {
        let trash = std::ffi::OsStr::new(".mesa-trash");
        // Visible, whether Mesa just created it or found it from before.
        assert!(needs_hiding(trash, 0x10));
        assert!(!needs_hiding(trash, 0x10 | FILE_ATTRIBUTE_HIDDEN));
        assert!(!needs_hiding(trash, 0x10 | FILE_ATTRIBUTE_REPARSE_POINT));
        assert!(!needs_hiding(std::ffi::OsStr::new("notes"), 0x10));
    }

    #[cfg(windows)]
    #[test]
    fn an_existing_visible_recovery_folder_is_hidden_on_next_use() {
        let root = std::env::temp_dir().join(format!("mesa-hide-trash-{}", std::process::id()));
        let trash = root.join(".mesa-trash");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&trash).unwrap();
        assert_eq!(path_attributes(&trash).unwrap() & FILE_ATTRIBUTE_HIDDEN, 0);
        drop(super::super::WindowsParentGuard::acquire(&trash.join("candidate"), false).unwrap());
        assert_ne!(path_attributes(&trash).unwrap() & FILE_ATTRIBUTE_HIDDEN, 0);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn windows_shell_artifacts_match_case_insensitively() {
        for name in [
            "desktop.ini",
            "Desktop.ini",
            "Thumbs.db",
            "$RECYCLE.BIN",
            "$Recycle.Bin",
            "System Volume Information",
        ] {
            assert!(is_windows_shell_artifact(name), "{name}");
        }
        for name in ["desktop.ini.md", "thumbs", "notes", "System Volume"] {
            assert!(!is_windows_shell_artifact(name), "{name}");
        }
    }

    #[test]
    fn windows_shell_names_match_the_frontend_twin() {
        // `isIndexableVaultRelPath` must skip exactly the names native walks and
        // sync skip, or the index and the sync manifest disagree.
        let source = include_str!("../../src/lib/vault.ts");
        let start = source
            .find("const WINDOWS_SHELL_NAMES = new Set([")
            .expect("frontend twin");
        let list = &source[start..start + source[start..].find("]);").unwrap()];
        let frontend: Vec<&str> = list.split('"').skip(1).step_by(2).collect();
        let native = [
            "desktop.ini",
            "thumbs.db",
            "$recycle.bin",
            "system volume information",
        ];
        assert_eq!(frontend, native);
        assert!(native.iter().all(|name| is_windows_shell_artifact(name)));
        assert!(!is_windows_shell_artifact("desktop.ini2"));
    }
}
