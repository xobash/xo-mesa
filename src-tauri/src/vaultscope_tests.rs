use super::*;

#[test]
fn hidden_subfolders_of_an_approved_root_are_not_new_vaults() {
    let roots = BTreeSet::from(["/vault".to_string(), "/".to_string()]);
    for hidden in [
        "/vault/.git",
        "/vault/notes/.mesa-trash",
        "/vault/node_modules/x",
        "/.hidden",
    ] {
        assert!(hidden_inside_approved(&roots, hidden), "{hidden}");
    }
    let roots = BTreeSet::from(["/vault".to_string()]);
    for allowed in ["/vault", "/vault/notes", "/other/.git", "/vault2/.git"] {
        assert!(!hidden_inside_approved(&roots, allowed), "{allowed}");
    }
}

#[test]
fn windows_hidden_subfolders_are_refused_whatever_the_spelling() {
    // A record written by an older build holds the lowercased verbatim key;
    // canonicalize hands back the verbatim, mixed-case form.
    let mut approved = ApprovedRoots {
        roots: BTreeSet::from([
            "//?/c:/data/me/vault".to_string(),
            "//?/unc/server.example/share/team vault".to_string(),
        ]),
        pi_process: BTreeSet::new(),
    };
    assert!(rekey_approved_roots(&mut approved, true));
    for canonical in [
        r"\\?\C:\Data\Me\Vault\.git",
        r"C:\Data\Me\Vault\notes\.mesa-trash",
        r"\\?\UNC\server.example\Share\Team Vault\.git",
        r"\\server.example\share\team vault\node_modules",
    ] {
        let key = root_key(canonical, true);
        assert!(hidden_inside_approved(&approved.roots, &key), "{canonical}");
    }
    for canonical in [
        r"\\?\C:\Data\Me\Vault",
        r"\\?\C:\Data\Me\Vault\Notes",
        r"\\?\C:\Data\Me\Vault2\.git",
    ] {
        let key = root_key(canonical, true);
        assert!(
            !hidden_inside_approved(&approved.roots, &key),
            "{canonical}"
        );
    }
}

