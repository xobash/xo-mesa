// One-round-trip vault listing.
//
// The frontend's `scanVault` walked the tree with one `readDir` IPC call per
// directory and then filled `size`/`mtime` with one `stat` IPC call PER FILE.
// On the 4,165-file reference vault that metadata pass alone measured 1,476 ms
// of a 1,593 ms scan, while the same walk-plus-stat costs ~248 ms of actual
// syscalls — so ~1.2 s of it was IPC round-trip overhead, not disk. Sorting the
// sidebar by `modified` or `size` puts that whole pass in front of the first
// paint (`SORT_MODES_NEEDING_METADATA` in store.ts).
//
// This command does the identical walk natively and returns every entry with
// its metadata in ONE round-trip. It deliberately does NOT reuse
// `sync_core::list_vault_files`: that walker answers a different question (what
// syncs) and coupling the two would let a sync rule silently change what the
// vault indexes.
//
// The filter rules below MUST stay identical to `walk`/`isIndexableVaultRelPath`
// in `src/lib/vault.ts` — a mismatch means the watcher sees paths that are not
// in `files`, which is what previously drove back-to-back whole-vault rescans
// during an ordinary `git commit`. `vaultScanContract.test.ts` pins the pair.
//
// Only the walk and the stat happen here. Every derived field (`name`, `ext`,
// `isMarkdown`, `path`) is still computed by the frontend from `rel` using its
// own helpers, so this cannot drift from the browser-demo path.
//
// The same walk also collects crash-recovery write artifacts. Those are
// dot-prefixed by design, so they are never INDEXED — but `recoverWriteArtifacts`
// in `src/lib/vault.ts` used to find them with a second, blocking JS walk that
// cost one `read_dir` IPC round-trip PER DIRECTORY before this command even ran:
// 153 round-trips on the 4,094-file reference vault, 96% of the whole pre-paint
// round-trip budget (153 + 1 scan + 6 bulk text reads), to discover ZERO
// artifacts in the normal non-crashed case. The syscalls themselves were only
// 3.8-14.6 ms; the rest was transport, and on Windows every one of those
// round-trips is a UI-thread message plus a forced `RedrawWindow` while
// WebView2 is still booting. This walk already visits every one of those
// directories and already reads every dirent, so collecting the artifacts here
// removes the second pass entirely rather than making it faster.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Directory names the walk never descends into. Dot-prefixed names (including
/// `.git`) are already excluded by the leading-dot rule.
const SKIPPED_DIRS: [&str; 1] = ["node_modules"];

#[derive(serde::Serialize)]
pub struct ScanEntry {
    /// Vault-relative path, always forward-slashed.
    pub rel: String,
    pub size: u64,
    /// Milliseconds since the Unix epoch — the value `Date.prototype.getTime`
    /// returns, so the frontend stores it verbatim. `None` when unavailable.
    pub mtime: Option<f64>,
    /// File creation time in milliseconds since the Unix epoch. This is the
    /// ordering source for the graph timelapse; older shells may omit it.
    pub created: Option<f64>,
}

/// One dot-prefixed write artifact, for the frontend's crash-recovery sweep.
#[derive(serde::Serialize)]
pub struct ArtifactEntry {
    /// Vault-relative directory holding it, forward-slashed. Empty at the root.
    pub dir: String,
    /// Basename, e.g. `.note.md.mesa-backup-1712-ab.tmp`.
    pub name: String,
}

/// The listing plus the artifacts, in one round-trip.
#[derive(serde::Serialize, Default)]
pub struct ScanResult {
    pub entries: Vec<ScanEntry>,
    pub artifacts: Vec<ArtifactEntry>,
}

/// Does this basename look like a Mesa write artifact?
///
/// Deliberately a SUPERSET of `isMesaWriteArtifactName` in
/// `src/lib/writeRecovery.ts`: the frontend re-filters every name this returns
/// through that authoritative predicate before planning any recovery action, so
/// an over-permissive answer here is dropped harmlessly, while an
/// under-permissive one would silently lose a user's only surviving copy of a
/// file. When in doubt, say yes. `vaultScanContract.test.ts` pins the direction
/// of that relationship.
fn looks_like_write_artifact(name: &str) -> bool {
    if !name.starts_with('.') {
        return false;
    }
    // `.mesa-sync-tmp-<ts>-<rest>` — written by the Rust sync side.
    if name.starts_with(".mesa-sync-tmp-") {
        return true;
    }
    // `.<target>.mesa-<save|backup|rescue>-<ts>-<id>.tmp`
    name.ends_with(".tmp")
        && (name.contains(".mesa-save-")
            || name.contains(".mesa-backup-")
            || name.contains(".mesa-rescue-"))
}

