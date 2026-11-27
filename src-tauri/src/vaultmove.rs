// Use native no-replace rename; an exists check does not authorize overwrite.

use std::fs;
use std::path::{Path, PathBuf};

fn safe_relative_path(rel: &str) -> Option<PathBuf> {
    let normalized = rel.replace('\\', "/");
    crate::sync_core::vault_join(Path::new(""), &normalized)
}

fn move_confined(root: &Path, from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let rel = |path: &Path| {
            path.strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        };
        let source = crate::sync_core::RootedTarget::resolve_local(
            root,
            &rel(from).map_err(|e| e.to_string())?,
            false,
        )
        .map_err(|e| e.to_string())?;
        let destination = crate::sync_core::RootedTarget::resolve_local(
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
    // The recognised rescue form lets crash recovery restore the source name
    // if the process stops between the two hops.
    for attempt in 0..32_u32 {
        let candidate = parent.join(format!(
            ".{name}.mesa-rescue-{}-{:x}r{attempt}.tmp",
            crate::sync_core::now_ms(),
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
            .any(crate::vault_names::is_hidden_name)
    }) {
        return Err("rename accepts visible vault files only".into());
    }
    if [from_rel, to_rel]
        .iter()
        .any(|rel| !crate::vaultscope::resolves_visible(root, &rel.replace('\\', "/")))
    {
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
        let _guard = crate::vaultwrite::WRITE_LOCK
            .write()
            .unwrap_or_else(|p| p.into_inner());
        rename_no_replace(&root, &from_rel, &to_rel, case_only)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
#[path = "vaultmove_tests.rs"]
mod tests;

/// Most entries one purge removes; a larger item fails closed part-way.
#[cfg(unix)]
const PURGE_MAX_ENTRIES: usize = 1_000_000;

#[cfg(test)]
thread_local! {
    /// Runs after the item is resolved and before it is removed.
    static AFTER_PURGE_RESOLVE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

fn after_purge_resolve() {
    #[cfg(test)]
    AFTER_PURGE_RESOLVE.with(|hook| {
        if let Some(hook) = hook.borrow_mut().take() {
            hook();
        }
    });
}

/// Permanently remove only an explicit recovery item in an approved vault.
/// Unix removes through held directory handles; Windows holds every
/// ancestor open (no rename or delete sharing) until the removal ends.
fn purge_recovery(root: &Path, rel: &str) -> Result<(), String> {
    if !crate::vaultops::recovery(rel) {
        return Err("select a recovery item, not its storage root".into());
    }
    #[cfg(unix)]
    {
        let item = crate::sync_core::RootedTarget::resolve_local(root, rel, false)
            .map_err(|e| e.to_string())?;
        after_purge_resolve();
        item.remove_tree_no_follow(crate::vault_names::MAX_REL_SEGMENTS, PURGE_MAX_ENTRIES)
            .map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        let path =
            crate::sync_core::vault_join_confined(root, rel).ok_or("invalid recovery path")?;
        let _guard = crate::sync_core::WindowsParentGuard::acquire(&path, false)
            .map_err(|e| e.to_string())?;
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        use std::os::windows::fs::MetadataExt;
        if metadata.file_type().is_symlink()
            || !crate::sync_core::platform_fs::path_is_in_place(&path, metadata.file_attributes())
                .map_err(|e| e.to_string())?
        {
            return Err("recovery path must not contain links or junctions".into());
        }
        after_purge_resolve();
        // std's Windows remove_dir_all removes links inside the tree without following them.
        if metadata.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        }
        .map_err(|e| e.to_string())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (root, after_purge_resolve);
        Err("recovery purge is unavailable on this platform".into())
    }
}

pub(crate) const PURGE_MAIN_ONLY: &str = "only the main workspace may purge recovery";
#[tauri::command]
pub async fn vault_purge_recovery(
    app: tauri::AppHandle,
    window: tauri::Window,
    root: String,
    trash_rel_path: String,
) -> Result<(), String> {
    crate::require_main_for(window.label(), PURGE_MAIN_ONLY)?;
    let root = crate::vaultscope::require_approved(&app, &root)?;
    let access = crate::vaulttransaction::access(&root).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _access = access;
        let _guard = crate::vaultwrite::WRITE_LOCK
            .write()
            .unwrap_or_else(|e| e.into_inner());
        purge_recovery(&root, &trash_rel_path)?;
        crate::vaultops::prune_empty_trash_parents(&root, &trash_rel_path);
        Ok(())
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
    fn purge_and_restore_accept_the_same_items() {
        let root = std::env::temp_dir().join(format!("mesa-purge-names-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".mesa-trash/100")).unwrap();
        fs::write(root.join(".mesa-trash/100/con.md"), b"deleted").unwrap();
        fs::write(root.join(".mesa-trash/100/Why?.md"), b"deleted").unwrap();
        for rel in [".mesa-trash/100/con.md", ".mesa-trash/100/Why?.md"] {
            assert!(crate::vaultops::recovery(rel), "{rel}");
            purge_recovery(&root, rel).unwrap();
            assert!(!root.join(rel).exists(), "{rel}");
        }
        let _ = fs::remove_dir_all(root);
    }
    #[cfg(unix)]
    #[test]
    fn purge_never_follows_a_trash_folder_swapped_for_a_link() {
        let base = std::env::temp_dir().join(format!("mesa-purge-swap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("vault");
        let outside = base.join("outside");
        fs::create_dir_all(root.join(".mesa-trash/100/sub")).unwrap();
        fs::write(root.join(".mesa-trash/100/sub/note.md"), b"deleted").unwrap();
        fs::create_dir_all(outside.join("100/sub")).unwrap();
        fs::write(outside.join("100/sub/keep.md"), b"keep").unwrap();
        let (trash, moved, target) = (
            root.join(".mesa-trash"),
            root.join(".mesa-trash-moved"),
            outside.clone(),
        );
        AFTER_PURGE_RESOLVE.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                fs::rename(&trash, &moved).unwrap();
                std::os::unix::fs::symlink(&target, &trash).unwrap();
            }));
        });
        let _ = purge_recovery(&root, ".mesa-trash/100/sub");
        assert_eq!(fs::read(outside.join("100/sub/keep.md")).unwrap(), b"keep");
        // The held handles removed the validated item where it now lives.
        assert!(!root.join(".mesa-trash-moved/100/sub").exists());
        let _ = fs::remove_dir_all(base);
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
