//! Filter indexable paths and coalesce survivors into one native watch message per debounce window.
//! Keep unclassifiable paths for frontend validation; maintain scan/watch predicate parity.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_full::notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::ipc::Channel;

/// Debounce window. Matches the `delayMs: 120` the plugin watch path used, so
/// external edits still surface within the same latency envelope.
const WATCH_DEBOUNCE_MS: u64 = 120;

/// Directory names never watched-through, mirroring `vaultscan::walk` and
/// `SKIPPED_DIRS` in `src/lib/vault.ts`. Dot-prefixed names (including `.git`)
/// are already excluded by the leading-dot rule below.
const SKIPPED_DIRS: [&str; 1] = ["node_modules"];

/// One coalesced, pre-filtered batch item. Serializes to the exact shape of
/// `VaultWatchEvent` in `src/lib/vault.ts` (`{ paths, kind }`), so the frontend
/// consumer needs no change. Paths are absolute, as the plugin path delivered
/// them.
#[derive(Clone, Serialize)]
pub struct WatchEvent {
    pub paths: Vec<String>,
    pub kind: &'static str,
}

/// Match frontend isIndexableVaultRelPath and native scan rules; never drop an indexable path.
fn is_indexable_rel(rel: &str) -> bool {
    if rel.is_empty() {
        return false;
    }
    for seg in rel.split('/') {
        if seg.is_empty() || seg.starts_with('.') || SKIPPED_DIRS.contains(&seg) {
            return false;
        }
    }
    true
}

/// Map a notify `EventKind` onto the coarse kind `handleExternalChange`
/// switches on. Matches `kindFromEvent` in `src/lib/vault.ts`: create/remove
/// are explicit, everything ambiguous (Modify/Access/Any/Other) is "modify".
fn coarse_kind(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Remove(_) => "remove",
        _ => "modify",
    }
}

/// Map an absolute path under root to forward-slashed relative form.
/// Keep unclassifiable paths for frontend validation.
fn rel_under_root(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    let mut out = String::new();
    for comp in rel.components() {
        let part = comp.as_os_str().to_string_lossy();
        if part.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(&part);
    }
    if out.is_empty() {
        // The root itself changed — nothing indexable to report.
        return None;
    }
    Some(out)
}

/// Filter and coalesce one debounce window. Drop events with no surviving paths;
/// retain paths that cannot be classified under the root.
fn build_batch(root: &Path, events: &[(EventKind, Vec<PathBuf>)]) -> Vec<WatchEvent> {
    let mut batch: Vec<WatchEvent> = Vec::new();
    for (kind, paths) in events {
        let mut kept: Vec<String> = Vec::new();
        for abs in paths {
            match rel_under_root(root, abs) {
                Some(rel) => {
                    if is_indexable_rel(&rel) {
                        kept.push(abs.to_string_lossy().to_string());
                    }
                }
                None => kept.push(abs.to_string_lossy().to_string()),
            }
        }
        if !kept.is_empty() {
            batch.push(WatchEvent {
                paths: kept,
                kind: coarse_kind(kind),
            });
        }
    }
    batch
}

type FsDebouncer = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Live watchers, keyed by the id `vault_watch` returns. Dropping a debouncer
/// stops its watch and joins its thread, so `vault_unwatch` is just a `remove`.
#[derive(Default)]
pub struct WatchState {
    inner: Mutex<HashMap<u32, FsDebouncer>>,
    next: AtomicU32,
}

/// Start watching `root` recursively. Returns an id for `vault_unwatch`.
///
/// The debouncer callback runs on notify's own thread (never the UI thread);
/// it filters + coalesces in Rust and does at most one `Channel::send` per
/// debounce window.
#[tauri::command]
pub fn vault_watch(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatchState>,
    root: String,
    on_event: Channel<Vec<WatchEvent>>,
) -> Result<u32, String> {
    let root_path = crate::vaultscope::require_approved(&app, &root)?;
    let root_for_cb = root_path.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(WATCH_DEBOUNCE_MS),
        None,
        move |result: notify_debouncer_full::DebounceEventResult| {
            let events = match result {
                Ok(events) => events,
                // A watch error (e.g. a transient rescan on Windows) must not
                // tear the watcher down; the next window recovers. The plugin
                // path also swallowed these.
                Err(_) => return,
            };
            let tuples: Vec<(EventKind, Vec<PathBuf>)> = events
                .into_iter()
                .map(|ev| (ev.event.kind, ev.event.paths))
                .collect();
            let batch = build_batch(&root_for_cb, &tuples);
            if !batch.is_empty() {
                // The single bridge crossing per window. On Windows this is one
                // UI-thread eval instead of `tuples.len()` of them.
                let _ = on_event.send(batch);
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let id = state.next.fetch_add(1, Ordering::Relaxed);
    state
        .inner
        .lock()
        .map_err(|_| "watch registry poisoned".to_string())?
        .insert(id, debouncer);
    Ok(id)
}

/// Stop a watcher started by `vault_watch`. Idempotent: an unknown id is a
/// no-op, so a double-unwatch (e.g. React strict-mode remount) is harmless.
#[tauri::command]
pub fn vault_unwatch(state: tauri::State<'_, WatchState>, id: u32) {
    if let Ok(mut map) = state.inner.lock() {
        map.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify_debouncer_full::notify::event::{AccessKind, CreateKind, ModifyKind, RemoveKind};

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
        let batch = build_batch(&root, &events);
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
        let batch = build_batch(&root, &events);
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
        let batch = build_batch(&root, &events);
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].kind, "modify");
        assert_eq!(
            batch[0].paths,
            vec![
                "/vault/notes/keep.md".to_string(),
                "/somewhere/else.md".to_string(),
            ]
        );
    }
}
