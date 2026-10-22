//! Pure lexical path policy and existing-path containment.
use std::path::{Path, PathBuf};

/// Join a vault-relative path safely (reject traversal / absolute segments).
pub fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    // Keep this policy platform-independent. Windows accepts drive prefixes,
    // alternate-data-stream syntax, and reserved device names that are not
    // vault-relative names even when the host is Unix.
    if rel.contains('\\') {
        return None;
    }
    let normalized = rel;
    if normalized.starts_with('/') || normalized.split('/').any(windows_reserved_segment) {
        return None;
    }
    let mut p = root.to_path_buf();
    for seg in normalized.split('/') {
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
    let path = safe_join(root, rel)?;
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
