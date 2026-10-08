// Use native no-replace rename; an exists check does not authorize overwrite.

use std::fs;
use std::path::{Path, PathBuf};

fn safe_relative_path(rel: &str) -> Option<PathBuf> {
    let normalized = rel.replace('\\', "/");
    crate::sync_core::safe_join(Path::new(""), &normalized)
}

fn move_confined(root: &Path, from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let rel = |path: &Path| {
            path.strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        };
        let source = crate::sync_core::RootedTarget::resolve(
            root,
            &rel(from).map_err(|e| e.to_string())?,
            false,
        )
        .map_err(|e| e.to_string())?;
        let destination = crate::sync_core::RootedTarget::resolve(
            root,
            &rel(to).map_err(|e| e.to_string())?,
            true,
        )
        .map_err(|e| e.to_string())?;
        source
            .rename_no_replace(&destination)
            .map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        if !from.starts_with(root) || !to.starts_with(root) {
            return Err("rename path is outside the approved root".into());
        }
        let _source = crate::sync_core::WindowsParentGuard::acquire(from, false)
            .map_err(|e| e.to_string())?;
        let _destination =
            crate::sync_core::WindowsParentGuard::acquire(to, true).map_err(|e| e.to_string())?;
        crate::sync_core::open_file_no_follow(from).map_err(|e| e.to_string())?;
        crate::sync_core::move_file_no_replace(from, to).map_err(|e| e.to_string())
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err("confined rename is unavailable on this platform".into())
    }
}

