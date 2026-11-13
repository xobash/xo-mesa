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
    let source = include_str!("../../src/lib/vaultWalk.ts");
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
