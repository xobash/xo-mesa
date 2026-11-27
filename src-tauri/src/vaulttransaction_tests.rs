use super::*;
#[cfg(unix)]
#[test]
fn research_reads_refuse_links_and_fifos_without_blocking() {
    let dir = std::env::temp_dir().join(format!("mesa-research-read-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("note.md"), b"text").unwrap();
    std::os::unix::fs::symlink(dir.join("note.md"), dir.join("link.md")).unwrap();
    let fifo = std::ffi::CString::new(dir.join("pipe.md").to_str().unwrap()).unwrap();
    // SAFETY: the path is NUL-terminated and owned for the call.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert_eq!(
        read(&dir.join("note.md")).unwrap().as_deref(),
        Some(&b"text"[..])
    );
    assert_eq!(read(&dir.join("missing.md")).unwrap(), None);
    assert!(read(&dir.join("link.md")).is_err());
    assert!(read(&dir.join("pipe.md")).is_err());
    fs::remove_dir_all(dir).unwrap();
}
fn folder(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("mesa-research-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}
fn changes() -> Vec<Change> {
    vec![
        Change {
            rel_path: "new.md".into(),
            content: "new".into(),
            expected_content: None,
        },
        Change {
            rel_path: "old.md".into(),
            content: "updated".into(),
            expected_content: Some("original".into()),
        },
    ]
}
#[cfg(unix)]
#[test]
fn research_targets_reject_a_short_name_alias_of_a_hidden_folder() {
    let root = folder("short-name");
    fs::create_dir_all(root.join(".git/hooks")).unwrap();
    std::os::unix::fs::symlink(".git", root.join("GIT~1")).unwrap();
    assert!(target(&root, "GIT~1/hooks/post-checkout").is_err());
    assert!(target(&root, "notes/new.md").is_ok());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn crash_after_each_publication_recovers_originals() {
    for stop in 0..=2 {
        let root = folder(&format!("crash-{stop}"));
        fs::write(root.join("old.md"), "original").unwrap();
        assert!(apply(&root, changes(), Some(stop)).is_err());
        recover(&root).unwrap();
        assert!(!root.join("new.md").exists());
        assert_eq!(fs::read(root.join("old.md")).unwrap(), b"original");
        assert!(!root.join(RECORD).exists());
        fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn interrupted_recovery_preserves_external_edits_and_record() {
    let root = folder("external");
    fs::write(root.join("old.md"), "original").unwrap();
    assert!(apply(&root, changes(), Some(1)).is_err());
    fs::write(root.join("new.md"), "external").unwrap();
    assert!(recover(&root).is_err());
    assert_eq!(fs::read(root.join("new.md")).unwrap(), b"external");
    assert!(root.join(RECORD).exists());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn complete_transaction_publishes_every_step() {
    let root = folder("success");
    fs::write(root.join("old.md"), "original").unwrap();
    assert_eq!(
        apply(&root, changes(), None).unwrap(),
        vec!["new.md", "old.md"]
    );
    assert_eq!(fs::read(root.join("old.md")).unwrap(), b"updated");
    assert!(!root.join(RECORD).exists());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn committed_recovery_keeps_the_complete_published_set() {
    let root = folder("committed");
    let record = Record {
        version: 1,
        committed: true,
        entries: vec![Entry {
            rel: "old.md".into(),
            before: Some(b"original".to_vec()),
            after: b"updated".to_vec(),
        }],
    };
    fs::write(root.join("old.md"), "updated").unwrap();
    save_record(&root, &record, None).unwrap();
    recover(&root).unwrap();
    assert_eq!(fs::read(root.join("old.md")).unwrap(), b"updated");
    assert!(!root.join(RECORD).exists());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn nested_creation_recovers_after_interruption() {
    let root = folder("nested");
    let changes = vec![
        Change {
            rel_path: "reports/topic/new.md".into(),
            content: "reviewed content".into(),
            expected_content: None,
        },
        Change {
            rel_path: "top.md".into(),
            content: "top content".into(),
            expected_content: None,
        },
    ];
    assert!(apply(&root, changes, Some(2)).is_err());
    assert_eq!(
        fs::read(root.join("reports/topic/new.md")).unwrap(),
        b"reviewed content"
    );
    recover(&root).unwrap();
    assert!(!root.join("reports/topic/new.md").exists());
    assert!(!root.join(RECORD).exists());
    assert!(!root.join("top.md").exists());
    let listed = crate::vaultops::list_recovery(&root).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].original_rel_path, "reports/topic/new.md");
    assert_eq!(
        fs::read(root.join(&listed[0].trash_rel_path)).unwrap(),
        b"reviewed content"
    );
    assert_eq!(listed[1].original_rel_path, "top.md");
    assert_eq!(
        fs::read(root.join(&listed[1].trash_rel_path)).unwrap(),
        b"top content"
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn stale_review_touches_no_files() {
    let root = folder("stale");
    fs::write(root.join("old.md"), "external").unwrap();
    assert!(apply(&root, changes(), None).is_err());
    assert!(!root.join("new.md").exists());
    assert!(!root.join(RECORD).exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn record_bytes_use_hex_and_legacy_number_arrays_still_load() {
    let record = Record {
        version: 1,
        committed: false,
        entries: vec![
            Entry {
                rel: "a.md".into(),
                before: Some(vec![0, 255, 16]),
                after: vec![1, 2],
            },
            Entry {
                rel: "b.md".into(),
                before: None,
                after: vec![],
            },
        ],
    };
    let json = serde_json::to_string(&record).unwrap();
    assert!(json.contains(r#""before":"00ff10""#), "{json}");
    let loaded: Record = serde_json::from_str(&json).unwrap();
    assert_eq!(loaded.entries[0].before, Some(vec![0, 255, 16]));
    assert_eq!(loaded.entries[1].before, None);
    assert_eq!(loaded.entries[1].after, Vec::<u8>::new());
    let legacy = r#"{"version":1,"committed":false,"entries":[{"rel":"a.md","before":[104,105],"after":[1]},{"rel":"b.md","before":null,"after":[]}]}"#;
    let loaded: Record = serde_json::from_str(legacy).unwrap();
    assert_eq!(loaded.entries[0].before, Some(b"hi".to_vec()));
    assert_eq!(loaded.entries[0].after, vec![1]);
    for bad in [r#""abc""#, r#""zz""#] {
        let text = format!(r#"{{"rel":"x","before":null,"after":{bad}}}"#);
        assert!(serde_json::from_str::<Entry>(&text).is_err());
    }
}

type TrashMoveHook = Box<dyn FnOnce(&Path, &str, &str)>;

thread_local! {
    /// Runs once on this test thread right after a rollback moves a created
    /// file into `.mesa-trash`, to stage a concurrent external change.
    static AFTER_TRASH_MOVE: std::cell::RefCell<Option<TrashMoveHook>> =
        const { std::cell::RefCell::new(None) };
}

pub(super) fn after_trash_move(root: &Path, rel: &str, trash_rel: &str) {
    if let Some(hook) = AFTER_TRASH_MOVE.with(|slot| slot.borrow_mut().take()) {
        hook(root, rel, trash_rel);
    }
}

#[test]
fn failed_move_back_names_the_trash_path_and_keeps_bytes_and_record() {
    let root = folder("move-back");
    fs::write(root.join("old.md"), "original").unwrap();
    assert!(apply(&root, changes(), Some(1)).is_err());
    // Between the move-out and the recheck, another writer edits the rescued
    // bytes and recreates the original path, so a no-replace move-back fails.
    AFTER_TRASH_MOVE.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(|root: &Path, rel: &str, trash_rel: &str| {
            fs::write(root.join(trash_rel), b"edited elsewhere").unwrap();
            fs::write(root.join(rel), b"recreated").unwrap();
        }));
    });
    let error = recover(&root).unwrap_err();
    let listed = crate::vaultops::list_recovery(&root).unwrap();
    assert_eq!(listed.len(), 1);
    let trash_rel = &listed[0].trash_rel_path;
    assert!(error.contains(trash_rel.as_str()), "{error}");
    assert!(!error.contains(root.to_str().unwrap()), "{error}");
    assert_eq!(fs::read(root.join(trash_rel)).unwrap(), b"edited elsewhere");
    assert_eq!(fs::read(root.join("new.md")).unwrap(), b"recreated");
    assert!(root.join(RECORD).exists());
    fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[test]
fn recovery_refuses_a_fifo_record_without_blocking() {
    let root = folder("fifo-record");
    let record = std::ffi::CString::new(root.join(RECORD).to_str().unwrap()).unwrap();
    // SAFETY: the path is NUL-terminated and owned for the call.
    assert_eq!(unsafe { libc::mkfifo(record.as_ptr(), 0o600) }, 0);
    let (sender, receiver) = std::sync::mpsc::channel();
    let probe = root.clone();
    std::thread::spawn(move || {
        let _ = sender.send(recover(&probe));
    });
    let result = receiver.recv_timeout(std::time::Duration::from_secs(10));
    if result.is_err() {
        // Release a blocked reader so WRITE_LOCK frees for the other tests.
        let _ = fs::OpenOptions::new().write(true).open(root.join(RECORD));
        panic!("recovery blocked on a FIFO record");
    }
    assert!(result.unwrap().is_err());
    fs::remove_dir_all(root).unwrap();
}

type RecordHook = Box<dyn FnOnce(&Path)>;

thread_local! {
    /// Runs once on this test thread just before apply writes its completion
    /// marker, to change the record underneath the transaction.
    static BEFORE_COMPLETION_MARKER: std::cell::RefCell<Option<RecordHook>> =
        const { std::cell::RefCell::new(None) };
}

pub(super) fn before_completion_marker(root: &Path) {
    if let Some(hook) = BEFORE_COMPLETION_MARKER.with(|slot| slot.borrow_mut().take()) {
        hook(root);
    }
}

#[test]
fn a_record_changed_underneath_is_refused_not_overwritten() {
    let root = folder("record-changed");
    fs::write(root.join("old.md"), "original").unwrap();
    BEFORE_COMPLETION_MARKER.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(|root: &Path| {
            fs::write(root.join(RECORD), b"changed elsewhere").unwrap();
        }));
    });
    let error = apply(&root, changes(), None).unwrap_err();
    assert!(error.contains("Research recovery is pending"), "{error}");
    assert_eq!(fs::read(root.join(RECORD)).unwrap(), b"changed elsewhere");
    // Nothing is undone over a record this transaction no longer owns.
    assert_eq!(fs::read(root.join("old.md")).unwrap(), b"updated");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_failed_completion_marker_restores_rollback_intent_over_its_own_marker() {
    let root = folder("marker-restore");
    let mut record = Record {
        version: 1,
        committed: false,
        entries: vec![Entry {
            rel: "old.md".into(),
            before: Some(b"original".to_vec()),
            after: b"updated".to_vec(),
        }],
    };
    let intent = save_record(&root, &record, None).unwrap();
    record.committed = true;
    let marker = save_record(&root, &record, Some(&intent)).unwrap();
    restore_rollback_intent(&root, &intent, &record).unwrap();
    assert_eq!(fs::read(root.join(RECORD)).unwrap(), intent);
    // Already intent: nothing to rewrite.
    restore_rollback_intent(&root, &intent, &record).unwrap();
    assert!(save_record(&root, &record, Some(&marker)).is_err());
    fs::remove_dir_all(root).unwrap();
}
