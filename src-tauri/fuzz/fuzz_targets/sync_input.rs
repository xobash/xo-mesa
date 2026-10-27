#![no_main]

#[allow(dead_code)]
#[path = "../../src/sync_core.rs"]
mod sync_core;

use libfuzzer_sys::fuzz_target;
use std::path::Path;

fuzz_target!(|data: &[u8]| {
    if data.len() > 65536 {
        return;
    }
    if let Ok(text) = std::str::from_utf8(data) {
        let root = Path::new("fuzz-root");
        if let Some(path) = sync_core::safe_join(root, text) {
            assert!(path.starts_with(root));
            assert!(!text.split('/').any(|part| part == ".." || part == "."));
        }
        let decoded = sync_core::url_decode(text);
        let _ = sync_core::safe_join(root, &decoded);
        let _ = sync_core::query_param(text, "rel");
        let encoded = sync_core::json_str(text);
        let value: String =
            serde_json::from_str(&encoded).expect("wire escaping must produce JSON");
        assert_eq!(value, text);
    }
    if let Ok(journal) = serde_json::from_slice::<sync_core::SyncJournal>(data) {
        if sync_core::validate_journal(&journal, "fuzz input").is_ok() {
            let bytes = sync_core::journal_wire_bytes(&journal).expect("bounded fuzz journal");
            let wire: sync_core::SyncJournal =
                serde_json::from_slice(&bytes).expect("wire journal JSON");
            assert!(wire.known.is_empty());
            assert!(wire.peer_bases.is_empty());
            assert!(wire.peer_bindings.is_empty());
        }
    }
    if let Ok(entries) = serde_json::from_slice::<Vec<sync_core::ManifestEntry>>(data) {
        let _ = sync_core::manifest_to_json(&entries);
        let _ = sync_core::common_baseline(&entries, &entries);
        let _ = sync_core::diff_manifests_from_base(&entries, &entries, &[]);
    }
});
