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
}
