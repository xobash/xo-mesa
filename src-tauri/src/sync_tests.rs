use super::*;
use std::cell::{Cell, RefCell};

#[test]
fn sync_documentation_matches_current_protocol_constants() {
    let doc = include_str!("../../docs/sync.md");
    assert!(doc.contains(&format!(
        "journal version {JOURNAL_VERSION} and sync protocol version {SYNC_PROTOCOL_VERSION}"
    )));
    assert!(doc.contains(&format!("journalVersion: {JOURNAL_VERSION}")));
    assert!(doc.contains(&format!("syncProtocolVersion: {SYNC_PROTOCOL_VERSION}")));
    for line in doc.lines() {
        if line.contains("Every peer must advertise") {
            assert!(line.contains(&format!("journal version {JOURNAL_VERSION} and sync protocol version {SYNC_PROTOCOL_VERSION}")));
        }
    }
    let wire: serde_json::Value = serde_json::from_str(&manifest_to_json(&[])).unwrap();
    assert_eq!(wire["journalVersion"], JOURNAL_VERSION);
    assert_eq!(wire["syncProtocolVersion"], SYNC_PROTOCOL_VERSION);
}

#[test]
fn version_one_journal_upgrades_live_and_recovery_bytes() {
    let v = ManifestVault::new("journal-upgrade");
    std::fs::write(v.0.join("live.md"), b"live").unwrap();
    std::fs::create_dir(v.0.join(".mesa-trash")).unwrap();
    let deleted = v.0.join(".mesa-trash/deleted.md");
    std::fs::write(&deleted, b"deleted").unwrap();
    let mut journal = SyncJournal::empty("old-device".into());
    journal.version = 1;
    journal.known = vec![
        JournalEntry {
            rel: "live.md".into(),
            size: 4,
            hash: legacy_fingerprint(&v.0.join("live.md")).unwrap().1,
        },
        JournalEntry {
            rel: "deleted.md".into(),
            size: 7,
            hash: legacy_fingerprint(&deleted).unwrap().1,
        },
    ];
    std::fs::write(journal_path(&v.0), serde_json::to_vec(&journal).unwrap()).unwrap();
    let upgraded = load_journal(&v.0).unwrap();
    assert_eq!(upgraded.version, JOURNAL_VERSION);
    assert_eq!(upgraded.known[0].hash, content_hash_hex(b"live"));
    assert_eq!(upgraded.operations.len(), 1);
    assert_eq!(upgraded.operations[0].hash, content_hash_hex(b"deleted"));
    assert_eq!(load_journal(&v.0).unwrap().version, JOURNAL_VERSION);
}

#[test]
fn version_one_upgrade_without_original_retains_exact_record() {
    let v = ManifestVault::new("journal-upgrade-missing");
    let mut journal = SyncJournal::empty("old-device".into());
    journal.version = 1;
    journal.known = vec![JournalEntry {
        rel: "missing.md".into(),
        size: 7,
        hash: "0123456789abcdef".into(),
    }];
    let bytes = serde_json::to_vec(&journal).unwrap();
    std::fs::write(journal_path(&v.0), &bytes).unwrap();
    assert!(load_journal(&v.0).is_err());
    assert_eq!(std::fs::read(journal_path(&v.0)).unwrap(), bytes);
}

#[test]
fn idle_large_baseline_stays_local() {
    let mut journal = SyncJournal::empty("local".into());
    journal.known = (0..12_000)
        .map(|i| JournalEntry {
            rel: format!("Research/long-document-name-{i:06}-source-material.md"),
            size: 100,
            hash: "0123456789abcdef".repeat(4),
        })
        .collect();
    assert!(serde_json::to_vec(&journal).unwrap().len() > 1_048_576);
    let wire = journal_wire_bytes(&journal).unwrap();
    assert!(wire.len() < 1024);
    let received: SyncJournal = serde_json::from_slice(&wire).unwrap();
    assert!(received.known.is_empty());
    assert_eq!(journal.known.len(), 12_000);
}

#[test]
fn removed_peer_cannot_be_reintroduced_by_gossip() {
    let mut journal = SyncJournal::empty("local".into());
    journal.retired_peers.push("retired".into());
    let mut remote = SyncJournal::empty("current".into());
    remote.peers_seen.push("retired".into());
    remote
        .acked_by
        .insert("retired".into(), vec!["current:1".into()]);
    merge_remote_into(&mut journal, &remote).unwrap();
    compact_journal(&mut journal);
    assert!(!journal.peers_seen.contains(&"retired".to_string()));
    assert!(!journal.acked_by.contains_key("retired"));
}

#[test]
fn peer_removal_persists_and_rejoining_reactivates_identity() {
    let dir = std::env::temp_dir().join(format!("mesa-retire-peer-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    bind_journal_peer(&dir, "fingerprint", "peer", true).unwrap();
    retire_journal_peer(&dir, "fingerprint").unwrap();
    let retired = load_journal(&dir).unwrap();
    assert!(retired.retired_peers.contains(&"peer".to_string()));
    assert!(!retired.peers_seen.contains(&"peer".to_string()));
    bind_journal_peer(&dir, "fingerprint", "peer", true).unwrap();
    assert!(load_journal(&dir).unwrap().retired_peers.is_empty());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn retired_identity_stays_retired_when_first_seen_incoming() {
    let dir = std::env::temp_dir().join(format!("mesa-retired-incoming-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    retire_journal_peers(&dir, &["removed-fingerprint".into()]).unwrap();
    bind_journal_peer(&dir, "removed-fingerprint", "incoming-device", false).unwrap();
    let journal = load_journal(&dir).unwrap();
    assert!(journal
        .retired_peers
        .contains(&"incoming-device".to_string()));
    assert!(!journal.peers_seen.contains(&"incoming-device".to_string()));
    bind_journal_peer(&dir, "removed-fingerprint", "incoming-device", true).unwrap();
    let journal = load_journal(&dir).unwrap();
    assert!(journal.retired_fingerprints.is_empty());
    assert!(journal.retired_peers.is_empty());
    assert!(journal.peers_seen.contains(&"incoming-device".to_string()));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn removal_retires_all_historical_identities_and_migrates_single_binding() {
    let dir = std::env::temp_dir().join(format!("mesa-retired-history-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut old = serde_json::to_value(SyncJournal::empty("local".into())).unwrap();
    old["peer_bindings"] = serde_json::json!({"fingerprint": "old-device"});
    old["peers_seen"] = serde_json::json!(["old-device"]);
    std::fs::write(journal_path(&dir), serde_json::to_vec(&old).unwrap()).unwrap();
    bind_journal_peer(&dir, "fingerprint", "new-device", true).unwrap();
    retire_journal_peer(&dir, "fingerprint").unwrap();
    let journal = load_journal(&dir).unwrap();
    assert_eq!(
        journal.peer_bindings["fingerprint"],
        vec!["old-device", "new-device"]
    );
    assert!(journal.peers_seen.is_empty());
    assert!(journal.retired_peers.contains(&"old-device".into()));
    assert!(journal.retired_peers.contains(&"new-device".into()));
    bind_journal_peer(&dir, "fingerprint", "new-device", true).unwrap();
    let journal = load_journal(&dir).unwrap();
    assert_eq!(journal.peers_seen, vec!["new-device"]);
    assert_eq!(journal.retired_peers, vec!["old-device"]);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unidentified_legacy_peer_removal_preserves_journal_until_associated() {
    let dir = std::env::temp_dir().join(format!("mesa-retired-unbound-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut journal = SyncJournal::empty("local".into());
    journal.peers_seen.push("old-peer".into());
    save_journal_unlocked(&dir, &journal).unwrap();
    let before = std::fs::read(journal_path(&dir)).unwrap();
    assert!(retire_journal_peer(&dir, "fingerprint")
        .unwrap_err()
        .to_string()
        .contains("Sync with the device once"));
    assert_eq!(std::fs::read(journal_path(&dir)).unwrap(), before);
    bind_journal_peer(&dir, "fingerprint", "old-peer", true).unwrap();
    retire_journal_peer(&dir, "fingerprint").unwrap();
    assert!(load_journal(&dir).unwrap().peers_seen.is_empty());
    std::fs::remove_dir_all(dir).unwrap();
}

#[derive(Clone, Copy, Default)]
enum ExclusiveMode {
    #[default]
    Supported,
    Unsupported,
    Fail,
}

#[derive(Default)]
struct MemoryCommitFs {
    files: RefCell<HashMap<PathBuf, Vec<u8>>>,
    destination_on_publish: RefCell<Option<Vec<u8>>>,
    corrupt_published_target: Cell<bool>,
    exclusive_mode: Cell<ExclusiveMode>,
    hard_link_fail: Cell<bool>,
    hard_link_calls: Cell<u32>,
}

impl MemoryCommitFs {
    fn get(&self, path: &Path) -> Option<Vec<u8>> {
        self.files.borrow().get(path).cloned()
    }
}

impl CommitFs for MemoryCommitFs {
    fn create_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        Ok(())
    }

    #[cfg(test)]
    fn write_new(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        let mut files = self.files.borrow_mut();
        if files.contains_key(path) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "exists",
            ));
        }
        files.insert(path.to_path_buf(), bytes.to_vec());
        Ok(())
    }

    fn fingerprint(&self, path: &Path) -> std::io::Result<(u64, String)> {
        let files = self.files.borrow();
        let bytes = files
            .get(path)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "not found"))?;
        Ok((bytes.len() as u64, content_hash_hex(bytes)))
    }

    fn exclusive_publish(&self, from: &Path, to: &Path) -> Result<(), ExclusivePublishError> {
        match self.exclusive_mode.get() {
            ExclusiveMode::Unsupported => {
                return Err(ExclusivePublishError::Unsupported(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "injected unsupported exclusive rename",
                )));
            }
            ExclusiveMode::Fail => {
                return Err(ExclusivePublishError::Failed(std::io::Error::other(
                    "injected exclusive rename failure",
                )));
            }
            ExclusiveMode::Supported => {}
        }
        if let Some(bytes) = self.destination_on_publish.borrow_mut().take() {
            self.files.borrow_mut().insert(to.to_path_buf(), bytes);
            return Err(ExclusivePublishError::Failed(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "racing destination",
            )));
        }
        let mut files = self.files.borrow_mut();
        if files.contains_key(to) {
            return Err(ExclusivePublishError::Failed(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "exists",
            )));
        }
        let bytes = files.remove(from).ok_or_else(|| {
            ExclusivePublishError::Failed(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "candidate missing",
            ))
        })?;
        if self.corrupt_published_target.replace(false) {
            files.insert(to.to_path_buf(), b"external-replacement".to_vec());
        } else {
            files.insert(to.to_path_buf(), bytes);
        }
        Ok(())
    }

    fn hard_link(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        self.hard_link_calls
            .set(self.hard_link_calls.get().saturating_add(1));
        if self.hard_link_fail.get() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "injected hard-link failure",
            ));
        }
        if let Some(bytes) = self.destination_on_publish.borrow_mut().take() {
            self.files.borrow_mut().insert(to.to_path_buf(), bytes);
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "racing destination",
            ));
        }
        let bytes = self
            .get(from)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "not found"))?;
        let mut files = self.files.borrow_mut();
        if files.contains_key(to) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "exists",
            ));
        }
        if self.corrupt_published_target.replace(false) {
            files.insert(to.to_path_buf(), b"external-replacement".to_vec());
        } else {
            files.insert(to.to_path_buf(), bytes);
        }
        Ok(())
    }

    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        if self.files.borrow_mut().remove(path).is_some() {
            Ok(())
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "not found",
            ))
        }
    }
}

