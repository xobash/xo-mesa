//! Pure lexical path policy and existing-path containment.
use std::path::{Path, PathBuf};

/// Join a vault-relative path safely (reject traversal / absolute segments).
/// Sync's portable rule: also refuses names Windows cannot hold, on every OS,
/// so a manifest never carries a path another device rejects.
pub fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    join_checked(root, rel, true)
}

/// Local vault operations on this device: every confinement check of
/// [`safe_join`], but Windows-reserved names are refused only on Windows, so
/// a file the vault scan lists on macOS or Linux (`Why?.md`, `con.md`) can be
/// renamed, recovered and read like any other.
pub fn vault_join(root: &Path, rel: &str) -> Option<PathBuf> {
    join_checked(root, rel, cfg!(windows))
}

fn join_checked(root: &Path, rel: &str, refuse_windows_reserved: bool) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    // Windows accepts drive prefixes, alternate-data-stream syntax and device
    // names that are not vault-relative names even when the host is Unix.
    if rel.contains('\\') || rel.starts_with('/') {
        return None;
    }
    if refuse_windows_reserved && rel.split('/').any(windows_reserved_segment) {
        return None;
    }
    let mut p = root.to_path_buf();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        p.push(seg);
    }
    Some(p)
}

/// A segment Windows would reject, redirect or rename: control and wildcard
/// characters, alternate-data-stream `:`, device names (including `CONIN$`,
/// `CONOUT$` and `CLOCK$`) with or without an extension, and trailing dots or
/// spaces.
pub fn windows_reserved_segment(seg: &str) -> bool {
    if seg
        .chars()
        .any(|ch| ch <= '\u{1f}' || matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return true;
    }
    let stem = seg
        .split_once('.')
        .map(|(s, _)| s)
        .unwrap_or(seg)
        .trim_end_matches([' ', '.']);
    let upper = stem.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
    ) || (upper.chars().count() == 4
        && matches!(upper.get(0..3), Some("COM" | "LPT"))
        && matches!(upper.chars().nth(3), Some('1'..='9' | '¹' | '²' | '³')))
        || seg.ends_with([' ', '.'])
}

/// Resolve a sync path only when its existing components stay under `root`.
/// The final component may be missing for a create-only PUT.
pub fn safe_join_confined(root: &Path, rel: &str) -> Option<PathBuf> {
    confined(root, safe_join(root, rel)?)
}

/// [`safe_join_confined`] under the local [`vault_join`] rule.
pub fn vault_join_confined(root: &Path, rel: &str) -> Option<PathBuf> {
    confined(root, vault_join(root, rel)?)
}

fn confined(root: &Path, path: PathBuf) -> Option<PathBuf> {
    let canonical_root = std::fs::canonicalize(root).ok()?;
    let mut existing = path.parent()?;
    loop {
        match std::fs::canonicalize(existing) {
            Ok(canonical) => {
                if !canonical.starts_with(&canonical_root) {
                    return None;
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                existing = existing.parent()?;
            }
            Err(_) => return None,
        }
    }
    if path.exists()
        && !std::fs::canonicalize(&path)
            .ok()?
            .starts_with(&canonical_root)
    {
        return None;
    }
    Some(path)
}
