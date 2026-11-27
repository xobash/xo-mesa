use super::*;
#[test]
fn mutation_policy_has_no_arbitrary_remove_or_hidden_directory_route() {
    for path in [
        "../escape",
        ".git/config",
        "a/.private",
        "node_modules/a",
        "/absolute",
    ] {
        assert!(!visible(path));
    }
    assert!(visible("notes/new"));
    for path in ["live.md", ".mesa-trash", ".mesa-trash/../live.md"] {
        assert!(!recovery(path));
    }
    assert!(recovery(".mesa-trash/123/notes/a.md"));
    assert!(artifact(".note.md.mesa-rescue-123-ab.tmp").is_some());
    assert!(artifact(".note.md.mesa-other-123-ab.tmp").is_none());
}
#[cfg(unix)]
#[test]
fn directory_creation_rejects_a_short_name_alias_of_a_hidden_folder() {
    let root = std::env::temp_dir().join(format!("mesa-ops-alias-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join(".git/hooks")).unwrap();
    std::os::unix::fs::symlink(".git", root.join("GIT~1")).unwrap();
    assert_eq!(
        create_directory(&root, "GIT~1/hooks/new").unwrap_err(),
        "invalid vault directory"
    );
    assert!(!root.join(".git/hooks/new").exists());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn creates_folders_moves_directories_and_preserves_destination_collisions() {
    let root = std::env::temp_dir().join(format!("mesa-ops-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    create_directory(&root, "notes/nested").unwrap();
    fs::write(root.join("notes/nested/a.md"), b"original").unwrap();
    move_entry(&root, "notes", ".mesa-trash/1/notes").unwrap();
    create_directory(&root, "notes").unwrap();
    assert!(move_entry(&root, ".mesa-trash/1/notes", "notes").is_err());
    assert_eq!(
        fs::read(root.join(".mesa-trash/1/notes/nested/a.md")).unwrap(),
        b"original"
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn artifact_recovery_retains_fresh_and_conflicting_originals() {
    let root = std::env::temp_dir().join(format!("mesa-artifact-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let artifact = root.join(".note.md.mesa-backup-123-ab.tmp");
    fs::write(&artifact, b"original").unwrap();
    assert!(recover_artifact(&root, ".note.md.mesa-backup-123-ab.tmp", true).is_err());
    fs::OpenOptions::new()
        .write(true)
        .open(&artifact)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(120)))
        .unwrap();
    fs::write(root.join("note.md"), b"concurrent").unwrap();
    assert!(recover_artifact(&root, ".note.md.mesa-backup-123-ab.tmp", true).is_err());
    assert_eq!(fs::read(root.join("note.md")).unwrap(), b"concurrent");
    assert_eq!(fs::read(&artifact).unwrap(), b"original");
    fs::remove_file(root.join("note.md")).unwrap();
    recover_artifact(&root, ".note.md.mesa-backup-123-ab.tmp", true).unwrap();
    assert_eq!(fs::read(root.join("note.md")).unwrap(), b"original");
    assert!(!artifact.exists());
    fs::write(root.join(".note.md.mesa-rescue-123-ab.tmp"), b"rescue").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(root.join(".note.md.mesa-rescue-123-ab.tmp"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(120)))
        .unwrap();
    assert!(recover_artifact(&root, ".note.md.mesa-rescue-123-ab.tmp", false).is_err());
    assert!(list_recovery(&root).unwrap().is_empty());
    fs::create_dir_all(root.join(".mesa-trash/123/notes")).unwrap();
    fs::write(root.join(".mesa-trash/123/notes/a.md"), b"deleted").unwrap();
    fs::create_dir_all(root.join("notes/.mesa-trash")).unwrap();
    fs::write(root.join("notes/.mesa-trash/456-remote--b.md"), b"remote").unwrap();
    fs::create_dir_all(root.join(".mesa-trash/124/folder/sub")).unwrap();
    fs::write(root.join(".mesa-trash/124/folder/sub/x.md"), b"x").unwrap();
    fs::write(root.join(".mesa-trash/124/folder/sub/y.md"), b"y").unwrap();
    let entries = list_recovery(&root).unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].original_rel_path, "folder/sub");
    assert!(entries[0].is_directory);
    assert_eq!(entries[1].original_rel_path, "notes/a.md");
    assert_eq!(entries[1].trash_rel_path, ".mesa-trash/123/notes/a.md");
    assert!(!entries[1].is_directory);
    assert_eq!(entries[2].original_rel_path, "notes/b.md");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn nested_deleted_files_restore_into_their_folder() {
    let root = std::env::temp_dir().join(format!("mesa-ops-nested-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("notes")).unwrap();
    fs::write(root.join("notes/a.md"), b"a").unwrap();
    fs::write(root.join("notes/b.md"), b"b").unwrap();
    move_entry(&root, "notes/a.md", ".mesa-trash/1/notes/a.md").unwrap();
    move_entry(&root, "notes/b.md", ".mesa-trash/2/notes/b.md").unwrap();
    let entries = list_recovery(&root).unwrap();
    let originals: Vec<_> = entries
        .iter()
        .map(|e| e.original_rel_path.as_str())
        .collect();
    assert_eq!(originals, ["notes/a.md", "notes/b.md"]);
    for entry in &entries {
        move_entry(&root, &entry.trash_rel_path, &entry.original_rel_path).unwrap();
        prune_empty_trash_parents(&root, &entry.trash_rel_path);
    }
    assert_eq!(fs::read(root.join("notes/a.md")).unwrap(), b"a");
    assert_eq!(fs::read(root.join("notes/b.md")).unwrap(), b"b");
    assert!(!root.join("notes 2").exists());
    assert!(list_recovery(&root).unwrap().is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn one_unreadable_folder_does_not_hide_other_recovery_items() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("mesa-ops-unreadable-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("locked")).unwrap();
    fs::create_dir_all(root.join(".mesa-trash/1")).unwrap();
    fs::write(root.join(".mesa-trash/1/kept.md"), b"kept").unwrap();
    fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
    let listed = list_recovery(&root);
    fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(listed.unwrap()[0].original_rel_path, "kept.md");
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn linked_parents_cannot_create_or_move_outside_the_vault() {
    let root = std::env::temp_dir().join(format!("mesa-ops-link-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("outside")).unwrap();
    fs::create_dir_all(root.join("vault")).unwrap();
    std::os::unix::fs::symlink(root.join("outside"), root.join("vault/link")).unwrap();
    assert!(create_directory(&root.join("vault"), "link/new").is_err());
    assert!(!root.join("outside/new").exists());
    fs::remove_dir_all(root).unwrap();
}

/// The listing uses a folder stack, so a tree at the depth cap neither
/// overflows the thread stack nor hides a deleted item above the cap.
#[test]
fn recovery_listing_handles_a_tree_at_the_depth_cap() {
    let root = std::env::temp_dir().join(format!("mesa-recovery-depth-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let deep = vec!["d"; crate::vault_names::MAX_REL_SEGMENTS].join("/");
    fs::create_dir_all(root.join(&deep)).unwrap();
    fs::create_dir_all(root.join(".mesa-trash/123/notes")).unwrap();
    fs::write(root.join(".mesa-trash/123/notes/gone.md"), b"x").unwrap();
    let listed = list_recovery(&root);
    let _ = fs::remove_dir_all(&root);
    let listed = listed.unwrap();
    assert!(
        listed.iter().any(|entry| entry.name == "gone.md"),
        "{:?}",
        listed
            .iter()
            .map(|entry| &entry.trash_rel_path)
            .collect::<Vec<_>>()
    );
}

/// A single-child chain in the trash is followed only to the depth cap, so the
/// listed item stays restorable instead of naming a path restore refuses.
#[test]
fn recovery_listing_stops_a_single_child_chain_at_the_depth_cap() {
    let root = std::env::temp_dir().join(format!("mesa-recovery-chain-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let chain = vec!["d"; crate::vault_names::MAX_REL_SEGMENTS + 5].join("/");
    let deep = root.join(".mesa-trash/123").join(&chain);
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("gone.md"), b"x").unwrap();
    let listed = list_recovery(&root);
    let _ = fs::remove_dir_all(&root);
    let listed = listed.unwrap();
    assert_eq!(listed.len(), 1);
    assert!(
        !crate::vault_names::rel_too_deep(&listed[0].trash_rel_path),
        "{} segments",
        listed[0].trash_rel_path.split('/').count()
    );
    assert!(listed[0].is_directory);
}
#[cfg(unix)]
#[test]
fn names_only_windows_reserves_move_restore_and_read_on_unix() {
    let root = std::env::temp_dir().join(format!("mesa-ops-reserved-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("Why?.md"), b"question").unwrap();
    fs::write(root.join("con.md"), b"console").unwrap();
    assert!(visible("Why?.md") && recovery(".mesa-trash/1/Why?.md"));
    move_entry(&root, "Why?.md", ".mesa-trash/1/Why?.md").unwrap();
    assert!(!root.join("Why?.md").exists());
    move_entry(&root, ".mesa-trash/1/Why?.md", "Why?.md").unwrap();
    prune_empty_trash_parents(&root, ".mesa-trash/1/Why?.md");
    assert_eq!(fs::read(root.join("Why?.md")).unwrap(), b"question");
    create_directory(&root, "aux/what?").unwrap();
    assert!(root.join("aux/what?").is_dir());
    let read = crate::vaultread::with_visible_file(&root, "con.md", |mut file| {
        use std::io::Read;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        Ok(bytes)
    });
    assert_eq!(read.unwrap(), b"console");
    for rel in ["../Why?.md", "/Why?.md", "a/../con.md"] {
        assert!(!visible(rel), "{rel}");
        assert!(
            move_entry(&root, rel, ".mesa-trash/2/x.md").is_err(),
            "{rel}"
        );
    }
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn restore_refuses_an_original_over_the_size_limit_before_writing() {
    let root = std::env::temp_dir().join(format!("mesa-artifact-limit-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let rel = ".note.md.mesa-backup-123-ab.tmp";
    fs::write(root.join(rel), b"original").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(root.join(rel))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(120)))
        .unwrap();
    assert!(recover_artifact_limited(&root, rel, true, 7).is_err());
    assert!(!root.join("note.md").exists());
    assert_eq!(fs::read(root.join(rel)).unwrap(), b"original");
    recover_artifact_limited(&root, rel, true, 8).unwrap();
    assert_eq!(fs::read(root.join("note.md")).unwrap(), b"original");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn recovery_and_artifact_names_share_one_grammar() {
    use crate::vaultscope::{parse_write_artifact, WriteArtifact};
    assert!(matches!(
        parse_write_artifact(".mesa-sync-tmp-1712345-abc"),
        Some(WriteArtifact::SyncStage)
    ));
    assert!(parse_write_artifact(".mesa-sync-tmp-x-abc").is_none());
    // The grammar accepts a hidden target; recovery adds the visible rule.
    assert!(parse_write_artifact("..env.mesa-backup-1-ab.tmp").is_some());
    assert!(artifact("..env.mesa-backup-1-ab.tmp").is_none());
    // Purge and restore share `recovery`.
    for rel in ["a/.x/.mesa-trash/1/n.md", ".mesa-trash", "/.mesa-trash/1"] {
        assert!(!recovery(rel), "{rel}");
    }
}