#[test]
fn sha256_matches_standard_vectors() {
    // Same vectors as src/lib/sync.test.ts.
    assert_eq!(
        content_hash_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        content_hash_hex(b"hello world"),
        content_hash_hex(b"hello world")
    );
    assert_ne!(content_hash_hex(b"a"), content_hash_hex(b"b"));
    assert_eq!(content_hash_hex(b"hello world").len(), 64);
}

#[test]
fn streamed_hash_equals_whole_buffer_hash() {
    let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let whole = content_hash_hex(&data);
    let mut chunked = ContentHasher::new();
    for chunk in data.chunks(7) {
        chunked.update(chunk);
    }
    assert_eq!(whole, chunked.hex());
}

#[test]
fn hash_file_streams() {
    let dir = std::env::temp_dir().join(format!("mesa-core-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("a.bin");
    std::fs::write(&f, b"hello world").unwrap();
    let (size, hash) = hash_file_streaming(&f).unwrap();
    assert_eq!(size, 11);
    assert_eq!(hash, content_hash_hex(b"hello world"));

    let _ = std::fs::remove_dir_all(&dir);
}

/// Scratch vault for the manifest tests. Enough files to cross
/// `PARALLEL_HASH_MIN_FILES`, with sizes that span the streaming buffer.
struct ManifestVault(PathBuf);
impl ManifestVault {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "mesa-manifest-{tag}-{}-{:?}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        ManifestVault(p)
    }
    fn write(&self, rel: &str, bytes: &[u8]) {
        let full = self.0.join(rel);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, bytes).unwrap();
    }
    /// 40 files: empty, sub-chunk, and several megabytes (many 64 KiB
    /// reads), nested so the walk order is not the creation order.
    fn populate(&self) -> Vec<(String, Vec<u8>)> {
        let mut made = Vec::new();
        for i in 0..40usize {
            let rel = if i % 3 == 0 {
                format!("deep/sub{}/file{i}.bin", i % 4)
            } else {
                format!("file{i}.bin")
            };
            let len = match i % 4 {
                0 => 0,
                1 => 11,
                2 => 70_000,
                _ => 2_000_000,
            };
            let bytes: Vec<u8> = (0..len).map(|n| ((n + i) % 251) as u8).collect();
            self.write(&rel, &bytes);
            made.push((rel, bytes));
        }
        made
    }
}
impl Drop for ManifestVault {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The parallel build must produce exactly the digests the serial
/// whole-buffer hash produces — the manifest is a wire format shared with
/// `src/lib/sync.ts` and with peers running older builds.
#[test]
fn build_manifest_hashes_match_whole_buffer_hashes() {
    let v = ManifestVault::new("equal");
    let made = v.populate();
    let (entries, skipped) = build_manifest(&v.0);
    assert!(skipped.is_empty(), "unexpected skips: {skipped:?}");
    assert_eq!(entries.len(), made.len());
    for (rel, bytes) in &made {
        let e = entries
            .iter()
            .find(|e| &e.rel == rel)
            .unwrap_or_else(|| panic!("missing {rel}"));
        assert_eq!(e.hash, content_hash_hex(bytes), "hash mismatch for {rel}");
        assert_eq!(e.size, bytes.len() as u64, "size mismatch for {rel}");
    }
}

/// Threads finish in nondeterministic order; the manifest must not.
#[test]
fn build_manifest_order_is_deterministic_and_sorted() {
    let v = ManifestVault::new("order");
    v.populate();
    let first = build_manifest(&v.0).0;
    let second = build_manifest(&v.0).0;
    let rels = |m: &[ManifestEntry]| m.iter().map(|e| e.rel.clone()).collect::<Vec<_>>();
    assert_eq!(rels(&first), rels(&second));
    let mut sorted = rels(&first);
    sorted.sort();
    assert_eq!(rels(&first), sorted, "manifest must stay in rel order");
    // Same bytes ⇒ same digests, whichever thread produced them.
    let hashes = |m: &[ManifestEntry]| m.iter().map(|e| e.hash.clone()).collect::<Vec<_>>();
    assert_eq!(hashes(&first), hashes(&second));
}

#[test]
fn cancellable_manifest_returns_no_partial_result() {
    let v = ManifestVault::new("cancel");
    v.populate();
    let cancelled = AtomicBool::new(true);
    assert!(build_manifest_cancellable(&v.0, &cancelled).is_none());
}

#[test]
fn build_manifest_detects_edits_with_preserved_size_and_coarse_mtime() {
    let v = ManifestVault::new("warm");
    v.populate();
    let target = v.0.join("file1.bin");
    let meta = std::fs::metadata(&target).unwrap();
    let mtime = UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
    let f = std::fs::File::options().write(true).open(&target).unwrap();
    f.set_modified(mtime).unwrap();
    drop(f);
    assert_eq!(meta.len(), 11);
    let (first, _) = build_manifest(&v.0);
    std::fs::write(&target, b"DIFFERENT!!").unwrap(); // same 11-byte length
    let f = std::fs::File::options().write(true).open(&target).unwrap();
    f.set_modified(mtime).unwrap();
    drop(f);

    let (second, _) = build_manifest(&v.0);
    let pick = |m: &[ManifestEntry]| {
        m.iter()
            .find(|e| e.rel == "file1.bin")
            .unwrap()
            .hash
            .clone()
    };
    assert_ne!(pick(&first), pick(&second));
    assert_eq!(pick(&second), content_hash_hex(b"DIFFERENT!!"));
    let diff = diff_manifests_from_base(&second, &first, &[]);
    assert!(diff.conflict.contains(&"file1.bin".to_string()));
    let base: Vec<JournalEntry> = first
        .iter()
        .map(|entry| JournalEntry {
            rel: entry.rel.clone(),
            size: entry.size,
            hash: entry.hash.clone(),
        })
        .collect();
    let diff = diff_manifests_from_base(&second, &first, &base);
    assert!(diff.push_replace.contains(&"file1.bin".to_string()));
    assert!(diff.conflict.is_empty());
    assert_eq!(
        std::fs::metadata(&target).unwrap().modified().unwrap(),
        mtime
    );

    // Every subsequent scan observes the actual bytes.
    let (third, _) = build_manifest(&v.0);
    assert_eq!(pick(&third), content_hash_hex(b"DIFFERENT!!"));
}

/// Unreadable files must land in `skipped` rather than dropping out of the
/// sync set silently, and the readable ones around them must survive.
#[cfg(unix)]
#[test]
fn build_manifest_reports_unreadable_files() {
    use std::os::unix::fs::PermissionsExt;
    let v = ManifestVault::new("perm");
    v.populate();
    let locked = v.0.join("file2.bin");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    // Root ignores the mode bits; skip rather than assert a false negative.
    if std::fs::File::open(&locked).is_ok() {
        return;
    }
    let (entries, skipped) = build_manifest(&v.0);
    assert_eq!(skipped.len(), 1, "expected one skip, got {skipped:?}");
    assert_eq!(skipped[0].0, "file2.bin");
    assert!(!entries.iter().any(|e| e.rel == "file2.bin"));
    assert_eq!(entries.len(), 39, "other files must still be manifested");
    let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644));
}

