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
    let hex = crate::hex::encode("/v/näme.md".as_bytes());
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
    let other =
        std::thread::spawn(move || with_save_gate(&other_gate, &b, || done_tx.send(()).unwrap()));
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
    let second = std::thread::spawn(move || with_save_lock(&target, || done_tx.send(()).unwrap()));
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
        sha256: crate::hex::sha256_hex(b"old"),
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
        sha256: crate::hex::sha256_hex(b"old"),
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
