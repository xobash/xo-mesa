use super::*;
use std::fs;

struct TempVault(std::path::PathBuf);
impl TempVault {
    fn new(tag: &str) -> Self {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "mesa-vaultscan-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        TempVault(p)
    }
    fn file(&self, rel: &str, body: &str) {
        let full = self.0.join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, body).unwrap();
    }
    fn dir(&self, rel: &str) {
        fs::create_dir_all(self.0.join(rel)).unwrap();
    }
    fn full(&self) -> ScanResult {
        let mut out = ScanResult::default();
        walk(&self.0, "", &mut out).unwrap();
        out
    }
    fn scan(&self) -> Vec<ScanEntry> {
        self.full().entries
    }
    fn rels(&self) -> Vec<String> {
        let mut r: Vec<String> = self.scan().into_iter().map(|e| e.rel).collect();
        r.sort();
        r
    }
    /// `dir|name` pairs, sorted, for artifact assertions.
    fn artifacts(&self) -> Vec<String> {
        let mut a: Vec<String> = self
            .full()
            .artifacts
            .into_iter()
            .map(|x| format!("{}|{}", x.dir, x.name))
            .collect();
        a.sort();
        a
    }
}
impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn lists_nested_files_with_forward_slashed_rel_paths() {
    let v = TempVault::new("nested");
    v.file("note.md", "a");
    v.file("deep/inner/other.txt", "bb");
    assert_eq!(v.rels(), vec!["deep/inner/other.txt", "note.md"]);
}

/// The walk recurses per folder level, so nesting past the cap is skipped
/// instead of followed.
#[test]
fn folders_nested_past_the_depth_cap_are_not_followed() {
    let v = TempVault::new("depth");
    let cap = crate::vault_names::MAX_REL_SEGMENTS;
    let at_cap = vec!["d"; cap - 1].join("/");
    v.file(&format!("{at_cap}/kept.md"), "a");
    v.file(&format!("{at_cap}/e/lost.md"), "a");
    assert_eq!(v.rels(), vec![format!("{at_cap}/kept.md")]);
}

#[test]
fn skips_dot_prefixed_files_and_directories() {
    let v = TempVault::new("dots");
    v.file("keep.md", "a");
    v.file(".hidden.md", "a");
    v.file(".git/index", "a");
    v.file(".obsidian/config.json", "a");
    v.file("nested/.hidden-too.md", "a");
    assert_eq!(v.rels(), vec!["keep.md"]);
}

#[test]
fn skips_node_modules_at_any_depth() {
    let v = TempVault::new("nm");
    v.file("keep.md", "a");
    v.file("node_modules/pkg/index.js", "a");
    v.file("sub/node_modules/pkg/index.js", "a");
    assert_eq!(v.rels(), vec!["keep.md"]);
}

#[test]
fn skips_windows_shell_files_and_folders_in_any_case() {
    let v = TempVault::new("shell");
    v.file("keep.md", "a");
    v.file("desktop.ini", "[.ShellClassInfo]");
    v.file("photos/Thumbs.db", "x");
    v.file("$RECYCLE.BIN/S-1-5-21/.a.md.mesa-rescue-1-a.tmp", "x");
    v.file("System Volume Information/tracking.log", "x");
    v.file("notes/Desktop.INI", "x");
    v.file("notes/desktop.ini.md", "a");
    assert_eq!(v.rels(), vec!["keep.md", "notes/desktop.ini.md"]);
    // Nothing inside the recycle bin enters crash recovery either.
    assert!(v.artifacts().is_empty());
}

#[test]
fn reports_size_and_mtime() {
    let v = TempVault::new("meta");
    v.file("a.md", "hello");
    let entries = v.scan();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].size, 5);
    let mtime = entries[0].mtime.expect("mtime present");
    assert!(mtime > 1_600_000_000_000.0, "mtime looks like ms: {mtime}");
    let created = entries[0].created.expect("creation time present");
    assert!(
        created > 1_600_000_000_000.0,
        "created looks like ms: {created}"
    );
}

#[test]
fn empty_directories_contribute_nothing() {
    let v = TempVault::new("emptydir");
    v.dir("empty/deeper");
    v.file("a.md", "x");
    assert_eq!(v.rels(), vec!["a.md"]);
}

#[test]
fn missing_root_is_an_error_not_an_empty_vault() {
    let v = TempVault::new("missing-root");
    let missing = v.0.join("not-mounted");
    let mut out = ScanResult::default();
    let error = walk(&missing, "", &mut out).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    assert!(out.entries.is_empty());
    assert!(out.artifacts.is_empty());
}

#[test]
fn collects_write_artifacts_without_indexing_them() {
    let v = TempVault::new("artifacts");
    v.file("note.md", "a");
    v.file(".note.md.mesa-backup-1712-ab.tmp", "orig");
    v.file(".note.md.mesa-save-1712-cd.tmp", "cand");
    v.file(".note.md.mesa-rescue-1712-ef.tmp", "resc");
    v.file(".mesa-sync-tmp-1712-xyz", "sync");
    v.file("deep/inner/other.md", "b");
    v.file("deep/inner/.other.md.mesa-backup-99-zz.tmp", "orig2");
    // Indexing is unaffected: artifacts are dot-prefixed, so they stay out.
    assert_eq!(v.rels(), vec!["deep/inner/other.md", "note.md"]);
    assert_eq!(
        v.artifacts(),
        vec![
            "deep/inner|.other.md.mesa-backup-99-zz.tmp",
            "|.mesa-sync-tmp-1712-xyz",
            "|.note.md.mesa-backup-1712-ab.tmp",
            "|.note.md.mesa-rescue-1712-ef.tmp",
            "|.note.md.mesa-save-1712-cd.tmp",
        ]
    );
}