#[test]
fn missing_root_is_an_explicit_incomplete_scan() {
    let root = std::env::temp_dir().join(format!(
        "mesa-sync-missing-root-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let (entries, errors) = build_manifest(&root);
    assert!(entries.is_empty());
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].0, ".");
    assert!(errors[0].1.contains("directory failed") || errors[0].1.contains("vault root failed"));
}

#[test]
fn diff_matches_ts_vectors() {
    // Same scenario as src/lib/sync.test.ts "diffManifests".
    let e = |rel: &str, hash: &str| ManifestEntry {
        rel: rel.to_string(),
        hash: hash.to_string(),
        size: hash.len() as u64,
    };
    let local = vec![e("a.md", "1"), e("b.md", "x"), e("local.md", "9")];
    let remote = vec![e("a.md", "1"), e("b.md", "y"), e("remote.md", "7")];
    let d = diff_manifests_from_base(&local, &remote, &[]);
    assert_eq!(d.pull, vec!["remote.md"]);
    assert_eq!(d.push, vec!["local.md"]);
    assert_eq!(d.conflict, vec!["b.md"]);
    assert_eq!(d.same, 1);

    let m = vec![e("a.md", "1"), e("b.md", "2")];
    let d = diff_manifests_from_base(&m, &m.clone(), &[]);
    assert!(d.pull.is_empty() && d.push.is_empty() && d.conflict.is_empty());
    assert_eq!(d.same, 2);
}

#[test]
fn one_sided_edits_follow_the_peer_baseline() {
    let entry = |hash: &str| ManifestEntry {
        rel: "note.md".into(),
        size: 1,
        hash: hash.into(),
    };
    let base = vec![JournalEntry {
        rel: "note.md".into(),
        size: 1,
        hash: "a".into(),
    }];
    let outbound = diff_manifests_from_base(&[entry("b")], &[entry("a")], &base);
    assert_eq!(outbound.push_replace, ["note.md"]);
    assert!(outbound.conflict.is_empty());
    let inbound = diff_manifests_from_base(&[entry("a")], &[entry("b")], &base);
    assert_eq!(inbound.pull_replace, ["note.md"]);
    assert!(inbound.conflict.is_empty());
    let diverged = diff_manifests_from_base(&[entry("b")], &[entry("c")], &base);
    assert_eq!(diverged.conflict, ["note.md"]);
}