fn unique_case_hop(from: &Path) -> Result<PathBuf, String> {
    let parent = from.parent().ok_or("rename source has no parent")?;
    let name = from
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    for attempt in 0..32_u32 {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        let candidate = parent.join(format!(
            ".{name}.mesa-rename-{stamp}-{}-{attempt}.tmp",
            std::process::id()
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("could not allocate a private case-rename path".into())
}

fn rename_no_replace(
    root: &Path,
    from_rel: &str,
    to_rel: &str,
    case_only: bool,
) -> Result<(), String> {
    if [from_rel, to_rel].iter().any(|rel| {
        rel.replace('\\', "/")
            .split('/')
            .any(|part| part.starts_with('.') || part == "node_modules")
    }) {
        return Err("rename accepts visible vault files only".into());
    }
    let from = safe_relative_path(from_rel).ok_or("invalid rename source")?;
    let to = safe_relative_path(to_rel).ok_or("invalid rename destination")?;
    if from == to {
        return Ok(());
    }
    let source = root.join(from);
    let destination = root.join(to);
    let metadata = fs::symlink_metadata(&source)
        .map_err(|error| format!("rename source is unavailable: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err("rename source is not a regular vault file".into());
    }
    if !case_only {
        return move_confined(root, &source, &destination).map_err(|error| {
            format!("could not rename without replacing an existing file: {error}")
        });
    }

    // A case-only rename on a case-insensitive volume names the source through
    // both spellings. Two no-replace hops preserve the same safety guarantee.
    let temporary = unique_case_hop(&source)?;
    move_confined(root, &source, &temporary)
        .map_err(|error| format!("could not stage case-only rename: {error}"))?;
    match move_confined(root, &temporary, &destination) {
        Ok(()) => Ok(()),
        Err(error) => {
            let rollback = move_confined(root, &temporary, &source);
            match rollback {
                Ok(()) => Err(format!("could not complete case-only rename: {error}")),
                Err(rollback_error) => Err(format!(
                    "could not complete case-only rename: {error}; recovery copy remains at {}: {rollback_error}",
                    temporary.display()
                )),
            }
        }
    }
}

/// Move one regular vault file only when its destination remains absent.
#[tauri::command]
pub async fn vault_rename_no_replace(
    app: tauri::AppHandle,
    root: String,
    from_rel: String,
    to_rel: String,
    case_only: bool,
) -> Result<(), String> {
    let root = crate::vaultscope::require_approved(&app, &root)?;
    let access = crate::vaulttransaction::access(&root).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _access = access;
        rename_no_replace(&root, &from_rel, &to_rel, case_only)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn ordinary_rename_cannot_bypass_main_only_recovery() {
        let root = std::env::temp_dir();
        assert!(super::rename_no_replace(&root, ".mesa-trash/123/a.md", "a.md", false).is_err());
        assert!(super::rename_no_replace(&root, "a.md", ".git/config", false).is_err());
    }
    use super::*;

    struct TempVault(PathBuf);
    impl TempVault {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "mesa-vaultmove-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn write(&self, rel: &str, contents: &str) {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
    }
    impl Drop for TempVault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rejects_escape_paths() {
        assert!(safe_relative_path("../outside.md").is_none());
        assert!(safe_relative_path("/outside.md").is_none());
        assert!(safe_relative_path("notes/idea.md").is_some());
    }

    #[test]
    fn preserves_a_destination_created_before_the_native_move() {
        let vault = TempVault::new("collision");
        vault.write("from.md", "original");
        vault.write("to.md", "concurrent");
        let root = fs::canonicalize(&vault.0).unwrap();

        let error = rename_no_replace(&root, "from.md", "to.md", false).unwrap_err();

        assert!(error.contains("without replacing"));
        assert_eq!(
            fs::read_to_string(vault.0.join("from.md")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_to_string(vault.0.join("to.md")).unwrap(),
            "concurrent"
        );
    }

    #[test]
    fn moves_a_regular_file_without_decoding_its_bytes() {
        let vault = TempVault::new("move");
        let payload = [0_u8, 255, 1, 2, 3];
        fs::write(vault.0.join("from.pdf"), payload).unwrap();
        let root = fs::canonicalize(&vault.0).unwrap();

        rename_no_replace(&root, "from.pdf", "nested/to.pdf", false).unwrap();

        assert!(!vault.0.join("from.pdf").exists());
        assert_eq!(fs::read(vault.0.join("nested/to.pdf")).unwrap(), payload);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_linked_source_parent_and_destination_without_outside_mutation() {
        let vault = TempVault::new("source-link");
        let outside = TempVault::new("outside-link");
        outside.write("keep.md", "outside");
        vault.write("inside.md", "inside");
        std::os::unix::fs::symlink(&outside.0, vault.0.join("linked")).unwrap();
        let root = fs::canonicalize(&vault.0).unwrap();
        assert!(rename_no_replace(&root, "linked/keep.md", "stolen.md", false).is_err());
        assert!(rename_no_replace(&root, "inside.md", "linked/new/sub/note.md", false).is_err());
        assert_eq!(fs::read(outside.0.join("keep.md")).unwrap(), b"outside");
        assert!(!outside.0.join("new").exists());
        assert_eq!(fs::read(vault.0.join("inside.md")).unwrap(), b"inside");
    }
}

/// Permanently remove only an explicit recovery item in an approved vault.
fn purge_recovery(root: &Path, rel: &str) -> Result<(), String> {
    if rel.contains('\\')
        || rel
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.contains(':'))
    {
        return Err("invalid recovery path".into());
    }
    let parts: Vec<_> = rel.split('/').collect();
    let trash = parts
        .iter()
        .position(|part| *part == ".mesa-trash")
        .ok_or("not recovery storage")?;
    if trash + 1 >= parts.len() || parts[..trash].iter().any(|p| p.starts_with('.')) {
        return Err("select a recovery item, not its storage root".into());
    }
    let mut path = root.to_path_buf();
    for part in parts {
        path.push(part);
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("recovery path must not contain symlinks".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("recovery path must not contain reparse points".into());
            }
        }
    }
    let canonical = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !canonical.starts_with(fs::canonicalize(root).map_err(|e| e.to_string())?) {
        return Err("recovery path escapes the vault".into());
    }
    if path.is_dir() {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vault_purge_recovery(
    app: tauri::AppHandle,
    window: tauri::Window,
    root: String,
    trash_rel_path: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("only the main workspace may purge recovery".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::vaultscope::require_approved(&app, &root)?;
        let _guard = crate::vaultwrite::WRITE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        purge_recovery(&root, &trash_rel_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod purge_tests {
    use super::*;
    #[test]
    fn purge_is_limited_to_recovery_and_preserves_live_files() {
        let root = std::env::temp_dir().join(format!("mesa-purge-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".mesa-trash/100/sub")).unwrap();
        fs::write(root.join("live.md"), b"live").unwrap();
        fs::write(root.join(".mesa-trash/100/sub/note.md"), b"deleted").unwrap();
        for rel in [
            "live.md",
            ".mesa-trash",
            ".mesa-trash/../live.md",
            "/.mesa-trash/100",
            ".mesa-trash/100/../../live.md",
        ] {
            assert!(purge_recovery(&root, rel).is_err(), "{rel}");
        }
        purge_recovery(&root, ".mesa-trash/100/sub").unwrap();
        assert_eq!(fs::read(root.join("live.md")).unwrap(), b"live");
        assert!(!root.join(".mesa-trash/100/sub").exists());
        let _ = fs::remove_dir_all(root);
    }
    #[cfg(unix)]
    #[test]
    fn purge_refuses_symlink_ancestors() {
        let root = std::env::temp_dir().join(format!("mesa-purge-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("outside")).unwrap();
        fs::write(root.join("outside/keep.md"), b"keep").unwrap();
        std::os::unix::fs::symlink(root.join("outside"), root.join(".mesa-trash")).unwrap();
        assert!(purge_recovery(&root, ".mesa-trash/keep.md").is_err());
        assert_eq!(fs::read(root.join("outside/keep.md")).unwrap(), b"keep");
        let _ = fs::remove_dir_all(root);
    }
}
