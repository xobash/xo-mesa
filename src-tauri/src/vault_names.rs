// The vault visibility rule shared by native scan, read, watch, rename,
// recovery and sync walks. Matches `isIndexableVaultRelPath` and `walk` in
// `src/lib/vaultWalk.ts`. Self-contained: compiled under `sync_core` (which the
// fuzz crate includes by path) and reached elsewhere as `crate::vault_names`.

/// The one directory name skipped besides dot-prefixed names. Exact match.
pub const SKIPPED_DIR: &str = "node_modules";

/// A path segment that is never a vault document: dot-prefixed (`.git`, `.env`,
/// recovery folders) or exactly `node_modules`.
pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.') || name == SKIPPED_DIR
}

/// Deepest folder nesting a vault walk follows and a peer path may have. The
/// walks recurse once per level, so the cap bounds their stack use; a deeper
/// tree is skipped, never followed.
pub const MAX_REL_SEGMENTS: usize = 255;

/// A `/`-separated relative path with more than `MAX_REL_SEGMENTS` segments.
pub fn rel_too_deep(rel: &str) -> bool {
    rel.bytes().filter(|byte| *byte == b'/').count() >= MAX_REL_SEGMENTS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn depth_limit_counts_segments() {
        let at_limit = vec!["a"; MAX_REL_SEGMENTS].join("/");
        assert!(!rel_too_deep("a.md"));
        assert!(!rel_too_deep(&at_limit));
        assert!(rel_too_deep(&format!("{at_limit}/a")));
    }

    #[test]
    fn hidden_names_are_dot_prefixed_or_exact_node_modules() {
        for name in [".git", ".mesa-trash", ".", "..", "node_modules"] {
            assert!(is_hidden_name(name), "{name}");
        }
        for name in [
            "",
            "notes",
            "Node_Modules",
            "node_modules2",
            "a.md",
            "x.git",
        ] {
            assert!(!is_hidden_name(name), "{name}");
        }
    }
}
