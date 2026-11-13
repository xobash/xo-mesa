use super::*;

#[test]
fn watchers_belong_to_their_window() {
    let registry = Registry::default();
    let main = registry.insert("main", 1).unwrap();
    let doc = registry.insert("doc-1", 2).unwrap();
    let doc_again = registry.insert("doc-1", 3).unwrap();
    assert!(registry.remove(main, "doc-1").is_err());
    assert_eq!(registry.remove(main, "main").unwrap(), Some(1));
    assert_eq!(registry.remove(main, "main").unwrap(), None);
    let mut destroyed = registry.remove_owner("doc-1");
    destroyed.sort();
    assert_eq!(destroyed, vec![2, 3]);
    assert_eq!(registry.remove(doc, "doc-1").unwrap(), None);
    assert_eq!(registry.remove(doc_again, "doc-1").unwrap(), None);
}
use notify_debouncer_full::notify::event::{AccessKind, CreateKind, ModifyKind, RemoveKind};

/// A rename must still report the old and the new path without the
/// file-id cache; the frontend removes the first and registers the second.
#[test]
fn rename_reports_both_paths_without_a_file_id_cache() {
    let dir = std::env::temp_dir().join(format!(
        "mesa-watch-rename-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let root = std::fs::canonicalize(&dir).unwrap();
    std::fs::write(root.join("old.md"), b"note").unwrap();
    // Let the creation leave the event stream before the watch starts.
    std::thread::sleep(Duration::from_millis(300));

    let (tx, rx) = std::sync::mpsc::channel::<Vec<PathBuf>>();
    let debouncer = start_debouncer(
        &root,
        move |result: notify_debouncer_full::DebounceEventResult| {
            if let Ok(events) = result {
                let _ = tx.send(events.into_iter().flat_map(|ev| ev.event.paths).collect());
            }
        },
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(200));
    std::fs::rename(root.join("old.md"), root.join("new.md")).unwrap();

    let mut seen: Vec<PathBuf> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    let has = |seen: &[PathBuf], name: &str| seen.iter().any(|p| p.ends_with(name));
    while Instant::now() < deadline && !(has(&seen, "old.md") && has(&seen, "new.md")) {
        if let Ok(paths) = rx.recv_timeout(Duration::from_millis(250)) {
            seen.extend(paths);
        }
    }
    drop(debouncer);
    let _ = std::fs::remove_dir_all(&root);
    assert!(has(&seen, "old.md"), "old path missing: {seen:?}");
    assert!(has(&seen, "new.md"), "new path missing: {seen:?}");
}

fn p(s: &str) -> PathBuf {
    PathBuf::from(s)
}

#[test]
fn is_indexable_matches_the_frontend_predicate() {
    // Kept — ordinary vault content.
    assert!(is_indexable_rel("a.md"));
    assert!(is_indexable_rel("notes/deep/a.pdf"));
    assert!(is_indexable_rel("Web Archives/x.md"));
    // Dropped — dot-entry at any depth (covers all of `.git/**`).
    assert!(!is_indexable_rel(".git"));
    assert!(!is_indexable_rel(".git/index"));
    assert!(!is_indexable_rel(".git/objects/ab/cdef"));
    assert!(!is_indexable_rel("notes/.hidden/x.md"));
    assert!(!is_indexable_rel(".obsidian/workspace.json"));
    // Dropped — Mesa's own dot-prefixed write artifacts.
    assert!(!is_indexable_rel(".note.md.mesa-save-1712-ab.tmp"));
    // Dropped — node_modules at any depth, empty, empty segment.
    assert!(!is_indexable_rel("node_modules/x"));
    assert!(!is_indexable_rel("a/node_modules/b"));
    assert!(!is_indexable_rel(""));
    assert!(!is_indexable_rel("a//b"));
    // Dropped — deeper than the scan follows.
    let at_cap = vec!["d"; crate::vault_names::MAX_REL_SEGMENTS - 1].join("/");
    assert!(is_indexable_rel(&format!("{at_cap}/a.md")));
    assert!(!is_indexable_rel(&format!("{at_cap}/e/a.md")));
}

#[test]
fn coarse_kind_matches_kind_from_event() {
    assert_eq!(coarse_kind(&EventKind::Create(CreateKind::File)), "create");
    assert_eq!(coarse_kind(&EventKind::Remove(RemoveKind::File)), "remove");
    assert_eq!(coarse_kind(&EventKind::Modify(ModifyKind::Any)), "modify");
    assert_eq!(coarse_kind(&EventKind::Access(AccessKind::Any)), "modify");
    assert_eq!(coarse_kind(&EventKind::Any), "modify");
    assert_eq!(coarse_kind(&EventKind::Other), "modify");
}

#[test]
fn read_only_access_never_reaches_the_frontend() {
    let root = p("/vault");
    let read = |kind| (kind, vec![p("/vault/a.md")]);
    let opens = [
        read(EventKind::Access(AccessKind::Open(AccessMode::Any))),
        read(EventKind::Access(AccessKind::Read)),
        read(EventKind::Access(AccessKind::Close(AccessMode::Read))),
        read(EventKind::Access(AccessKind::Close(AccessMode::Execute))),
    ];
    assert!(build_batch(&root, &opens, false).is_empty());
    for kind in [
        EventKind::Access(AccessKind::Close(AccessMode::Write)),
        EventKind::Access(AccessKind::Close(AccessMode::Any)),
        EventKind::Access(AccessKind::Any),
        EventKind::Access(AccessKind::Other),
    ] {
        let batch = build_batch(&root, &[read(kind)], false);
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].kind, "modify");
        assert_eq!(batch[0].paths, vec!["./a.md".to_string()]);
    }
    // A pathless access event still means lost events.
    let lost = [(EventKind::Access(AccessKind::Open(AccessMode::Any)), vec![])];
    assert_eq!(build_batch(&root, &lost, false)[0].kind, RESCAN_KIND);
}

