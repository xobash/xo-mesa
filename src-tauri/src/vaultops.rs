//! Renderer mutation authority is restricted to directories and recoverable moves.
use crate::{sync_core, vaultwrite};
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime},
};

fn main_only(window: &tauri::Window) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("recovery belongs to the main workspace".into())
    }
}
fn visible(rel: &str) -> bool {
    sync_core::safe_join(Path::new(""), rel).is_some()
        && rel
            .split('/')
            .all(|p| !p.starts_with('.') && p != "node_modules")
}
fn recovery(rel: &str) -> bool {
    let parts: Vec<_> = rel.split('/').collect();
    sync_core::safe_join(Path::new(""), rel).is_some()
        && parts
            .iter()
            .position(|p| *p == ".mesa-trash")
            .is_some_and(|i| i + 1 < parts.len() && parts[..i].iter().all(|p| !p.starts_with('.')))
}
fn create_directory(root: &Path, rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Ok(());
    }
    if !visible(rel) || !crate::vaultscope::resolves_visible(root, rel) {
        return Err("invalid vault directory".into());
    }
    #[cfg(unix)]
    {
        sync_core::RootedTarget::resolve(root, &format!("{rel}/.directory-check"), true)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        let path = root.join(rel).join(".directory-check");
        let _guard =
            sync_core::WindowsParentGuard::acquire(&path, true).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub(crate) fn move_entry(root: &Path, from: &str, to: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        let from =
            sync_core::RootedTarget::resolve(root, from, false).map_err(|e| e.to_string())?;
        let to = sync_core::RootedTarget::resolve(root, to, true).map_err(|e| e.to_string())?;
        from.move_entry_no_replace(&to).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        let from = sync_core::safe_join_confined(root, from).ok_or("invalid source")?;
        let to = sync_core::safe_join_confined(root, to).ok_or("invalid destination")?;
        let _source =
            sync_core::WindowsParentGuard::acquire(&from, false).map_err(|e| e.to_string())?;
        let _target =
            sync_core::WindowsParentGuard::acquire(&to, true).map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(&from).map_err(|e| e.to_string())?;
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("linked recovery source".into());
        }
        sync_core::move_file_no_replace(&from, &to).map_err(|e| e.to_string())
    }
}
#[tauri::command]
pub async fn vault_create_directory(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let (root, rel) = crate::vaultscope::approved_path(&app, &path)?;
    let access = crate::vaulttransaction::access(&root).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _access = access;
        create_directory(&root, &rel)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn vault_move_to_recovery(
    app: tauri::AppHandle,
    window: tauri::Window,
    path: String,
) -> Result<(), String> {
    main_only(&window)?;
    let (root, rel) = crate::vaultscope::approved_path(&app, &path)?;
    if !visible(&rel) || !crate::vaultscope::resolves_visible(&root, &rel) {
        return Err("select a visible vault entry".into());
    }
    let access = crate::vaulttransaction::access(&root).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _access = access;
        let _lock = vaultwrite::WRITE_LOCK
            .write()
            .unwrap_or_else(|e| e.into_inner());
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        move_entry(&root, &rel, &format!(".mesa-trash/{stamp}/{rel}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn vault_restore_recovery(
    app: tauri::AppHandle,
    window: tauri::Window,
    root: String,
    trash_rel_path: String,
    target_rel_path: String,
) -> Result<(), String> {
    main_only(&window)?;
    let root = crate::vaultscope::require_approved(&app, &root)?;
    if !recovery(&trash_rel_path)
        || !visible(&target_rel_path)
        || !crate::vaultscope::resolves_visible(&root, &target_rel_path)
    {
        return Err("invalid recovery restore".into());
    }
    let access = crate::vaulttransaction::access(&root).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _access = access;
        let _lock = vaultwrite::WRITE_LOCK
            .write()
            .unwrap_or_else(|e| e.into_inner());
        move_entry(&root, &trash_rel_path, &target_rel_path)?;
        prune_empty_trash_parents(&root, &trash_rel_path);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn artifact(name: &str) -> Option<(&str, &str)> {
    let (target, rest) = name.strip_prefix('.')?.rsplit_once(".mesa-")?;
    let (label, rest) = rest.split_once('-')?;
    let (stamp, id) = rest.strip_suffix(".tmp")?.split_once('-')?;
    if !visible(target)
        || !matches!(label, "save" | "backup" | "rescue")
        || stamp.is_empty()
        || !stamp.bytes().all(|c| c.is_ascii_digit())
        || id.is_empty()
        || !id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return None;
    }
    Some((target, label))
}
fn stale(path: &Path) -> Result<bool, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("recovery artifact must be a regular file".into());
    }
    Ok(meta
        .modified()
        .map_err(|e| e.to_string())?
        .elapsed()
        .is_ok_and(|age| age >= Duration::from_secs(60)))
}
pub(crate) fn recover_artifact(root: &Path, rel: &str, restore: bool) -> Result<(), String> {
    let path = sync_core::safe_join_confined(root, rel).ok_or("invalid artifact path")?;
    let name = path
        .file_name()
        .and_then(|p| p.to_str())
        .ok_or("invalid artifact")?;
    let sync_temp = name
        .strip_prefix(".mesa-sync-tmp-")
        .and_then(|s| s.split_once('-'))
        .is_some_and(|(s, id)| {
            !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) && !id.is_empty()
        });
    let details = artifact(name);
    if details.is_none() && !sync_temp {
        return Err("not a write artifact".into());
    }
    if !stale(&path)? {
        return Err("write artifact is still active".into());
    }
    #[cfg(unix)]
    let held = sync_core::RootedTarget::resolve(root, rel, false).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let _guard = sync_core::WindowsParentGuard::acquire(&path, false).map_err(|e| e.to_string())?;
    if let Some((target, label)) = details {
        let target_path = path.with_file_name(target);
        if matches!(label, "backup" | "rescue") {
            for entry in fs::read_dir(path.parent().ok_or("artifact has no parent")?)
                .map_err(|e| e.to_string())?
            {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry
                    .file_name()
                    .to_str()
                    .and_then(artifact)
                    .is_some_and(|(t, l)| t == target && l != "save")
                    && !stale(&entry.path())?
                {
                    return Err("another original artifact is active".into());
                }
            }
        }
        if restore {
            if label == "save" {
                return Err("candidate bytes are not recovery originals".into());
            }
            #[cfg(unix)]
            let bytes = {
                use std::io::Read;
                let mut bytes = Vec::new();
                held.open_read()
                    .map_err(|e| e.to_string())?
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                bytes
            };
            #[cfg(windows)]
            let bytes = {
                use std::io::Read;
                let mut bytes = Vec::new();
                sync_core::open_file_no_follow(&path)
                    .map_err(|e| e.to_string())?
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                bytes
            };
            vaultwrite::write_atomic(&target_path, &bytes, &vaultwrite::ExpectedCurrent::Missing)?;
        } else if label == "rescue" || (label == "backup" && !target_path.is_file()) {
            return Err("original recovery bytes must be retained".into());
        }
    } else if restore {
        return Err("sync staging is not an original".into());
    }
    #[cfg(unix)]
    held.remove_entry().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn vault_recover_artifact(
    app: tauri::AppHandle,
    window: tauri::Window,
    root: String,
    path: String,
    restore: bool,
) -> Result<(), String> {
    main_only(&window)?;
    let root = crate::vaultscope::require_approved(&app, &root)?;
    let (path_root, rel) = crate::vaultscope::approved_path(&app, &path)?;
    if path_root != root {
        return Err("artifact is outside the selected vault".into());
    }
    let access = crate::vaulttransaction::access(&root).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _access = access;
        let _lock = vaultwrite::WRITE_LOCK
            .write()
            .unwrap_or_else(|e| e.into_inner());
        recover_artifact(&root, &rel, restore)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub(crate) trash_rel_path: String,
    pub(crate) original_rel_path: String,
    name: String,
    is_directory: bool,
}
fn recovery_original(rel: &str) -> Option<String> {
    let parts: Vec<_> = rel.split('/').collect();
    let index = parts.iter().position(|p| *p == ".mesa-trash")?;
    if index == 0 {
        if parts.len() < 3 {
            return None;
        }
        return Some(parts[2..].join("/"));
    }
    if parts.len() != index + 2 {
        return None;
    }
    let name = parts[index + 1];
    let (_, name) = name.split_once('-')?;
    let name = name.strip_prefix("remote--").unwrap_or(name);
    Some(format!("{}/{}", parts[..index].join("/"), name))
}
/// A root-trash delete keeps the original folders (`.mesa-trash/<stamp>/notes/a.md`).
/// Follow a chain of single visible children so the item lists as the deleted
/// entry, not a folder that may still exist in the vault.
fn deepest_single_entry(path: std::path::PathBuf) -> (std::path::PathBuf, bool) {
    let mut current = path;
    loop {
        let Ok(mut entries) = fs::read_dir(&current) else {
            return (current, true);
        };
        let (Some(Ok(only)), None) = (entries.next(), entries.next()) else {
            return (current, true);
        };
        let Ok(kind) = only.file_type() else {
            return (current, true);
        };
        let name = only.file_name();
        if kind.is_symlink() || !name.to_str().is_some_and(visible) || is_reparse(&only) {
            return (current, true);
        }
        if !kind.is_dir() {
            return (only.path(), false);
        }
        current = only.path();
    }
}
#[cfg(windows)]
fn is_reparse(entry: &fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    !entry
        .metadata()
        .is_ok_and(|meta| meta.file_attributes() & 0x400 == 0)
}
#[cfg(not(windows))]
fn is_reparse(_entry: &fs::DirEntry) -> bool {
    false
}
pub(crate) fn list_recovery(root: &Path) -> Result<Vec<RecoveryEntry>, String> {
    fn walk(
        root: &Path,
        dir: &Path,
        in_trash: bool,
        out: &mut Vec<RecoveryEntry>,
    ) -> Result<(), String> {
        // Only the vault root is fatal; an unreadable folder must not hide
        // every other recovery item.
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if dir == root => return Err(error.to_string()),
            Err(_) => return Ok(()),
        };
        for entry in entries {
            let Ok(entry) = entry else { continue };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() || is_reparse(&entry) {
                continue;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let rel_of = |path: &Path| -> Result<String, String> {
                Ok(path
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/"))
            };
            let rel = rel_of(&path)?;
            if in_trash {
                if let Some(original) = recovery_original(&rel) {
                    if !visible(&original) {
                        continue;
                    }
                    let (path, is_directory) = if kind.is_dir() && rel.starts_with(".mesa-trash/") {
                        deepest_single_entry(path)
                    } else {
                        (path, kind.is_dir())
                    };
                    let rel = rel_of(&path)?;
                    let Some(original) = recovery_original(&rel).filter(|o| visible(o)) else {
                        continue;
                    };
                    out.push(RecoveryEntry {
                        name: original.rsplit('/').next().unwrap_or("").into(),
                        trash_rel_path: rel,
                        original_rel_path: original,
                        is_directory,
                    });
                } else if kind.is_dir() {
                    walk(root, &path, true, out)?;
                }
            } else if kind.is_dir()
                && (name == ".mesa-trash" || (!name.starts_with('.') && name != "node_modules"))
            {
                walk(root, &path, name == ".mesa-trash", out)?;
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    walk(root, root, false, &mut entries)?;
    entries.sort_by(|a, b| a.original_rel_path.cmp(&b.original_rel_path));
    Ok(entries)
}
/// After a root-trash restore, remove the now-empty folders it leaves under
/// `.mesa-trash/<stamp>/`, so they never list as deleted items.
pub(crate) fn prune_empty_trash_parents(root: &Path, trash_rel: &str) {
    let parts: Vec<_> = trash_rel.split('/').collect();
    if parts.first() != Some(&".mesa-trash") {
        return;
    }
    for depth in (2..parts.len()).rev() {
        let rel = parts[..depth].join("/");
        #[cfg(unix)]
        let removed = sync_core::RootedTarget::resolve(root, &rel, false)
            .and_then(|dir| dir.remove_empty_dir());
        #[cfg(not(unix))]
        let removed = match sync_core::safe_join_confined(root, &rel) {
            Some(path) => fs::remove_dir(path),
            None => return,
        };
        if removed.is_err() {
            return;
        }
    }
}
#[tauri::command]
pub async fn vault_list_recovery(
    app: tauri::AppHandle,
    root: String,
) -> Result<Vec<RecoveryEntry>, String> {
    let root = crate::vaultscope::require_approved(&app, &root)?;
    let access = crate::vaulttransaction::access(&root).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _access = access;
        list_recovery(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
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
            .set_times(
                fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(120)),
            )
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
            .set_times(
                fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(120)),
            )
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
}