#[test]
fn conditional_edit_replaces_only_the_expected_bytes_and_keeps_recovery() {
    let root = std::env::temp_dir().join(format!("mesa-sync-edit-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let target = root.join("note.md");
    std::fs::write(&target, b"old").unwrap();
    let candidate = StagedFile::receive(
        &target,
        &b"new"[..],
        1024,
        Some(3),
        Some(&content_hash_hex(b"new")),
    )
    .unwrap();
    assert_eq!(
        candidate
            .commit_replace(&root, "note.md", 3, &content_hash_hex(b"old"))
            .unwrap(),
        CommitOutcome::Created
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"new");
    assert_eq!(
        std::fs::read_dir(root.join(".mesa-trash")).unwrap().count(),
        1
    );
    let rejected = StagedFile::receive(
        &target,
        &b"third"[..],
        1024,
        Some(5),
        Some(&content_hash_hex(b"third")),
    )
    .unwrap();
    assert!(rejected
        .commit_replace(&root, "note.md", 3, &content_hash_hex(b"old"))
        .is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"new");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn conflict_name_matches_ts() {
    // Same shape as src/lib/sync.test.ts "conflictName".
    assert_eq!(
        conflict_name("sub/Note.md", "peer.example", "2026-06-23"),
        "sub/Note (conflict from peer.example 2026-06-23).md"
    );
    assert_eq!(
        conflict_name("README", "host", "2026-06-23"),
        "README (conflict from host 2026-06-23)"
    );
    // A dot in a folder name must not be mistaken for an extension.
    assert_eq!(
        conflict_name("v1.2/notes", "h", "2026-01-01"),
        "v1.2/notes (conflict from h 2026-01-01)"
    );
}

#[test]
fn numbered_conflicts_preserve_every_same_day_copy() {
    let base = "sub/Note (conflict from peer 2026-06-23).md";
    assert_eq!(numbered_conflict_name(base, 1), base);
    assert_eq!(
        numbered_conflict_name(base, 2),
        "sub/Note (conflict from peer 2026-06-23) (2).md"
    );
    assert_eq!(numbered_conflict_name("README", 3), "README (3)");
}

#[test]
fn conflict_commit_reuses_identical_and_numbers_different_bytes() {
    let dir = std::env::temp_dir().join(format!("mesa-cc-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let base = "Note (conflict from peer 2026-06-23).md";
    std::fs::write(dir.join(base), b"first").unwrap();

    let (created, second_rel) = commit_conflict_verified(&dir, base, b"second").unwrap();
    assert_eq!(created, CommitOutcome::Created);
    assert_eq!(second_rel, "Note (conflict from peer 2026-06-23) (2).md");
    assert_eq!(std::fs::read(dir.join(base)).unwrap(), b"first");
    assert_eq!(std::fs::read(dir.join(&second_rel)).unwrap(), b"second");

    let (same, same_rel) = commit_conflict_verified(&dir, base, b"second").unwrap();
    assert_eq!(same, CommitOutcome::Unchanged);
    assert_eq!(same_rel, second_rel);

    let (third, third_rel) = commit_conflict_verified(&dir, base, b"third").unwrap();
    assert_eq!(third, CommitOutcome::Created);
    assert_eq!(third_rel, "Note (conflict from peer 2026-06-23) (3).md");
    assert_eq!(std::fs::read(dir.join(&third_rel)).unwrap(), b"third");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn conflict_prescan_finds_an_identical_numbered_copy() {
    let dir = std::env::temp_dir().join(format!("mesa-cp-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let base = "Note (conflict from peer 2026-06-23).md";
    std::fs::write(dir.join(base), b"first").unwrap();
    std::fs::write(
        dir.join("Note (conflict from peer 2026-06-23) (2).md"),
        b"remote",
    )
    .unwrap();
    let remote_hash = content_hash_hex(b"remote");
    assert!(
        conflict_copy_already_present(&dir, base, b"remote".len() as u64, &remote_hash,).unwrap()
    );
    assert!(!conflict_copy_already_present(
        &dir,
        base,
        b"third".len() as u64,
        &content_hash_hex(b"third"),
    )
    .unwrap());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn host_of_base_strips_scheme_port_path() {
    assert_eq!(host_of_base("https://peer.example:8787"), "peer.example");
    assert_eq!(host_of_base("http://mac-mini/x"), "mac-mini");
    assert_eq!(host_of_base("mac-mini:8787"), "mac-mini");
    assert_eq!(host_of_base("https://[2001:db8::1]:8787"), "2001-db8--1");
    assert_eq!(host_of_base("[2001:db8::2]:8787"), "2001-db8--2");
}

#[test]
fn conflict_source_uses_safe_saved_name() {
    assert_eq!(conflict_source("Toasty Lemon", "peer"), "Toasty Lemon");
    assert_eq!(conflict_source("../A: B?", "peer"), "A B");
    assert_eq!(conflict_source("/:", "peer"), "peer");
}

#[test]
fn utc_date_string_is_iso_shaped() {
    let d = utc_date_string();
    assert_eq!(d.len(), 10);
    assert_eq!(&d[4..5], "-");
    assert_eq!(&d[7..8], "-");
    assert!(d[..4].parse::<u32>().unwrap() >= 2024);
}

#[test]
fn safe_join_rejects_traversal() {
    let root = Path::new("/vault");
    assert!(safe_join(root, "notes/a.md").is_some());
    assert!(safe_join(root, "../etc/passwd").is_none());
    assert!(safe_join(root, "a/../../b").is_none());
    assert!(safe_join(root, "/abs").is_none());
    assert!(safe_join(root, "").is_none());
    assert!(safe_join(root, "a\\..\\b").is_none());
    assert!(safe_join(root, "C:\\outside").is_none());
    assert!(safe_join(root, "notes:stream").is_none());
    assert!(safe_join(root, "CON").is_none());
    assert!(safe_join(root, "CON.txt").is_none());
    assert!(safe_join(root, "lpt1.log").is_none());
    assert!(safe_join(root, "name.").is_none());
    assert!(safe_join(root, "name ").is_none());
    for rel in [
        "bad?.md",
        "bad*.md",
        "bad|.md",
        "COM¹.txt",
        "LPT²",
        "a\u{1f}b.md",
    ] {
        assert!(safe_join(root, rel).is_none(), "accepted {rel:?}");
    }
}

#[test]
fn manifest_reports_unportable_names_and_case_collisions() {
    let root = std::env::temp_dir().join(format!("mesa-portable-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("good.md"), b"good").unwrap();
    #[cfg(unix)]
    {
        std::fs::write(root.join("bad?.md"), b"bad").unwrap();
        std::fs::write(root.join("Case.md"), b"one").unwrap();
        std::fs::write(root.join("case.md"), b"two").unwrap();
    }
    let (entries, skipped) = build_manifest(&root);
    assert!(entries.iter().any(|entry| entry.rel == "good.md"));
    #[cfg(not(unix))]
    assert!(skipped.is_empty());
    #[cfg(unix)]
    {
        assert!(skipped.iter().any(|(rel, _)| rel == "bad?.md"));
        if std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .count()
            == 4
        {
            assert!(skipped.iter().any(|(rel, _)| rel == "Case.md"));
            assert!(skipped.iter().any(|(rel, _)| rel == "case.md"));
        }
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn safe_join_rejects_symlink_escape() {
    let dir = std::env::temp_dir().join(format!("mesa-safe-{}", std::process::id()));
    let root = dir.join("vault");
    let outside = dir.join("outside");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.md"), b"private").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
    assert!(safe_join_confined(&root, "linked/secret.md").is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn anchored_parent_creation_rejects_replaced_ancestor_without_writing_outside() {
    let dir = std::env::temp_dir().join(format!("mesa-ancestor-{}", std::process::id()));
    let root = dir.join("vault");
    let outside = dir.join("outside");
    let swap = root.join("swap");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, &swap).unwrap();
    let target = root.join("swap").join("new").join("note.md");
    let result = ensure_real_parent(&target);
    assert!(result.is_err());
    assert!(!outside.join("new").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn journal_read_rejects_a_symlink_without_touching_its_target() {
    let vault = ManifestVault::new("journal-symlink");
    let target = vault.0.join("outside.json");
    let bytes = serde_json::to_vec(&SyncJournal::empty("outside".into())).unwrap();
    std::fs::write(&target, &bytes).unwrap();
    std::os::unix::fs::symlink(&target, journal_path(&vault.0)).unwrap();
    assert!(load_journal_unlocked(&vault.0).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), bytes);
}

#[cfg(windows)]
#[test]
fn windows_held_parent_cannot_be_renamed_during_receive() {
    let vault = ManifestVault::new("windows-parent-guard");
    let parent = vault.0.join("notes");
    std::fs::create_dir(&parent).unwrap();
    let target = parent.join("new.md");
    let mut receive = StagedFile::begin(&target, 32, Some(4), None).unwrap();
    let moved = vault.0.join("moved");
    assert!(std::fs::rename(&parent, &moved).is_err());
    assert!(std::fs::rename(&vault.0, vault.0.with_extension("moved")).is_err());
    receive.write_chunk(b"safe").unwrap();
    receive.finish().unwrap().commit(&target).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"safe");
    std::fs::rename(&parent, &moved).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_parent_locks_release_after_an_interrupted_receive() {
    let vault = ManifestVault::new("windows-parent-guard");
    let target = vault.0.join("notes/new.md");
    let receive = StagedFile::begin(&target, 32, Some(4), None).unwrap();
    assert!(std::fs::rename(target.parent().unwrap(), vault.0.join("moved")).is_err());
    drop(receive);
    std::fs::rename(target.parent().unwrap(), vault.0.join("moved")).unwrap();
    assert_eq!(std::fs::read_dir(vault.0.join("moved")).unwrap().count(), 0);
}

#[cfg(windows)]
#[test]
fn windows_parent_creation_rejects_junction_without_writing_outside() {
    let base = std::env::temp_dir().join(format!(
        "mesa-windows-parent-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let root = base.join("vault");
    let outside = base.join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let junction = root.join("linked");
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&outside)
        .status()
        .unwrap();
    assert!(status.success());
    assert!(ensure_real_parent(&junction.join("new/note.md")).is_err());
    assert!(!outside.join("new").exists());
    std::fs::remove_dir(&junction).unwrap();
    std::fs::remove_dir_all(base).unwrap();
}

#[cfg(unix)]
#[test]
fn rooted_transfer_rejects_swap_before_stage_and_publishes_inside_open_parent() {
    let base =
        std::env::temp_dir().join(format!("mesa-rooted-{}-{}", std::process::id(), now_ms()));
    let root = base.join("vault");
    let outside = base.join("outside");
    let swap = root.join("swap");
    std::fs::create_dir_all(&swap).unwrap();
    std::fs::create_dir_all(outside.join("existing")).unwrap();
    let rel = "swap/existing/new/note.md";
    assert!(safe_join_confined(&root, rel).is_some());
    std::fs::rename(&swap, root.join("old")).unwrap();
    std::os::unix::fs::symlink(&outside, &swap).unwrap();
    assert!(StagedFile::receive_rooted(&root, rel, b"payload".as_slice(), 64, None, None).is_err());
    assert!(!outside.join("existing/new").exists());
    std::fs::remove_file(&swap).unwrap();
    std::fs::rename(root.join("old"), &swap).unwrap();
    let mut stage =
        StagedFile::begin_rooted(&root, rel, 64, Some(7), Some(&content_hash_hex(b"payload")))
            .unwrap();
    stage.write_chunk(b"payload").unwrap();
    let stage = stage.finish().unwrap();
    std::fs::rename(&swap, root.join("old")).unwrap();
    std::os::unix::fs::symlink(&outside, &swap).unwrap();
    assert_eq!(
        stage.commit(&root.join(rel)).unwrap(),
        CommitOutcome::Created
    );
    assert_eq!(
        std::fs::read(root.join("old/existing/new/note.md")).unwrap(),
        b"payload"
    );
    assert!(!outside.join("existing/new").exists());
    std::fs::remove_dir_all(base).unwrap();
}

#[cfg(unix)]
#[test]
fn rooted_read_never_follows_replaced_ancestor() {
    let base = std::env::temp_dir().join(format!(
        "mesa-rooted-read-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let root = base.join("vault");
    let outside = base.join("outside");
    std::fs::create_dir_all(root.join("swap")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(root.join("swap/note.md"), b"inside").unwrap();
    std::fs::write(outside.join("note.md"), b"outside").unwrap();
    let opened = RootedTarget::resolve(&root, "swap/note.md", false).unwrap();
    std::fs::rename(root.join("swap"), root.join("old")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("swap")).unwrap();
    let mut bytes = Vec::new();
    opened.open_read().unwrap().read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"inside");
    assert!(RootedTarget::resolve(&root, "swap/note.md", false).is_err());
    std::fs::remove_dir_all(base).unwrap();
}

#[cfg(unix)]
#[test]
fn conflict_copy_probe_rejects_replaced_ancestor() {
    let base = std::env::temp_dir().join(format!(
        "mesa-conflict-probe-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let root = base.join("vault");
    let outside = base.join("outside");
    std::fs::create_dir_all(root.join("swap")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("copy.md"), b"outside").unwrap();
    assert!(safe_join_confined(&root, "swap/copy.md").is_some());
    std::fs::rename(root.join("swap"), root.join("old")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("swap")).unwrap();
    assert!(
        conflict_copy_already_present(&root, "swap/copy.md", 7, &content_hash_hex(b"outside"))
            .is_err()
    );
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn nested_receive_creates_missing_confined_parents() {
    let dir = std::env::temp_dir().join(format!("mesa-nested-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let target = safe_join_confined(&dir, "new/deep/attachment.bin").unwrap();
    let stage = StagedFile::receive(
        &target,
        b"nested bytes".as_slice(),
        64,
        Some(12),
        Some(&content_hash_hex(b"nested bytes")),
    )
    .unwrap();
    stage.commit(&target).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"nested bytes");
    let _ = std::fs::remove_dir_all(&dir);
}

fn stage_test_bytes(target: &Path, bytes: &[u8]) -> StagedFile {
    StagedFile::receive(
        target,
        bytes,
        bytes.len() as u64,
        Some(bytes.len() as u64),
        Some(&content_hash_hex(bytes)),
    )
    .unwrap()
}

fn assert_no_staged_files(dir: &Path) {
    assert!(std::fs::read_dir(dir).unwrap().flatten().all(|entry| !entry
        .file_name()
        .to_string_lossy()
        .starts_with(".mesa-sync-tmp")));
}

#[test]
fn streamed_receive_is_bounded_verified_and_idempotent() {
    let vault = ManifestVault::new("streamed");
    let target = vault.0.join("file.bin");
    let bytes: Vec<_> = (0..170_000).map(|n| (n % 251) as u8).collect();
    struct SmallReads<'a>(&'a [u8]);
    impl Read for SmallReads<'_> {
        fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
            assert!(
                output.len() <= 64 * 1024,
                "receive allocated a file-sized buffer"
            );
            let size = output.len().min(97).min(self.0.len());
            output[..size].copy_from_slice(&self.0[..size]);
            self.0 = &self.0[size..];
            Ok(size)
        }
    }
    let stage = StagedFile::receive(
        &target,
        SmallReads(&bytes),
        bytes.len() as u64,
        Some(bytes.len() as u64),
        Some(&content_hash_hex(&bytes).to_uppercase()),
    )
    .unwrap();
    assert!(!target.exists());
    assert_eq!(stage.commit(&target).unwrap(), CommitOutcome::Created);
    assert_eq!(std::fs::read(&target).unwrap(), bytes);
    assert_eq!(
        stage_test_bytes(&target, &bytes).commit(&target).unwrap(),
        CommitOutcome::Unchanged
    );
    assert_no_staged_files(&vault.0);
}

#[test]
fn streamed_receive_rejects_limits_truncation_and_hash_failures() {
    let vault = ManifestVault::new("streamed-errors");
    let target = vault.0.join("file.bin");
    vault.write("file.bin", b"existing");
    assert!(matches!(
        StagedFile::receive(&target, &b"abc"[..], 2, None, None),
        Err(ReceiveError::TooLarge { limit: 2 })
    ));
    assert!(matches!(
        StagedFile::receive(&target, &b"abc"[..], 10, Some(4), None),
        Err(ReceiveError::SizeMismatch {
            expected: 4,
            actual: 3
        })
    ));
    assert!(matches!(
        StagedFile::receive(&target, &b"abc"[..], 3, Some(3), Some("bad")),
        Err(ReceiveError::HashMismatch { .. })
    ));
    assert_eq!(std::fs::read(&target).unwrap(), b"existing");
    assert_no_staged_files(&vault.0);
}

#[test]
fn streamed_receive_cleans_partial_read_failure_and_dropped_stage() {
    let vault = ManifestVault::new("streamed-interrupted");
    let target = vault.0.join("file.bin");
    struct BrokenRead(bool);
    impl Read for BrokenRead {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if self.0 {
                return Err(std::io::Error::other("connection lost"));
            }
            self.0 = true;
            out[0] = b'x';
            Ok(1)
        }
    }
    assert!(matches!(
        StagedFile::receive(&target, BrokenRead(false), 5, None, None),
        Err(ReceiveError::Read(_))
    ));
    assert_no_staged_files(&vault.0);
    drop(stage_test_bytes(&target, b"pending"));
    assert!(!target.exists());
    assert_no_staged_files(&vault.0);
}

#[test]
fn streamed_receive_retries_interrupted_reads() {
    let vault = ManifestVault::new("streamed-eintr");
    let target = vault.0.join("file.bin");
    struct InterruptedOnce(bool, std::io::Cursor<Vec<u8>>);
    impl Read for InterruptedOnce {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if !self.0 {
                self.0 = true;
                return Err(std::io::Error::from(std::io::ErrorKind::Interrupted));
            }
            self.1.read(out)
        }
    }
    let stage = StagedFile::receive(
        &target,
        InterruptedOnce(false, std::io::Cursor::new(b"bytes".to_vec())),
        5,
        Some(5),
        Some(&content_hash_hex(b"bytes")),
    )
    .unwrap();
    assert_eq!(stage.commit(&target).unwrap(), CommitOutcome::Created);
    assert_eq!(std::fs::read(&target).unwrap(), b"bytes");
    assert_no_staged_files(&vault.0);
}

#[test]
fn streamed_receive_empty_file_and_write_failure() {
    let vault = ManifestVault::new("streamed-empty");
    let target = vault.0.join("empty.bin");
    assert_eq!(
        stage_test_bytes(&target, b"").commit(&target).unwrap(),
        CommitOutcome::Created
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"");
    vault.write("blocked", b"parent is a file");
    assert!(matches!(
        StagedFile::receive(&vault.0.join("blocked/file.bin"), &b"x"[..], 1, None, None),
        Err(ReceiveError::Write(_))
    ));
    assert_eq!(
        std::fs::read(vault.0.join("blocked")).unwrap(),
        b"parent is a file"
    );
    assert_no_staged_files(&vault.0);
}

#[test]
fn streamed_commit_preserves_late_target_and_reuses_numbered_conflict() {
    let vault = ManifestVault::new("streamed-conflict");
    let target = vault.0.join("file.bin");
    let stage = stage_test_bytes(&target, b"incoming");
    vault.write("file.bin", b"late external edit");
    assert_eq!(
        stage.commit(&target).unwrap_err().kind(),
        std::io::ErrorKind::AlreadyExists
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"late external edit");
    let (outcome, rel) = stage_test_bytes(&target, b"incoming")
        .commit_conflict(&vault.0, "file.bin")
        .unwrap();
    assert_eq!(
        (outcome, rel.as_str()),
        (CommitOutcome::Created, "file (2).bin")
    );
    let (outcome, rel) = stage_test_bytes(&target, b"incoming")
        .commit_conflict(&vault.0, "file.bin")
        .unwrap();
    assert_eq!(
        (outcome, rel.as_str()),
        (CommitOutcome::Unchanged, "file (2).bin")
    );
    assert_no_staged_files(&vault.0);
}

#[test]
fn staged_publisher_preserves_candidate_for_conflict_retry() {
    let fs = MemoryCommitFs::default();
    let target = Path::new("/vault/n.md");
    let candidate = Path::new("/vault/.candidate");
    fs.write_new(candidate, b"incoming").unwrap();
    *fs.destination_on_publish.borrow_mut() = Some(b"racing external".to_vec());
    let mut preserve = false;
    assert_eq!(
        publish_verified_candidate(
            &fs,
            candidate,
            target,
            8,
            &content_hash_hex(b"incoming"),
            &mut preserve
        )
        .unwrap_err()
        .kind(),
        std::io::ErrorKind::AlreadyExists
    );
    assert_eq!(fs.get(candidate).unwrap(), b"incoming");
    assert_eq!(fs.get(target).unwrap(), b"racing external");
    assert!(!preserve);
}

#[test]
fn staged_publisher_preserves_link_after_failed_final_readback() {
    let fs = MemoryCommitFs::default();
    let target = Path::new("/vault/n.md");
    let candidate = Path::new("/vault/.candidate");
    fs.write_new(candidate, b"incoming").unwrap();
    fs.exclusive_mode.set(ExclusiveMode::Unsupported);
    fs.corrupt_published_target.set(true);
    let mut preserve = false;
    assert!(publish_verified_candidate(
        &fs,
        candidate,
        target,
        8,
        &content_hash_hex(b"incoming"),
        &mut preserve
    )
    .is_err());
    assert!(preserve);
    assert_eq!(fs.get(candidate).unwrap(), b"incoming");
    assert_eq!(fs.get(target).unwrap(), b"external-replacement");
}

#[test]
fn verified_create_is_idempotent_and_never_replaces() {
    let dir = std::env::temp_dir().join(format!("mesa-vc-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let target = dir.join("deep/nested/n.md");
    assert_eq!(
        commit_verified_create(&target, b"one").unwrap(),
        CommitOutcome::Created
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"one");
    assert_eq!(
        commit_verified_create(&target, b"one").unwrap(),
        CommitOutcome::Unchanged
    );
    let err = commit_verified_create(&target, b"two").unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    assert_eq!(std::fs::read(&target).unwrap(), b"one");
    // No temp litter left behind.
    let litter: Vec<_> = std::fs::read_dir(target.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(".mesa-sync-tmp")
        })
        .collect();
    assert!(litter.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn exclusive_publish_race_preserves_the_other_writer() {
    let fs = MemoryCommitFs::default();
    let target = Path::new("/vault/n.md");
    *fs.destination_on_publish.borrow_mut() = Some(b"external".to_vec());
    let incoming = b"remote";
    let err = commit_verified_create_with_fs(
        &fs,
        target,
        incoming,
        incoming.len() as u64,
        &content_hash_hex(incoming),
    )
    .unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    assert_eq!(fs.get(target).unwrap(), b"external");
}

#[test]
fn hard_link_is_only_used_when_exclusive_rename_is_unsupported() {
    let fs = MemoryCommitFs::default();
    let target = Path::new("/vault/n.md");
    fs.exclusive_mode.set(ExclusiveMode::Unsupported);
    let incoming = b"remote";
    let outcome = commit_verified_create_with_fs(
        &fs,
        target,
        incoming,
        incoming.len() as u64,
        &content_hash_hex(incoming),
    )
    .unwrap();
    assert_eq!(outcome, CommitOutcome::Created);
    assert_eq!(fs.get(target).unwrap(), incoming);
    assert_eq!(fs.hard_link_calls.get(), 1);
}

#[test]
fn supported_exclusive_rename_never_uses_hard_link() {
    let fs = MemoryCommitFs::default();
    let target = Path::new("/vault/n.md");
    let incoming = b"remote";
    let outcome = commit_verified_create_with_fs(
        &fs,
        target,
        incoming,
        incoming.len() as u64,
        &content_hash_hex(incoming),
    )
    .unwrap();
    assert_eq!(outcome, CommitOutcome::Created);
    assert_eq!(fs.hard_link_calls.get(), 0);
}

#[test]
fn platform_exclusive_publish_refuses_an_existing_target() {
    let dir = std::env::temp_dir().join(format!("mesa-xr-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let candidate = dir.join("candidate");
    let target = dir.join("target");
    std::fs::write(&candidate, b"incoming").unwrap();
    std::fs::write(&target, b"existing").unwrap();

    match platform_exclusive_publish(&candidate, &target).unwrap_err() {
        ExclusivePublishError::Failed(error) => {
            assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists)
        }
        ExclusivePublishError::Unsupported(error) => {
            panic!("exclusive publish is unsupported: {error}")
        }
    }
    assert_eq!(std::fs::read(&target).unwrap(), b"existing");
    assert_eq!(std::fs::read(&candidate).unwrap(), b"incoming");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unsupported_exclusive_rename_and_hard_link_fail_closed() {
    let fs = MemoryCommitFs::default();
    let target = Path::new("/vault/n.md");
    fs.exclusive_mode.set(ExclusiveMode::Unsupported);
    fs.hard_link_fail.set(true);
    let incoming = b"remote";
    let err = commit_verified_create_with_fs(
        &fs,
        target,
        incoming,
        incoming.len() as u64,
        &content_hash_hex(incoming),
    )
    .unwrap_err();
    assert!(err
        .to_string()
        .contains("native exclusive rename is unsupported"));
    assert!(err.to_string().contains("safe hard-link fallback failed"));
    assert!(fs.get(target).is_none());
}

#[test]
fn arbitrary_exclusive_rename_failure_does_not_fallback_or_publish() {
    let fs = MemoryCommitFs::default();
    let target = Path::new("/vault/n.md");
    fs.exclusive_mode.set(ExclusiveMode::Fail);
    let incoming = b"remote";
    let err = commit_verified_create_with_fs(
        &fs,
        target,
        incoming,
        incoming.len() as u64,
        &content_hash_hex(incoming),
    )
    .unwrap_err();
    assert!(err
        .to_string()
        .contains("injected exclusive rename failure"));
    assert_eq!(fs.hard_link_calls.get(), 0);
    assert!(fs.get(target).is_none());
}

#[test]
fn final_readback_failure_preserves_a_possible_replacement() {
    let fs = MemoryCommitFs::default();
    let target = Path::new("/vault/n.md");
    fs.corrupt_published_target.set(true);
    let incoming = b"remote";
    let err = commit_verified_create_with_fs(
        &fs,
        target,
        incoming,
        incoming.len() as u64,
        &content_hash_hex(incoming),
    )
    .unwrap_err();
    assert!(err
        .to_string()
        .contains("portable file-identity proof is unavailable"));
    assert_eq!(fs.get(target).unwrap(), b"external-replacement");
}

#[test]
fn candidate_names_are_unique_and_recovery_visible() {
    let target = Path::new("/vault/n.md");
    let first = candidate_path(target);
    let second = candidate_path(target);
    assert_ne!(first, second);
    for path in [first, second] {
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(&format!(".mesa-sync-tmp-{}-", std::process::id())));
    }
}

#[test]
fn list_vault_files_skips_hidden_and_node_modules() {
    let dir = std::env::temp_dir().join(format!("mesa-ls-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("notes")).unwrap();
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
    std::fs::write(dir.join("notes/a.md"), b"a").unwrap();
    std::fs::write(dir.join("b.md"), b"b").unwrap();
    std::fs::write(dir.join(".DS_Store"), b"x").unwrap();
    std::fs::write(dir.join(".git/config"), b"x").unwrap();
    std::fs::write(dir.join("node_modules/pkg/i.js"), b"x").unwrap();
    let rels: Vec<String> = list_vault_files(&dir).into_iter().map(|(r, _)| r).collect();
    assert_eq!(rels, vec!["b.md".to_string(), "notes/a.md".to_string()]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn journal_recovers_delete_and_unique_rename_from_snapshot() {
    let dir = std::env::temp_dir().join(format!("mesa-journal-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("old.md"), b"same").unwrap();
    std::fs::write(dir.join("gone.md"), b"gone").unwrap();
    let (first, _) = build_manifest(&dir);
    reconcile_journal(&dir, &first).unwrap();
    std::fs::rename(dir.join("old.md"), dir.join("new.md")).unwrap();
    std::fs::remove_file(dir.join("gone.md")).unwrap();
    let (second, _) = build_manifest(&dir);
    let journal = reconcile_journal(&dir, &second).unwrap();
    assert!(journal
        .operations
        .iter()
        .any(|op| op.kind == JournalOperationKind::Rename
            && op.from == "old.md"
            && op.to.as_deref() == Some("new.md")));
    assert!(journal
        .operations
        .iter()
        .any(|op| op.kind == JournalOperationKind::Delete && op.from == "gone.md"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn journal_delete_preserves_changed_local_content() {
    let dir = std::env::temp_dir().join(format!("mesa-journal-conflict-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("note.md"), b"changed locally").unwrap();
    let op = JournalOperation {
        id: "peer:1".to_string(),
        device: "peer".to_string(),
        sequence: 1,
        at_ms: 0,
        kind: JournalOperationKind::Delete,
        from: "note.md".to_string(),
        to: None,
        size: 6,
        hash: content_hash_hex(b"remote"),
    };
    assert_eq!(
        apply_journal_operation(&dir, &op).unwrap(),
        JournalApply::Conflict
    );
    assert_eq!(
        std::fs::read(dir.join("note.md")).unwrap(),
        b"changed locally"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn incomplete_scan_never_replaces_the_complete_journal_baseline() {
    let dir = std::env::temp_dir().join(format!("mesa-journal-partial-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("keep.md"), b"keep").unwrap();
    let (complete, _) = build_manifest(&dir);
    reconcile_journal(&dir, &complete).unwrap();

    let partial = Vec::new();
    let journal = reconcile_complete_journal(
        &dir,
        &partial,
        &[("locked".to_string(), "permission denied".to_string())],
    )
    .unwrap();
    assert!(journal.operations.is_empty());
    assert_eq!(journal.known.len(), 1);
    assert_eq!(journal.known[0].rel, "keep.md");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn received_delete_moves_matching_bytes_into_recovery_storage() {
    let dir = std::env::temp_dir().join(format!("mesa-journal-trash-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("note.md"), b"remote").unwrap();
    let op = JournalOperation {
        id: "peer:1".to_string(),
        device: "peer".to_string(),
        sequence: 1,
        at_ms: 0,
        kind: JournalOperationKind::Delete,
        from: "note.md".to_string(),
        to: None,
        size: 6,
        hash: content_hash_hex(b"remote"),
    };
    assert_eq!(
        apply_journal_operation(&dir, &op).unwrap(),
        JournalApply::Applied
    );
    assert!(!dir.join("note.md").exists());
    let trash = std::fs::read_dir(dir.join(".mesa-trash")).unwrap().count();
    assert_eq!(trash, 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn merged_journal_keeps_numeric_device_order() {
    let dir = std::env::temp_dir().join(format!("mesa-journal-order-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let remote = SyncJournal {
        version: JOURNAL_VERSION,
        device: "peer".to_string(),
        next_sequence: 11,
        known: Vec::new(),
        peer_bases: HashMap::new(),
        peer_bindings: HashMap::new(),
        retired_peers: Vec::new(),
        retired_fingerprints: Vec::new(),
        applied: Vec::new(),
        acked_by: HashMap::new(),
        peers_seen: Vec::new(),
        operations: vec![
            JournalOperation {
                id: "peer:10".to_string(),
                device: "peer".to_string(),
                sequence: 10,
                at_ms: 0,
                kind: JournalOperationKind::Delete,
                from: "ten".to_string(),
                to: None,
                size: 0,
                hash: content_hash_hex(b""),
            },
            JournalOperation {
                id: "peer:2".to_string(),
                device: "peer".to_string(),
                sequence: 2,
                at_ms: 0,
                kind: JournalOperationKind::Delete,
                from: "two".to_string(),
                to: None,
                size: 0,
                hash: content_hash_hex(b""),
            },
        ],
    };
    let merged = merge_journal(&dir, &remote).unwrap();
    let sequences: Vec<u64> = merged
        .operations
        .iter()
        .filter(|op| op.device == "peer")
        .map(|op| op.sequence)
        .collect();
    assert_eq!(sequences, vec![2, 10]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn apply_incoming_journal_applies_and_acks_received_delete() {
    let dir = std::env::temp_dir().join(format!("mesa-journal-incoming-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("note.md"), b"remote").unwrap();
    let op = JournalOperation {
        id: "peer:1".to_string(),
        device: "peer".to_string(),
        sequence: 1,
        at_ms: 0,
        kind: JournalOperationKind::Delete,
        from: "note.md".to_string(),
        to: None,
        size: 6,
        hash: content_hash_hex(b"remote"),
    };
    let incoming = SyncJournal {
        version: JOURNAL_VERSION,
        device: "peer".to_string(),
        next_sequence: 2,
        operations: vec![op.clone()],
        applied: Vec::new(),
        acked_by: HashMap::new(),
        peers_seen: Vec::new(),
        known: Vec::new(),
        peer_bases: HashMap::new(),
        peer_bindings: HashMap::new(),
        retired_peers: Vec::new(),
        retired_fingerprints: Vec::new(),
    };

    let (journal, outcomes) = apply_incoming_journal(&dir, &incoming).unwrap();

    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].operation.id, op.id);
    assert_eq!(outcomes[0].result, Ok(JournalApply::Applied));
    assert!(journal.applied.iter().any(|id| id == "peer:1"));
    assert!(!dir.join("note.md").exists());
    assert_eq!(
        std::fs::read_dir(dir.join(".mesa-trash")).unwrap().count(),
        1
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn compaction_waits_for_offline_known_peer_ack() {
    let dir = std::env::temp_dir().join(format!("mesa-journal-compact-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let op = JournalOperation {
        id: "local:1".to_string(),
        device: "local".to_string(),
        sequence: 1,
        at_ms: 0,
        kind: JournalOperationKind::Delete,
        from: "gone.md".to_string(),
        to: None,
        size: 4,
        hash: content_hash_hex(b"gone"),
    };
    let mut journal = SyncJournal {
        version: JOURNAL_VERSION,
        device: "local".to_string(),
        next_sequence: 2,
        operations: vec![op.clone()],
        applied: Vec::new(),
        acked_by: HashMap::from([("peer-a".to_string(), vec![op.id.clone()])]),
        peers_seen: vec!["peer-a".to_string(), "peer-b".to_string()],
        known: Vec::new(),
        peer_bases: HashMap::new(),
        peer_bindings: HashMap::new(),
        retired_peers: Vec::new(),
        retired_fingerprints: Vec::new(),
    };
    save_journal(&dir, &journal).unwrap();
    assert!(load_journal(&dir)
        .unwrap()
        .operations
        .iter()
        .any(|saved| saved.id == op.id));

    journal
        .acked_by
        .insert("peer-b".to_string(), vec![op.id.clone()]);
    save_journal(&dir, &journal).unwrap();
    assert!(!load_journal(&dir)
        .unwrap()
        .operations
        .iter()
        .any(|saved| saved.id == op.id));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn journal_restore_emits_an_explicit_operation_after_local_delete() {
    let dir = std::env::temp_dir().join(format!("mesa-journal-restore-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("note.md"), b"restore me").unwrap();
    let (first, _) = build_manifest(&dir);
    reconcile_journal(&dir, &first).unwrap();

    std::fs::remove_file(dir.join("note.md")).unwrap();
    let (deleted, _) = build_manifest(&dir);
    let with_delete = reconcile_journal(&dir, &deleted).unwrap();
    assert!(with_delete
        .operations
        .iter()
        .any(|op| { op.kind == JournalOperationKind::Delete && op.from == "note.md" }));

    std::fs::write(dir.join("note.md"), b"restore me").unwrap();
    let (restored, _) = build_manifest(&dir);
    let journal = reconcile_journal(&dir, &restored).unwrap();
    assert!(journal
        .operations
        .iter()
        .any(|op| { op.kind == JournalOperationKind::Delete && op.from == "note.md" }));
    assert!(journal
        .operations
        .iter()
        .any(|op| { op.kind == JournalOperationKind::Restore && op.from == "note.md" }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn received_restore_recovers_matching_remote_deletion() {
    let dir = std::env::temp_dir().join(format!(
        "mesa-journal-restore-incoming-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("note.md"), b"restore me").unwrap();
    let hash = content_hash_hex(b"restore me");
    let delete = JournalOperation {
        id: "peer:1".to_string(),
        device: "peer".to_string(),
        sequence: 1,
        at_ms: 0,
        kind: JournalOperationKind::Delete,
        from: "note.md".to_string(),
        to: None,
        size: 10,
        hash: hash.clone(),
    };
    assert_eq!(
        apply_journal_operation(&dir, &delete).unwrap(),
        JournalApply::Applied
    );
    let restore = JournalOperation {
        id: "peer:2".to_string(),
        device: "peer".to_string(),
        sequence: 2,
        at_ms: 0,
        kind: JournalOperationKind::Restore,
        from: "note.md".to_string(),
        to: None,
        size: 10,
        hash,
    };
    assert_eq!(
        apply_journal_operation(&dir, &restore).unwrap(),
        JournalApply::Applied
    );
    assert_eq!(std::fs::read(dir.join("note.md")).unwrap(), b"restore me");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn incoming_journal_rejects_malformed_operation_identity() {
    let dir = std::env::temp_dir().join(format!("mesa-journal-invalid-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let incoming = SyncJournal {
        version: JOURNAL_VERSION,
        device: "peer".to_string(),
        next_sequence: 2,
        operations: vec![JournalOperation {
            id: "not-peer:1".to_string(),
            device: "peer".to_string(),
            sequence: 1,
            at_ms: 0,
            kind: JournalOperationKind::Delete,
            from: "note.md".to_string(),
            to: None,
            size: 0,
            hash: content_hash_hex(b""),
        }],
        applied: Vec::new(),
        acked_by: HashMap::new(),
        peers_seen: Vec::new(),
        known: Vec::new(),
        peer_bases: HashMap::new(),
        peer_bindings: HashMap::new(),
        retired_peers: Vec::new(),
        retired_fingerprints: Vec::new(),
    };
    assert!(apply_incoming_journal(&dir, &incoming).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn incoming_rename_chain_uses_numeric_sequence_not_wire_order() {
    let dir = std::env::temp_dir().join(format!("mesa-journal-chain-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("old.md"), b"same").unwrap();
    let hash = content_hash_hex(b"same");
    let first = JournalOperation {
        id: "peer:2".to_string(),
        device: "peer".to_string(),
        sequence: 2,
        at_ms: 0,
        kind: JournalOperationKind::Rename,
        from: "middle.md".to_string(),
        to: Some("new.md".to_string()),
        size: 4,
        hash: hash.clone(),
    };
    let second = JournalOperation {
        id: "peer:1".to_string(),
        device: "peer".to_string(),
        sequence: 1,
        at_ms: 0,
        kind: JournalOperationKind::Rename,
        from: "old.md".to_string(),
        to: Some("middle.md".to_string()),
        size: 4,
        hash,
    };
    let incoming = SyncJournal {
        version: JOURNAL_VERSION,
        device: "peer".to_string(),
        next_sequence: 3,
        operations: vec![first, second],
        applied: Vec::new(),
        acked_by: HashMap::new(),
        peers_seen: Vec::new(),
        known: Vec::new(),
        peer_bases: HashMap::new(),
        peer_bindings: HashMap::new(),
        retired_peers: Vec::new(),
        retired_fingerprints: Vec::new(),
    };
    let (_, outcomes) = apply_incoming_journal(&dir, &incoming).unwrap();
    assert_eq!(
        outcomes
            .iter()
            .map(|outcome| outcome.operation.sequence)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(std::fs::read(dir.join("new.md")).unwrap(), b"same");
    assert!(!dir.join("old.md").exists());
    assert!(!dir.join("middle.md").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn manifest_json_escapes() {
    let entries = vec![ManifestEntry {
        rel: "we\"ird\nname.md".to_string(),
        size: 3,
        hash: "abc".to_string(),
    }];
    let j = manifest_to_json(&entries);
    assert_eq!(
            j,
            "{\"journalVersion\":2,\"syncProtocolVersion\":3,\"files\":[{\"rel\":\"we\\\"ird\\nname.md\",\"size\":3,\"hash\":\"abc\"}]}"
        );
}

#[test]
fn malformed_percent_escapes_preserve_unicode_without_panicking() {
    for input in [
        "%oΚ",
        "%Κ",
        "%a😀",
        "relrel=setn%oΚњd\n",
        "%",
        "%a",
        "100%文",
    ] {
        assert_eq!(url_decode(input), input);
    }
    assert_eq!(url_decode("%CE%9A+%f0%9f%98%80"), "Κ 😀");
    assert_eq!(query_param("rel=%oΚ", "rel").as_deref(), Some("%oΚ"));
}

#[test]
fn query_param_decodes() {
    assert_eq!(
        query_param("rel=notes%2Fa%20b.md&x=1", "rel").as_deref(),
        Some("notes/a b.md")
    );
    assert_eq!(query_param("rel=a+b", "rel").as_deref(), Some("a b"));
    assert_eq!(query_param("x=1", "rel"), None);
}

#[test]
fn peer_path_policy_rejects_hidden_and_ignored_segments() {
    for rel in [
        ".git/config",
        "a/.hidden/b.md",
        "node_modules/x",
        "a/node_modules/x.js",
        ".mesa-sync-journal.json",
        ".mesa-trash/old.md",
        ".env",
        "../escape.md",
        "",
    ] {
        assert!(!is_peer_rel(rel), "{rel:?} must be rejected");
        let dir = std::env::temp_dir();
        assert!(peer_join_confined(&dir, rel).is_none(), "{rel:?}");
    }
    for rel in ["note.md", "a/b/c.md", "name with space.txt"] {
        assert!(is_peer_rel(rel), "{rel:?} must be accepted");
    }
}

#[test]
fn incoming_journal_rejects_hidden_sources_and_destinations() {
    let op = |kind, from: &str, to: Option<&str>| SyncJournal {
        version: JOURNAL_VERSION,
        device: "peer".to_string(),
        next_sequence: 2,
        operations: vec![JournalOperation {
            id: "peer:1".to_string(),
            device: "peer".to_string(),
            sequence: 1,
            at_ms: 0,
            kind,
            from: from.to_string(),
            to: to.map(str::to_string),
            size: 1,
            hash: content_hash_hex(b"x"),
        }],
        applied: vec![],
        acked_by: Default::default(),
        peers_seen: vec![],
        known: vec![],
        peer_bases: Default::default(),
        peer_bindings: Default::default(),
        retired_peers: vec![],
        retired_fingerprints: vec![],
    };
    for from in [".git/config", "node_modules/x", "a/.x/b.md"] {
        assert!(validate_journal(&op(JournalOperationKind::Delete, from, None), "j").is_err());
        assert!(
            validate_journal(&op(JournalOperationKind::Rename, "ok.md", Some(from)), "j").is_err()
        );
        assert!(
            validate_journal(&op(JournalOperationKind::Rename, from, Some("ok2.md")), "j").is_err()
        );
    }
    assert!(validate_journal(&op(JournalOperationKind::Delete, "ok.md", None), "j").is_ok());
}