#[test]
fn rel_under_root_resolves_inside_and_keeps_outside() {
    let root = p("/vault");
    assert_eq!(
        rel_under_root(&root, &p("/vault/notes/a.md")).as_deref(),
        Some("notes/a.md")
    );
    // The root itself is not a reportable indexable path.
    assert_eq!(rel_under_root(&root, &p("/vault")), None);
    // Outside the root → None → caller KEEPS it (never a silent drop).
    assert_eq!(rel_under_root(&root, &p("/elsewhere/a.md")), None);
}

/// The core guarantee: a git-checkout-shaped window collapses to ONE send
/// while every real note survives. This is the transferable evidence — the
/// reduction is set by the workload's distinct paths, not by the OS notify
/// backend.
#[test]
fn git_storm_collapses_to_one_send_without_losing_real_edits() {
    let root = p("/vault");
    let mut events: Vec<(EventKind, Vec<PathBuf>)> = Vec::new();

    // 300 real note writes.
    for i in 0..300 {
        events.push((
            EventKind::Modify(ModifyKind::Any),
            vec![p(&format!("/vault/notes/n{i}.md"))],
        ));
    }
    // 3000 `.git/` churn events (loose objects, refs, index, logs).
    for i in 0..3000 {
        events.push((
            EventKind::Create(CreateKind::File),
            vec![p(&format!("/vault/.git/objects/{:02x}/{i}", i % 256))],
        ));
    }
    events.push((
        EventKind::Modify(ModifyKind::Any),
        vec![p("/vault/.git/index")],
    ));

    let plugin_sends = events.len(); // one per event on the plugin path
    let batch = build_batch(&root, &events, false);
    let native_sends = usize::from(!batch.is_empty()); // one per window, if non-empty

    assert_eq!(plugin_sends, 3301);
    assert_eq!(native_sends, 1, "one bridge crossing per window");

    // Every surviving path is a real, indexable note — zero `.git`/dot.
    let mut survivors = 0;
    for ev in &batch {
        for abs in &ev.paths {
            assert!(!abs.contains("/.git/"), "leaked a .git path: {abs}");
            survivors += 1;
        }
    }
    assert_eq!(survivors, 300, "all real edits preserved, nothing else");
}

/// A pure `.git/` storm (a `git gc`, a big fetch) must cross the bridge
/// ZERO times — today it is thousands of UI-thread evals.
#[test]
fn pure_git_storm_produces_no_sends() {
    let root = p("/vault");
    let events: Vec<(EventKind, Vec<PathBuf>)> = (0..5000)
        .map(|i| {
            (
                EventKind::Create(CreateKind::File),
                vec![p(&format!("/vault/.git/objects/pack/tmp_{i}"))],
            )
        })
        .collect();
    let batch = build_batch(&root, &events, false);
    assert!(batch.is_empty(), "a .git-only window must send nothing");
}

