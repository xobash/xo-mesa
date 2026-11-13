// List vault entries, metadata, and recovery artifacts in one native round-trip.
// Keep scan filters aligned with walk/isIndexableVaultRelPath in src/lib/vaultWalk.ts.
// Sync owns a separate walker because its inclusion rules may differ.
// The frontend derives display fields and ordering from vault-relative paths;
// recovery artifacts are collected but never indexed.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

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
/// This is a superset of `isMesaWriteArtifactName` in
/// `src/lib/writeRecovery.ts`. The frontend filters the result before recovery;
/// omitting a valid artifact here could lose the only surviving copy.
pub(crate) fn looks_like_write_artifact(name: &str) -> bool {
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

/// Walk the tree with an explicit folder stack, never recursion, so a deep
/// tree cannot exhaust the thread stack. Only an unreadable start folder is
/// an error.
fn walk(dir: &Path, prefix: &str, out: &mut ScanResult) -> std::io::Result<()> {
    let mut pending: Vec<(std::path::PathBuf, String)> = Vec::new();
    scan_dir(dir, prefix, out, &mut pending)?;
    while let Some((child, rel)) = pending.pop() {
        // A child can disappear or become unreadable during a long scan;
        // keep the rest of the vault. The ROOT caller does not discard the
        // result, because turning an unavailable network root into an
        // empty successful scan would publish a blank workspace.
        let _ = scan_dir(&child, &rel, out, &mut pending);
    }
    Ok(())
}

/// List one folder: files go to `out`, subfolders to `pending`.
fn scan_dir(
    dir: &Path,
    prefix: &str,
    out: &mut ScanResult,
    pending: &mut Vec<(std::path::PathBuf, String)>,
) -> std::io::Result<()> {
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
        // Explorer's own files (`desktop.ini`, `$RECYCLE.BIN`, ...) are never
        // vault content; `isIndexableVaultRelPath` skips the same names.
        if crate::sync_core::platform_fs::is_windows_shell_artifact(&name) {
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
        // Paths nested past the cap are not indexed: sync refuses them too.
        if crate::vault_names::rel_too_deep(&rel) {
            continue;
        }
        if ft.is_dir() {
            if name == crate::vault_names::SKIPPED_DIR {
                continue;
            }
            pending.push((entry.path(), rel));
        } else if ft.is_file() {
            let (size, mtime, created) = match entry.metadata() {
                Ok(m) => (m.len(), mtime_ms(&m), created_ms(&m)),
                // Listed but unstattable: still index it, exactly as the JS
                // path does when its per-file `stat` throws.
                Err(_) => (0, None, None),
            };
            out.entries.push(ScanEntry {
                rel,
                size,
                mtime,
                created,
            });
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
pub async fn vault_scan(app: tauri::AppHandle, root: String) -> Result<ScanResult, String> {
    let path = crate::vaultscope::require_approved(&app, &root)?;
    // Run blocking filesystem work off the async runtime worker.
    let access = crate::vaulttransaction::access(&path).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<ScanResult, String> {
        let _access = access;
        crate::vaulttransaction::recover(&path)?;
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
#[path = "vaultscan_tests.rs"]
mod tests;
