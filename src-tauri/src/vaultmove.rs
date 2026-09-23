// Native no-replace vault rename.
//
// The filesystem plugin's rename maps to Rust's overwrite-capable rename on
// several platforms. A preflight `exists()` check cannot make that safe: a
// different process can create the destination between the check and move.
// This command uses the same native no-replace primitive as sync instead.

use std::fs;
use std::path::{Component, Path, PathBuf};

fn safe_relative_path(rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let normalized = rel.replace('\\', "/");
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return None;
    }
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => result.push(part),
            _ => return None,
        }
    }
    (!result.as_os_str().is_empty()).then_some(result)
}

fn contained_parent(root: &Path, parent: &Path) -> Result<(), String> {
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create destination folder: {error}"))?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("could not resolve destination folder: {error}"))?;
    if canonical_parent.starts_with(root) {
        Ok(())
    } else {
        Err("rename destination escapes the selected vault".into())
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
    contained_parent(
        root,
        destination
            .parent()
            .ok_or("rename destination has no parent")?,
    )?;

    if !case_only {
        return crate::sync_core::move_file_no_replace(&source, &destination).map_err(|error| {
            format!("could not rename without replacing an existing file: {error}")
        });
    }

    // A case-only rename on a case-insensitive volume names the source through
    // both spellings. Two no-replace hops preserve the same safety guarantee.
    let temporary = unique_case_hop(&source)?;
    crate::sync_core::move_file_no_replace(&source, &temporary)
        .map_err(|error| format!("could not stage case-only rename: {error}"))?;
    match crate::sync_core::move_file_no_replace(&temporary, &destination) {
        Ok(()) => Ok(()),
        Err(error) => {
            let rollback = crate::sync_core::move_file_no_replace(&temporary, &source);
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
    root: String,
    from_rel: String,
    to_rel: String,
    case_only: bool,
) -> Result<(), String> {
    let root =
        fs::canonicalize(&root).map_err(|error| format!("vault root is unavailable: {error}"))?;
    if !root.is_dir() {
        return Err("vault root is not a directory".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        rename_no_replace(&root, &from_rel, &to_rel, case_only)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
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
}