/// A rename that moves a file OUT of the vault arrives as a two-path event;
/// the in-vault path is kept, an unresolvable one is kept too (never a
/// silent drop), and a `.git` path in the same event is dropped.
#[test]
fn mixed_event_keeps_survivors_only() {
    let root = p("/vault");
    let events = vec![(
        EventKind::Modify(ModifyKind::Any),
        vec![
            p("/vault/notes/keep.md"),
            p("/vault/.git/index"),
            p("/somewhere/else.md"),
        ],
    )];
    let batch = build_batch(&root, &events, false);
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0].kind, "modify");
    assert_eq!(
        batch[0].paths,
        vec![
            "./notes/keep.md".to_string(),
            "/somewhere/else.md".to_string(),
        ]
    );
}

/// Paths under the root reach the renderer vault-relative, so the
/// renderer never compares them with its own spelling of the root.
#[test]
fn paths_under_the_root_are_emitted_vault_relative() {
    let root = p("/vault");
    let mut paths = vec![p("/vault/Ünïcødé dir/Café.md"), p("/vault/a b/c.md")];
    let mut expected = vec!["./Ünïcødé dir/Café.md", "./a b/c.md"];
    // A Unix folder may be named like a drive; on Windows `C:` is a prefix.
    if cfg!(unix) {
        paths.push(p("/vault/C:/d.md"));
        expected.push("./C:/d.md");
    }
    let events = vec![(EventKind::Create(CreateKind::File), paths)];
    let batch = build_batch(&root, &events, false);
    assert_eq!(batch[0].paths, expected);
}

/// Windows reports event paths under the verbatim canonical root.
#[cfg(windows)]
#[test]
fn windows_verbatim_event_paths_never_reach_the_renderer() {
    let root = p(r"\\?\C:\Vault");
    let events = vec![(
        EventKind::Create(CreateKind::File),
        vec![p(r"\\?\C:\Vault\notes\a.md"), p(r"\\?\C:\Elsewhere\b.md")],
    )];
    let batch = build_batch(&root, &events, true);
    assert_eq!(batch[0].paths, [r"C:\Vault"]);
    assert_eq!(batch[1].paths, ["./notes/a.md", r"C:\Elsewhere\b.md"]);
}

/// An inotify overflow arrives as a pathless `Other` event flagged Rescan.
/// It must become one leading root-level rescan entry, never a dropped
/// window; surviving paths in the same window are still reported.
#[test]
fn overflow_and_pathless_events_request_one_rescan() {
    let root = p("/vault");
    let overflow = vec![
        (EventKind::Other, Vec::new()),
        (EventKind::Modify(ModifyKind::Any), vec![p("/vault/a.md")]),
        (EventKind::Other, Vec::new()),
    ];
    let batch = build_batch(&root, &overflow, true);
    assert_eq!(batch.len(), 2);
    assert_eq!(batch[0].kind, "rescan");
    assert_eq!(batch[0].paths, vec!["/vault".to_string()]);
    assert_eq!(batch[1].paths, vec!["./a.md".to_string()]);

    // A pathless event alone still asks for a rescan without the flag.
    let pathless = vec![(EventKind::Other, Vec::new())];
    let batch = build_batch(&root, &pathless, false);
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0].kind, "rescan");

    // A flagged window of `.git` churn still asks for a rescan.
    let git = vec![(
        EventKind::Create(CreateKind::File),
        vec![p("/vault/.git/index")],
    )];
    let batch = build_batch(&root, &git, true);
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0].kind, "rescan");
}

/// A watcher that errors on every window asks for at most one rescan per
/// interval, and asks again once the interval has passed.
#[test]
fn repeated_watch_errors_rescan_at_most_once_per_interval() {
    let mut gate = ErrorRescanGate::default();
    let start = Instant::now();
    assert!(gate.admit(start));
    assert!(!gate.admit(start + Duration::from_millis(120)));
    assert!(!gate.admit(start + ERROR_RESCAN_INTERVAL - Duration::from_millis(1)));
    assert!(gate.admit(start + ERROR_RESCAN_INTERVAL));
    assert!(!gate.admit(start + ERROR_RESCAN_INTERVAL + Duration::from_secs(1)));
}
