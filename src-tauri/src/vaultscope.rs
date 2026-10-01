use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_fs::FsExt;

const APPROVED_ROOTS_FILE: &str = "approved-vault-roots.json";

#[derive(Default, Deserialize, Serialize)]
struct ApprovedRoots {
    roots: BTreeSet<String>,
}

#[derive(Default)]
pub struct VaultScopeState(Mutex<()>);

fn normalized_root(root: &str) -> Result<String, String> {
    let path = Path::new(root);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("vault root must be an absolute path without parent traversal".into());
    }
    let mut normalized = root.replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    #[cfg(windows)]
    {
        normalized = normalized.to_lowercase();
    }
    Ok(normalized)
}

fn approved_roots_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(APPROVED_ROOTS_FILE))
        .map_err(|error| format!("cannot resolve Mesa app-data folder: {error}"))
}

fn load_approved_roots(path: &Path) -> Result<ApprovedRoots, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("cannot read approved vault roots: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ApprovedRoots::default()),
        Err(error) => Err(format!("cannot read approved vault roots: {error}")),
    }
}

fn load_for_authorization(path: &Path, granted_by_dialog: bool) -> Result<ApprovedRoots, String> {
    match load_approved_roots(path) {
        Ok(roots) => Ok(roots),
        // A fresh native picker grant is sufficient authority to rebuild a
        // damaged local record. An arbitrary renderer path is not.
        Err(_) if granted_by_dialog => Ok(ApprovedRoots::default()),
        Err(error) => Err(error),
    }
}

fn save_approved_roots(path: &Path, roots: &ApprovedRoots) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "approved vault roots path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create Mesa app-data folder: {error}"))?;
    let bytes = serde_json::to_vec(roots)
        .map_err(|error| format!("cannot encode approved vault roots: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("cannot save approved vault roots: {error}"))?;
    replace_file(&temporary, path)
        .map_err(|error| format!("cannot publish approved vault roots: {error}"))
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let moved = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Restores access only to a vault the user selected previously. A newly picked
/// folder is already in Tauri's runtime scope because plugin-dialog grants it;
/// that native grant is the proof used to remember the folder for later runs.
#[tauri::command]
pub fn vault_authorize(
    app: AppHandle,
    state: State<'_, VaultScopeState>,
    root: String,
) -> Result<(), String> {
    let _guard = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let normalized = normalized_root(&root)?;
    let path = PathBuf::from(&root);
    let fs_scope = app.fs_scope();
    let granted_by_dialog = fs_scope.is_allowed(&path);
    let approval_path = approved_roots_path(&app)?;
    let mut approved = load_for_authorization(&approval_path, granted_by_dialog)?;

    if !granted_by_dialog && !approved.roots.contains(&normalized) {
        return Err("vault folder has not been selected in Mesa".into());
    }

    if granted_by_dialog && approved.roots.insert(normalized) {
        save_approved_roots(&approval_path, &approved)?;
    }

    fs_scope
        .allow_directory(&path, true)
        .map_err(|error| format!("cannot authorize vault filesystem access: {error}"))?;
    app.asset_protocol_scope()
        .allow_directory(&path, true)
        .map_err(|error| format!("cannot authorize vault media access: {error}"))?;
    Ok(())
}

fn is_write_artifact_name(name: &str) -> bool {
    if let Some(rest) = name.strip_prefix(".mesa-sync-tmp-") {
        return rest.split_once('-').is_some_and(|(stamp, suffix)| {
            !stamp.is_empty() && stamp.bytes().all(|b| b.is_ascii_digit()) && !suffix.is_empty()
        });
    }
    let Some((target, suffix)) = name
        .strip_prefix('.')
        .and_then(|name| name.rsplit_once(".mesa-"))
    else {
        return false;
    };
    if target.is_empty() || target == "." || target == ".." {
        return false;
    }
    let Some((label, rest)) = suffix.split_once('-') else {
        return false;
    };
    if !matches!(label, "save" | "backup" | "rescue") {
        return false;
    }
    let Some((stamp, token)) = rest
        .strip_suffix(".tmp")
        .and_then(|rest| rest.split_once('-'))
    else {
        return false;
    };
    !stamp.is_empty()
        && stamp.bytes().all(|b| b.is_ascii_digit())
        && !token.is_empty()
        && token
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Give the fs plugin exact paths for Mesa's hidden write artifacts. Its Unix
/// directory glob excludes dot-prefixed names, including verified backups.
/// Only paths inside a previously approved vault can be added.
#[tauri::command]
pub fn vault_authorize_artifacts(
    app: AppHandle,
    state: State<'_, VaultScopeState>,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.is_empty() || paths.len() > 256 {
        return Err("invalid write artifact batch".into());
    }
    let _guard = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let approved = load_approved_roots(&approved_roots_path(&app)?)?;
    if approved.roots.is_empty() {
        return Err("vault folder has not been selected in Mesa".into());
    }
    let canonical_roots: Vec<PathBuf> = approved
        .roots
        .iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .collect();
    let mut checked = Vec::with_capacity(paths.len());
    for raw in paths {
        let path = PathBuf::from(&raw);
        if !path.is_absolute()
            || path
                .components()
                .any(|component| matches!(component, Component::ParentDir))
            || !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(is_write_artifact_name)
        {
            return Err("invalid Mesa write artifact path".into());
        }
        let parent = path.parent().ok_or("write artifact has no parent")?;
        let canonical_parent = fs::canonicalize(parent)
            .map_err(|error| format!("cannot resolve write artifact parent: {error}"))?;
        if !canonical_roots
            .iter()
            .any(|root| canonical_parent.starts_with(root))
        {
            return Err("write artifact is outside the approved vault".into());
        }
        checked.push(path);
    }
    let scope = app.fs_scope();
    for path in checked {
        scope
            .allow_file(&path)
            .map_err(|error| format!("cannot authorize write artifact: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let dir =
            std::env::temp_dir().join(format!("mesa-vault-scope-corrupt-{}", std::process::id()));
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
}
