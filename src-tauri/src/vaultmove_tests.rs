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

// Unix stands in for a Windows 8.3 alias with a link: both spell a hidden
// folder under a visible name that resolves to it.
#[cfg(unix)]
#[test]
fn rejects_a_short_name_alias_of_a_hidden_folder() {
    let vault = TempVault::new("short-name");
    vault.write("a.md", "note");
    vault.write(".git/hooks/README", "hooks");
    std::os::unix::fs::symlink(".git", vault.0.join("GIT~1")).unwrap();
    let error =
        rename_no_replace(&vault.0, "a.md", "GIT~1/hooks/post-checkout", false).unwrap_err();
    assert_eq!(error, "rename accepts visible vault files only");
    assert!(vault.0.join("a.md").exists());
    assert!(!vault.0.join(".git/hooks/post-checkout").exists());
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
fn failed_second_case_hop_restores_the_source() {
    let vault = TempVault::new("case-fail");
    vault.write("a.md", "original");
    vault.write("b.md", "concurrent");
    let root = fs::canonicalize(&vault.0).unwrap();

    assert!(rename_no_replace(&root, "a.md", "b.md", true).is_err());

    assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "original");
    assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "concurrent");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
}

#[test]
fn interrupted_case_hop_is_a_recoverable_rescue() {
    let vault = TempVault::new("case-hop");
    vault.write("Note.md", "original");
    let root = fs::canonicalize(&vault.0).unwrap();
    // Stop after the first hop, as a process loss between hops would.
    let hop = unique_case_hop(&root.join("Note.md")).unwrap();
    move_confined(&root, &root.join("Note.md"), &hop).unwrap();
    let name = hop.file_name().unwrap().to_str().unwrap().to_owned();
    assert!(crate::vaultscan::looks_like_write_artifact(&name), "{name}");

    fs::OpenOptions::new()
        .write(true)
        .open(&hop)
        .unwrap()
        .set_times(
            fs::FileTimes::new()
                .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(120)),
        )
        .unwrap();
    crate::vaultops::recover_artifact(&root, &name, true).unwrap();

    assert_eq!(
        fs::read_to_string(root.join("Note.md")).unwrap(),
        "original"
    );
    assert!(!hop.exists());
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