fn mtime_ms(meta: &fs::Metadata) -> Option<f64> {
    meta.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as f64)
}

fn created_ms(meta: &fs::Metadata) -> Option<f64> {
    meta.created()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as f64)
}

fn walk(dir: &Path, prefix: &str, out: &mut ScanResult) -> std::io::Result<()> {
    let entries = fs::read_dir(dir)?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.is_empty() {
            continue;
        }
        if name.starts_with('.') {
            // Dot-prefixed entries are NEVER indexed and never descended into —
            // that rule is unchanged. But write artifacts are dot-prefixed on
            // purpose, and this is the only pass that visits every directory,
            // so they are picked up here instead of by a second walk.
            if looks_like_write_artifact(&name) && entry.file_type().is_ok_and(|ft| ft.is_file()) {
                out.artifacts.push(ArtifactEntry {
                    dir: prefix.to_string(),
                    name,
                });
            }
            continue;
        }
        // `file_type` does not traverse symlinks, matching `readDir`'s
        // isFile/isDirectory: a symlink is neither, so it is skipped entirely.
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if ft.is_dir() {
            if SKIPPED_DIRS.contains(&name.as_str()) {
                continue;
            }
            // A child can disappear or become unreadable during a long scan;
            // keep the rest of the vault. The ROOT caller does not discard the
            // result, because turning an unavailable network root into an
            // empty successful scan would publish a blank workspace.
            let _ = walk(&entry.path(), &rel, out);
        } else if ft.is_file() {
            let (size, mtime, created) = match entry.metadata() {
                Ok(m) => (m.len(), mtime_ms(&m), created_ms(&m)),
                // Listed but unstattable: still index it, exactly as the JS
                // path does when its per-file `stat` throws.
                Err(_) => (0, None, None),
            };
            out.entries.push(ScanEntry { rel, size, mtime, created });
        }
    }
    Ok(())
}

/// Every indexable file under `root`, with metadata, plus any crash-recovery
/// write artifacts — in one call.
///
/// Order is NOT specified: the frontend sorts by `relPath.localeCompare`, whose
/// ICU collation a Rust byte-wise sort would not reproduce.
#[tauri::command]
pub async fn vault_scan(root: String) -> Result<ScanResult, String> {
    let path = std::path::PathBuf::from(&root);
    if !path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    // The walk is blocking syscall work (~248 ms on the reference vault); keep
    // it off the async runtime's worker so IPC stays responsive during open.
    tauri::async_runtime::spawn_blocking(move || -> Result<ScanResult, String> {
        let mut out = ScanResult::default();
        walk(&path, "", &mut out)
            .map_err(|error| format!("vault root is not readable: {root}: {error}"))?;
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The vault walk, for `vaultread`'s real-vault benchmark — so that benchmark
/// measures the same file set the app would actually read.
#[cfg(test)]
pub fn walk_for_tests(dir: &Path, prefix: &str, out: &mut Vec<ScanEntry>) {
    let mut result = ScanResult::default();
    let _ = walk(dir, prefix, &mut result);
    out.append(&mut result.entries);
}

#[cfg(test)]
mod tests {
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
    fn reports_size_and_mtime() {
        let v = TempVault::new("meta");
        v.file("a.md", "hello");
        let entries = v.scan();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].size, 5);
        let mtime = entries[0].mtime.expect("mtime present");
        assert!(mtime > 1_600_000_000_000.0, "mtime looks like ms: {mtime}");
        let created = entries[0].created.expect("creation time present");
        assert!(created > 1_600_000_000_000.0, "created looks like ms: {created}");
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
    /// `src/lib/vaultScanContract.test.ts`.
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
    /// then diff the REL lines against the JS walk. See
    /// `src/lib/vaultScanContract.test.ts` for the frontend half.
    #[test]
    #[ignore]
    fn parity_dump_for_real_vault() {
        let root =
            std::env::var("MESA_PARITY_VAULT").expect("set MESA_PARITY_VAULT to a vault path");
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
}
