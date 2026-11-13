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
    save_record(&root, &record, true).unwrap();
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
