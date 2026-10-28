//! Filter indexable paths and coalesce survivors into one native watch message per debounce window.
//! Keep unclassifiable paths for frontend validation; maintain scan/watch predicate parity.
//! Overflow, pathless events and watcher errors become one root-level `rescan` entry.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

/// Kind of the root-level entry that asks the frontend for one full rescan.
const RESCAN_KIND: &str = "rescan";

/// Minimum spacing of error-driven rescans. A watcher that fails on every
/// window must not turn into back-to-back full vault scans.
const ERROR_RESCAN_INTERVAL: Duration = Duration::from_secs(5);

/// Admits at most one error-driven rescan per `ERROR_RESCAN_INTERVAL`.
#[derive(Default)]
struct ErrorRescanGate {
    last: Option<Instant>,
}

impl ErrorRescanGate {
    fn admit(&mut self, now: Instant) -> bool {
        match self.last {
            Some(last) if now.saturating_duration_since(last) < ERROR_RESCAN_INTERVAL => false,
            _ => {
                self.last = Some(now);
                true
            }
        }
    }
}

/// One root-level rescan entry: events may have been lost (queue overflow or a
/// watcher error), so no path list can be trusted as complete.
fn rescan_entry(root: &Path) -> WatchEvent {
    WatchEvent {
        paths: vec![root.to_string_lossy().to_string()],
        kind: RESCAN_KIND,
    }
}

/// Filter and coalesce one debounce window. Drop events with no surviving paths;
/// retain paths that cannot be classified under the root. A window with a
/// rescan-flagged or pathless event starts with one rescan entry.
fn build_batch(
    root: &Path,
    events: &[(EventKind, Vec<PathBuf>)],
    needs_rescan: bool,
) -> Vec<WatchEvent> {
    let mut batch: Vec<WatchEvent> = Vec::new();
    if needs_rescan || events.iter().any(|(_, paths)| paths.is_empty()) {
        batch.push(rescan_entry(root));
    }
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

/// Live watchers, keyed by the id `vault_watch` returns and owned by the
/// window that started them. Dropping a debouncer stops its watch and joins
/// its thread, so removal is a `remove` followed by a drop outside the lock.
#[derive(Default)]
pub struct WatchState {
    inner: Registry<FsDebouncer>,
}

struct Registry<T> {
    entries: Mutex<HashMap<u32, (String, T)>>,
    next: AtomicU32,
}

impl<T> Default for Registry<T> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            next: AtomicU32::new(0),
        }
    }
}

impl<T> Registry<T> {
    fn insert(&self, owner: &str, value: T) -> Result<u32, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.entries
            .lock()
            .map_err(|_| "watch registry poisoned".to_string())?
            .insert(id, (owner.to_string(), value));
        Ok(id)
    }

    /// Unknown ids are a no-op; another window's watcher is refused.
    fn remove(&self, id: u32, owner: &str) -> Result<Option<T>, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "watch registry poisoned".to_string())?;
        match entries.get(&id) {
            None => Ok(None),
            Some((label, _)) if label != owner => {
                Err("vault watcher belongs to another window".into())
            }
            Some(_) => Ok(entries.remove(&id).map(|(_, value)| value)),
        }
    }

    fn remove_owner(&self, owner: &str) -> Vec<T> {
        let Ok(mut entries) = self.entries.lock() else {
            return Vec::new();
        };
        let ids: Vec<u32> = entries
            .iter()
            .filter(|(_, (label, _))| label == owner)
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter()
            .filter_map(|id| entries.remove(&id).map(|(_, value)| value))
            .collect()
    }
}

/// Stop every watcher a destroyed window started.
pub fn revoke_window(state: &WatchState, label: &str) {
    let removed = state.inner.remove_owner(label);
    drop(removed);
}

/// Start watching `root` recursively. Returns an id for `vault_unwatch`.
///
/// The debouncer callback runs on notify's own thread (never the UI thread);
/// it filters + coalesces in Rust and does at most one `Channel::send` per
/// debounce window.
// Blocking work: run off the main (UI) thread.
#[tauri::command(async)]
pub fn vault_watch(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, WatchState>,
    root: String,
    on_event: Channel<Vec<WatchEvent>>,
) -> Result<u32, String> {
    let root_path = crate::vaultscope::require_approved(&app, &root)?;
    let root_for_cb = root_path.clone();
    let mut error_gate = ErrorRescanGate::default();
    let mut debouncer = new_debouncer(
        Duration::from_millis(WATCH_DEBOUNCE_MS),
        None,
        move |result: notify_debouncer_full::DebounceEventResult| {
            let events = match result {
                Ok(events) => events,
                // A watch error keeps the watcher alive, but events may have
                // been lost: ask the frontend for one full rescan, rate-limited.
                Err(_) => {
                    if error_gate.admit(Instant::now()) {
                        let _ = on_event.send(vec![rescan_entry(&root_for_cb)]);
                    }
                    return;
                }
            };
            let needs_rescan = events.iter().any(|ev| ev.event.need_rescan());
            let tuples: Vec<(EventKind, Vec<PathBuf>)> = events
                .into_iter()
                .map(|ev| (ev.event.kind, ev.event.paths))
                .collect();
            let batch = build_batch(&root_for_cb, &tuples, needs_rescan);
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

    state.inner.insert(window.label(), debouncer)
}

/// Stop a watcher started by `vault_watch` in the same window. Idempotent: an
/// unknown id is a no-op, so a double-unwatch (e.g. React strict-mode remount)
/// is harmless.
#[tauri::command(async)]
pub fn vault_unwatch(
    window: tauri::Window,
    state: tauri::State<'_, WatchState>,
    id: u32,
) -> Result<(), String> {
    let removed = state.inner.remove(id, window.label())?;
    drop(removed);
    Ok(())
}

#[cfg(test)]
mod tests {
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
                "/vault/notes/keep.md".to_string(),
                "/somewhere/else.md".to_string(),
            ]
        );
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
        assert_eq!(batch[1].paths, vec!["/vault/a.md".to_string()]);

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
}
