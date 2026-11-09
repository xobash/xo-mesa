// The vault visibility rule shared by native scan, read, watch, rename,
// recovery and sync walks. Matches `isIndexableVaultRelPath` and `walk` in
// `src/lib/vault.ts`. Self-contained: compiled under `sync_core` (which the
// fuzz crate includes by path) and reached elsewhere as `crate::vault_names`.

/// The one directory name skipped besides dot-prefixed names. Exact match.
pub const SKIPPED_DIR: &str = "node_modules";

/// A path segment that is never a vault document: dot-prefixed (`.git`, `.env`,
/// recovery folders) or exactly `node_modules`.
pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.') || name == SKIPPED_DIR
}

#[cfg(test)]
mod tests {
    use super::*;

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