#[test]
fn verbatim_prefixes_are_dropped_only_from_ordinary_paths() {
    for (verbatim, plain) in [
        (r"\\?\C:\Data\Me\Vault", r"C:\Data\Me\Vault"),
        (r"\\?\C:\", r"C:\"),
        (
            r"\\?\UNC\server.example\Share\Vault",
            r"\\server.example\Share\Vault",
        ),
        (r"\\?\unc\server.example\Share", r"\\server.example\Share"),
        ("//?/c:/data/me/vault", "c:/data/me/vault"),
        (
            "//?/unc/server.example/share/vault",
            "//server.example/share/vault",
        ),
        (r"\\?\D:\Ünïcødé dir\Café", r"D:\Ünïcødé dir\Café"),
    ] {
        assert_eq!(strip_verbatim_prefix(verbatim), plain, "{verbatim}");
    }
    for kept in [
        // Win32 parsing would strip the trailing dot or space and name
        // another folder, or reach a device instead of a file.
        r"\\?\C:\Vault.\notes",
        r"\\?\C:\Vault \notes",
        r"\\?\C:\Vault\CON",
        r"\\?\C:\Vault\..\x",
        r"\\?\C:\Vault\\x",
        r"\\?\C:",
        r"\\?\UNC\server",
        r"\\?\UNC\server\",
        r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\Vault",
        r"\\?\GLOBALROOT\Device\HarddiskVolume1",
        r"\\?\Ü:\x",
        // Byte 3 falls inside `€`: must not panic.
        r"\\?\A€\x",
        r"\\?\UN€\x\y",
        r"\\?\€",
        r"C:\Data\Me\Vault",
        "/Data/me/vault",
        r"\\server\share",
    ] {
        assert_eq!(strip_verbatim_prefix(kept), kept, "{kept}");
    }
}

#[test]
fn root_keys_keep_unix_spellings_and_unify_windows_spellings() {
    // Unix keys must stay byte-identical: per-vault records are keyed by them.
    for (root, key) in [
        ("/Data/me/Vault", "/Data/me/Vault"),
        ("/Data/me/Vault/", "/Data/me/Vault"),
        ("/", "/"),
        ("//?/odd", "//?/odd"),
    ] {
        assert_eq!(root_key(root, false), key, "{root}");
    }
    for spelling in [
        r"\\?\C:\Data\Me\Vault",
        r"C:\Data\Me\Vault\",
        "c:/data/me/vault",
        "//?/c:/data/me/vault",
    ] {
        assert_eq!(root_key(spelling, true), "c:/data/me/vault", "{spelling}");
    }
    assert_eq!(
        root_key(r"\\?\UNC\server.example\Share\Vault", true),
        root_key(r"\\server.example\share\vault", true)
    );
    assert_eq!(root_key(r"\\?\D:\", true), "d:/");
    assert_eq!(root_key(r"D:\", true), "d:/");
    assert_ne!(
        root_key(r"\\?\C:\Vault.", true),
        root_key(r"C:\Vault", true)
    );
}

#[test]
fn legacy_windows_approval_records_are_rewritten_without_verbatim_keys() {
    let dir = std::env::temp_dir().join(format!("mesa-scope-rekey-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("approved.json");
    fs::write(
        &path,
        br#"{"roots":["//?/unc/server.example/share/vault","c:/vault"],"piProcess":["//?/unc/server.example/share/vault"]}"#,
    )
    .unwrap();
    let mut approved = read_approved_roots(&path).unwrap();
    assert!(rekey_approved_roots(&mut approved, true));
    write_approved_roots(&path, &approved).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(!text.contains("?"), "{text}");
    let reread = read_approved_roots(&path).unwrap();
    assert_eq!(
        reread.roots,
        BTreeSet::from([
            "//server.example/share/vault".to_string(),
            "c:/vault".to_string()
        ])
    );
    assert_eq!(
        reread.pi_process,
        BTreeSet::from(["//server.example/share/vault".to_string()])
    );
    let mut clean = reread;
    assert!(!rekey_approved_roots(&mut clean, true));
    // Unix records are never rewritten.
    let mut unix = ApprovedRoots {
        roots: BTreeSet::from(["//?/odd".to_string()]),
        pi_process: BTreeSet::new(),
    };
    assert!(!rekey_approved_roots(&mut unix, false));
    assert!(unix.roots.contains("//?/odd"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unresolvable_volumes_fall_back_only_without_links_or_short_names() {
    assert!(final_path_unsupported(&std::io::Error::from_raw_os_error(
        1
    )));
    assert!(final_path_unsupported(&std::io::Error::from_raw_os_error(
        50
    )));
    assert!(!final_path_unsupported(&std::io::Error::from(
        std::io::ErrorKind::NotFound
    )));
    for alias in ["GIT~1", "NOTES~12.MD", "a~3"] {
        assert!(short_name_shaped(alias), "{alias}");
    }
    for plain in ["notes", "a~b", "draft~", "~1x", "Café.md"] {
        assert!(!short_name_shaped(plain), "{plain}");
    }
    let dir = std::env::temp_dir().join(format!("mesa-scope-absolute-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("vault/notes")).unwrap();
    // The temp folder itself may sit behind a link (macOS `/var`). The
    // fallback sees plain spellings: under a `\\?\` prefix `/` and `..`
    // are literal name characters, not separators or traversal.
    let dir = plain_path(&fs::canonicalize(&dir).unwrap());
    let plain = dir.join("vault/notes");
    assert_eq!(absolute_without_aliases(&plain), Some(plain.clone()));
    assert_eq!(absolute_without_aliases(&dir.join("vault/../vault")), None);
    assert_eq!(absolute_without_aliases(&dir.join("vault/GIT~1")), None);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.join("vault"), dir.join("link")).unwrap();
        assert_eq!(absolute_without_aliases(&dir.join("link/notes")), None);
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn root_prefixes_fold_case_only_on_windows() {
    let path = Path::new("/G/Vault/Notes/a.md");
    assert_eq!(
        strip_root(path, Path::new("/g/vault"), true),
        Some(Path::new("Notes/a.md"))
    );
    assert_eq!(strip_root(path, Path::new("/g/vault"), false), None);
    assert_eq!(
        strip_root(path, Path::new("/G/Vault"), false),
        Some(Path::new("Notes/a.md"))
    );
    assert_eq!(
        strip_root(path, Path::new("/G/Vault"), true),
        path.strip_prefix("/G/Vault").ok()
    );
    // Whole components only, in either mode.
    for fold in [true, false] {
        assert_eq!(strip_root(path, Path::new("/G/Vau"), fold), None);
        assert_eq!(
            strip_root(Path::new("/G"), Path::new("/G/Vault"), fold),
            None
        );
    }
    assert_eq!(
        strip_root(Path::new("/G/Vault"), Path::new("/g/vault"), true),
        Some(Path::new(""))
    );
}

#[test]
fn approvals_load_from_disk_once_and_reload_after_invalidation() {
    let dir = std::env::temp_dir().join(format!("mesa-scope-cache-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("approved.json");
    fs::write(&path, br#"{"roots":["/vault"]}"#).unwrap();
    let cache = Mutex::new(None);
    assert!(cached_approved_roots(&path, &cache)
        .unwrap()
        .roots
        .contains("/vault"));
    fs::write(&path, br#"{"roots":[]}"#).unwrap();
    assert!(cached_approved_roots(&path, &cache)
        .unwrap()
        .roots
        .contains("/vault"));
    *cache.lock().unwrap() = None;
    assert!(cached_approved_roots(&path, &cache)
        .unwrap()
        .roots
        .is_empty());
    fs::write(&path, b"corrupt").unwrap();
    *cache.lock().unwrap() = None;
    assert!(cached_approved_roots(&path, &cache).is_err());
    assert!(cache.lock().unwrap().is_none());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn file_and_write_checks_share_visible_segment_policy() {
    let dir = std::env::temp_dir().join(format!("mesa-visible-policy-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let root = fs::canonicalize(&vault).unwrap();
    let approval = dir.join("approved.json");
    let roots = ApprovedRoots {
        roots: BTreeSet::from([normalized_root(root.to_str().unwrap()).unwrap()]),
        ..Default::default()
    };
    save_approved_roots(&approval, &roots).unwrap();
    for (rel, allowed) in [
        ("notes/ok.md", true),
        (".hidden/note.md", false),
        ("notes/.hidden.md", false),
        ("node_modules/note.md", false),
        ("notes/node_modules", false),
    ] {
        let file = root.join(rel);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"content").unwrap();
        assert_eq!(
            require_approved_file_from(&approval, file.to_str().unwrap()).is_ok(),
            allowed,
            "read {rel}"
        );
        assert_eq!(
            require_approved_write_target_from(&approval, file.to_str().unwrap()).is_ok(),
            allowed,
            "write {rel}"
        );
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn revoked_roots_are_refused_and_other_roots_survive() {
    let base = std::env::temp_dir().join(format!("mesa-scope-revoke-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let (a, b) = (base.join("a"), base.join("b"));
    fs::create_dir_all(&a).unwrap();
    fs::create_dir_all(&b).unwrap();
    let record = base.join("approved.json");
    let mut roots = ApprovedRoots::default();
    for root in [&a, &b] {
        roots
            .roots
            .insert(normalized_root(fs::canonicalize(root).unwrap().to_str().unwrap()).unwrap());
    }
    save_approved_roots(&record, &roots).unwrap();
    assert!(require_approved_from(&record, a.to_str().unwrap()).is_ok());

    assert!(revoke_from(&record, a.to_str().unwrap()).unwrap());
    assert!(require_approved_from(&record, a.to_str().unwrap()).is_err());
    assert!(require_approved_from(&record, b.to_str().unwrap()).is_ok());
    assert!(
        !revoke_from(&record, a.to_str().unwrap()).unwrap(),
        "second revoke is a no-op"
    );

    // A folder the user already deleted can still be forgotten.
    fs::remove_dir_all(&b).unwrap();
    assert!(revoke_from(&record, b.to_str().unwrap()).unwrap());
    assert!(revoke_from(&record, "relative/path").is_err());
    fs::remove_dir_all(base).unwrap();
}
#[test]
fn relative_paths_match_components_without_slicing_unicode() {
    let root = std::env::temp_dir().join("mesa-İ-root");
    let input = root.join("notes/new.md");
    assert_eq!(
        relative_to_root(&root, &input.to_string_lossy()).as_deref(),
        Some("notes/new.md")
    );
    assert!(relative_to_root(&root, &format!("{}-other/file", root.display())).is_none());
}
#[cfg(unix)]
#[test]
fn selected_root_alias_does_not_grant_another_root() {
    let root = std::env::temp_dir().join(format!("mesa-scope-alias-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("vault")).unwrap();
    std::os::unix::fs::symlink(root.join("vault"), root.join("alias")).unwrap();
    let canonical = fs::canonicalize(root.join("vault")).unwrap();
    assert_eq!(
        relative_to_root(
            &canonical,
            &root.join("alias/notes/new.md").to_string_lossy()
        )
        .as_deref(),
        Some("notes/new.md")
    );
    assert!(relative_to_root(&canonical, &root.join("outside/new.md").to_string_lossy()).is_none());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn renderer_save_cannot_rewrite_hidden_recovery_or_control_files() {
    let dir = std::env::temp_dir().join(format!("mesa-scope-write-policy-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("vault/.mesa-trash/123")).unwrap();
    fs::create_dir_all(dir.join("vault/.git")).unwrap();
    let root = fs::canonicalize(dir.join("vault")).unwrap();
    let approval = dir.join("approval.json");
    let mut roots = ApprovedRoots::default();
    roots
        .roots
        .insert(normalized_root(root.to_str().unwrap()).unwrap());
    save_approved_roots(&approval, &roots).unwrap();
    for rel in [".mesa-trash/123/original.md", ".git/config"] {
        let target = root.join(rel);
        fs::write(&target, b"retained").unwrap();
        assert!(require_approved_write_target_from(&approval, target.to_str().unwrap()).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"retained");
    }
    assert!(
        require_approved_write_target_from(&approval, root.join("note.md").to_str().unwrap())
            .is_ok()
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn normalizes_separators_and_trailing_slashes() {
    #[cfg(not(windows))]
    assert_eq!(normalized_root("/vault/notes///").unwrap(), "/vault/notes");
    #[cfg(windows)]
    assert_eq!(
        normalized_root("C:\\Vault\\Notes\\").unwrap(),
        "c:/vault/notes"
    );
}

#[test]
fn rejects_relative_and_parent_traversal_roots() {
    assert!(normalized_root("vault/notes").is_err());
    #[cfg(not(windows))]
    assert!(normalized_root("/vault/../private").is_err());
    #[cfg(windows)]
    assert!(normalized_root("C:\\Vault\\..\\Private").is_err());
}

#[test]
fn pi_process_consent_persists_with_the_vault_and_is_revoked_with_it() {
    let base = std::env::temp_dir().join(format!("mesa-scope-pi-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let (a, b) = (base.join("a"), base.join("b"));
    fs::create_dir_all(&a).unwrap();
    fs::create_dir_all(&b).unwrap();
    let (a, b) = (fs::canonicalize(a).unwrap(), fs::canonicalize(b).unwrap());
    let record = base.join("approved.json");
    let roots = ApprovedRoots {
        roots: BTreeSet::from([normalized_root(a.to_str().unwrap()).unwrap()]),
        ..Default::default()
    };
    save_approved_roots(&record, &roots).unwrap();

    assert!(!pi_process_allowed_from(&record, &a).unwrap());
    assert!(
        remember_pi_process_from(&record, &b).is_err(),
        "unselected vault"
    );
    remember_pi_process_from(&record, &a).unwrap();
    invalidate_approved_roots();
    assert!(
        pi_process_allowed_from(&record, &a).unwrap(),
        "survives a reload"
    );
    assert!(!pi_process_allowed_from(&record, &b).unwrap());

    assert!(revoke_from(&record, a.to_str().unwrap()).unwrap());
    let reloaded = read_approved_roots(&record).unwrap();
    assert!(reloaded.roots.is_empty() && reloaded.pi_process.is_empty());
    invalidate_approved_roots();
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn approval_file_round_trips_without_extra_fields() {
    let dir = std::env::temp_dir().join(format!("mesa-vault-scope-{}", std::process::id()));
    let path = dir.join(APPROVED_ROOTS_FILE);
    let _ = fs::remove_dir_all(&dir);
    let mut roots = ApprovedRoots::default();
    roots.roots.insert("/vault".into());
    save_approved_roots(&path, &roots).unwrap();
    assert_eq!(load_approved_roots(&path).unwrap().roots, roots.roots);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn corrupt_record_requires_a_fresh_dialog_grant_to_recover() {
    let dir = std::env::temp_dir().join(format!("mesa-vault-scope-corrupt-{}", std::process::id()));
    let path = dir.join(APPROVED_ROOTS_FILE);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(&path, b"not json").unwrap();

    assert!(load_for_authorization(&path, false).is_err());
    assert!(load_for_authorization(&path, true)
        .unwrap()
        .roots
        .is_empty());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn approved_root_is_required_for_native_vault_access() {
    let dir = std::env::temp_dir().join(format!("mesa-vault-scope-access-{}", std::process::id()));
    let approved_dir = dir.join("approved");
    let unapproved_dir = dir.join("unapproved");
    let record = dir.join(APPROVED_ROOTS_FILE);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&approved_dir).unwrap();
    fs::create_dir_all(&unapproved_dir).unwrap();
    let canonical = fs::canonicalize(&approved_dir).unwrap();
    let mut roots = ApprovedRoots::default();
    roots
        .roots
        .insert(normalized_root(canonical.to_str().unwrap()).unwrap());
    save_approved_roots(&record, &roots).unwrap();
    assert_eq!(
        require_approved_from(&record, approved_dir.to_str().unwrap()).unwrap(),
        canonical
    );
    assert!(require_approved_from(&record, unapproved_dir.to_str().unwrap()).is_err());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn flush_path_stays_inside_an_approved_vault() {
    let dir = std::env::temp_dir().join(format!("mesa-vault-flush-{}", std::process::id()));
    let approved_dir = dir.join("approved");
    let outside_dir = dir.join("outside");
    let record = dir.join(APPROVED_ROOTS_FILE);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&approved_dir).unwrap();
    fs::create_dir_all(&outside_dir).unwrap();
    let inside = approved_dir.join("note.md");
    let outside = outside_dir.join("other.md");
    fs::write(&inside, b"note").unwrap();
    fs::write(&outside, b"other").unwrap();
    let mut roots = ApprovedRoots::default();
    roots.roots.insert(
        normalized_root(fs::canonicalize(&approved_dir).unwrap().to_str().unwrap()).unwrap(),
    );
    save_approved_roots(&record, &roots).unwrap();
    let checked = require_approved_file_from(&record, inside.to_str().unwrap()).unwrap();
    sync_file(&checked).unwrap();
    crate::sync_core::platform_fs::sync_directory(checked.parent().unwrap()).unwrap();
    assert!(require_approved_file_from(&record, outside.to_str().unwrap()).is_err());
    assert!(require_approved_file_from(&record, dir.join("missing.md").to_str().unwrap()).is_err());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn write_target_requires_approved_parent_and_rejects_symlinks() {
    let dir = std::env::temp_dir().join(format!("mesa-vault-write-scope-{}", std::process::id()));
    let approved_dir = dir.join("approved");
    let outside_dir = dir.join("outside");
    let record = dir.join(APPROVED_ROOTS_FILE);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&approved_dir).unwrap();
    fs::create_dir_all(&outside_dir).unwrap();
    let mut roots = ApprovedRoots::default();
    roots.roots.insert(
        normalized_root(fs::canonicalize(&approved_dir).unwrap().to_str().unwrap()).unwrap(),
    );
    save_approved_roots(&record, &roots).unwrap();
    assert!(require_approved_write_target_from(
        &record,
        approved_dir.join("new.md").to_str().unwrap()
    )
    .is_ok());
    assert!(require_approved_write_target_from(
        &record,
        outside_dir.join("new.md").to_str().unwrap()
    )
    .is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside_dir.join("new.md"), approved_dir.join("link.md"))
            .unwrap();
        assert!(require_approved_write_target_from(
            &record,
            approved_dir.join("link.md").to_str().unwrap()
        )
        .is_err());
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn windows_write_leaf_rejects_streams_devices_and_trailing_dots() {
    for name in [
        "note.md:secret",
        "CON",
        "conin$.md",
        "CONOUT$",
        "clock$.txt",
        "COM1.md",
        "note.md.",
        "note.md ",
    ] {
        assert!(!windows_leaf_name_allowed(name), "{name}");
    }
    for name in ["note.md", "console.md", "COM10.md", "clock.md"] {
        assert!(windows_leaf_name_allowed(name), "{name}");
    }
}

// Unix stands in for a Windows 8.3 alias with a link: both give a hidden
// folder a visible spelling that the OS resolves.
#[cfg(unix)]
#[test]
fn visible_paths_are_rechecked_after_the_os_resolves_them() {
    let root = std::env::temp_dir().join(format!("mesa-visible-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join(".git/hooks")).unwrap();
    fs::create_dir_all(root.join("notes")).unwrap();
    std::os::unix::fs::symlink(".git", root.join("GIT~1")).unwrap();
    assert!(!resolves_visible(&root, "GIT~1/hooks/post-checkout"));
    assert!(!resolves_visible(&root, "GIT~1"));
    assert!(!resolves_visible(&root, ".git/config"));
    assert!(!resolves_visible(&root, "node_modules/a.md"));
    assert!(resolves_visible(&root, "notes/new/a.md"));
    assert!(resolves_visible(&root, "notes"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn only_mesa_write_artifact_names_are_accepted() {
    for name in [
        ".QA.md.mesa-save-1712345-abc123.tmp",
        ".QA.md.mesa-backup-1712345-abc123.tmp",
        ".QA.md.mesa-rescue-1712345-abc123.tmp",
        ".mesa-sync-tmp-1712345-abc123",
    ] {
        assert!(is_write_artifact_name(name), "{name}");
    }
    for name in [
        ".secret",
        ".QA.md.mesa-save-x-a.tmp",
        ".QA.md.mesa-save-1-.tmp",
        "QA.md",
    ] {
        assert!(!is_write_artifact_name(name), "{name}");
    }
}