#[test]
fn ordinary_dot_files_are_not_reported_as_artifacts() {
    let v = TempVault::new("dotnoise");
    v.file(".DS_Store", "x");
    v.file(".gitignore", "x");
    v.file(".env.tmp", "x");
    v.file("note.md.mesa-backup-1-a.tmp", "no leading dot");
    assert!(v.artifacts().is_empty(), "{:?}", v.artifacts());
}

#[test]
fn artifacts_inside_skipped_directories_are_not_reached() {
    // `.git` and `node_modules` are never descended into, so a stray temp
    // under them stays invisible — same as the JS walk this replaced.
    let v = TempVault::new("skipdirs");
    v.file(".git/.x.mesa-backup-1-a.tmp", "x");
    v.file("node_modules/.y.mesa-backup-1-a.tmp", "x");
    v.file("keep.md", "a");
    assert!(v.artifacts().is_empty(), "{:?}", v.artifacts());
}

#[cfg(unix)]
#[test]
fn artifact_directories_and_symlinks_are_not_collected() {
    use std::os::unix::fs::symlink;
    let v = TempVault::new("artifactkind");
    // A DIRECTORY whose name matches must not enter the recovery plan:
    // recovery reads artifacts as file bytes.
    v.dir(".note.md.mesa-backup-1-a.tmp");
    v.file("real.md", "a");
    symlink(
        v.0.join("real.md"),
        v.0.join(".link.md.mesa-backup-1-b.tmp"),
    )
    .unwrap();
    assert!(v.artifacts().is_empty(), "{:?}", v.artifacts());
}

/// The Rust predicate must be a SUPERSET of the frontend's
/// `isMesaWriteArtifactName`. Under-permissive here means a crash-recovery
/// artifact is never found and the user's only surviving copy is lost, so
/// every shape the frontend accepts is asserted accepted here too. The
/// frontend half (that it re-filters the superset) is
/// `src/lib/vaultScanBehavior.test.ts`.
#[test]
fn artifact_predicate_is_a_superset_of_the_frontend_matcher() {
    for name in [
        ".a.md.mesa-save-1-a.tmp",
        ".a.md.mesa-backup-1712345678901-ab12cd.tmp",
        ".a.md.mesa-rescue-0-z.tmp",
        ".name with spaces.pdf.mesa-backup-1-a.tmp",
        ".dotted.name.v2.md.mesa-save-1-a.tmp",
        ".mesa-sync-tmp-1-anything",
        ".mesa-sync-tmp-1712345678901-deadbeef",
    ] {
        assert!(looks_like_write_artifact(name), "should accept {name}");
    }
    for name in [
        "note.md",
        ".DS_Store",
        ".mesa-sync-tmp",
        ".a.md.mesa-backup-1-a.tmp.bak",
        "a.md.mesa-backup-1-a.tmp",
    ] {
        assert!(!looks_like_write_artifact(name), "should reject {name}");
    }
}

/// Parity harness against a REAL vault — the synthetic cases above cannot
/// prove the walk agrees with `src/lib/vault.ts` across thousands of real
/// names. Ignored by default (needs a vault on disk); run with:
///   MESA_PARITY_VAULT="/path/to/vault" \
///     cargo test --lib vaultscan::tests::parity -- --ignored --nocapture
/// then diff the REL lines against the JS walk. See `src/lib/vaultScanBehavior.test.ts` for frontend path indexing.
#[test]
#[ignore]
fn parity_dump_for_real_vault() {
    let root = std::env::var("MESA_PARITY_VAULT").expect("set MESA_PARITY_VAULT to a vault path");
    let mut out = ScanResult::default();
    walk(Path::new(&root), "", &mut out).expect("vault root is readable");
    let mut rels: Vec<String> = out.entries.into_iter().map(|e| e.rel).collect();
    rels.sort();
    println!("COUNT {}", rels.len());
    for r in &rels {
        println!("REL {r}");
    }
    // A healthy vault has none; a vault opened after a crash mid-save does.
    println!("ARTIFACTS {}", out.artifacts.len());
    for a in &out.artifacts {
        println!("ARTIFACT {}|{}", a.dir, a.name);
    }
}

#[cfg(unix)]
#[test]
fn symlinks_are_not_indexed_and_not_followed() {
    use std::os::unix::fs::symlink;
    let v = TempVault::new("symlink");
    v.file("real.md", "a");
    v.dir("realdir");
    v.file("realdir/inside.md", "a");
    symlink(v.0.join("real.md"), v.0.join("link.md")).unwrap();
    symlink(v.0.join("realdir"), v.0.join("linkdir")).unwrap();
    // Matches readDir's isFile/isDirectory, which are false for symlinks.
    assert_eq!(v.rels(), vec!["real.md", "realdir/inside.md"]);
}
