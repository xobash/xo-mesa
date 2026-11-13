//! Filter indexable paths and coalesce survivors into one native watch message per debounce window.
//! Keep unclassifiable paths for frontend validation; maintain scan/watch predicate parity.
//! Overflow, pathless events and watcher errors become one root-level `rescan` entry.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify_debouncer_full::notify;
use notify_debouncer_full::notify::event::{AccessKind, AccessMode};
use notify_debouncer_full::notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventHandler, Debouncer, NoCache};
use serde::Serialize;
use tauri::ipc::Channel;

/// Debounce window. Matches the `delayMs: 120` the plugin watch path used, so
/// external edits still surface within the same latency envelope.
const WATCH_DEBOUNCE_MS: u64 = 120;

/// One coalesced, pre-filtered batch item. Serializes to the shape of
/// `VaultWatchEvent` in `src/lib/vault.ts` (`{ paths, kind }`). A path under
/// the watched root is vault-relative with `/` separators and a leading
/// `./`, so the frontend
/// never has to match the OS spelling of the root (Windows reports
/// `\\?\C:\…` under a canonical root). A path that cannot be placed under
/// the root, and the rescan entry's root, stay absolute without a verbatim
/// prefix.
#[derive(Clone, Serialize)]
pub struct WatchEvent {
    pub paths: Vec<String>,
    pub kind: &'static str,
}

/// Match frontend isIndexableVaultRelPath and native scan rules; never drop an indexable path.
fn is_indexable_rel(rel: &str) -> bool {
    if rel.is_empty() || crate::vault_names::rel_too_deep(rel) {
        return false;
    }
    for seg in rel.split('/') {
        if seg.is_empty() || crate::vault_names::is_hidden_name(seg) {
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

/// Opens and read-only closes change no bytes. Linux inotify reports them for
/// every reader, Mesa's own watcher reads included, so passing them on as
/// "modify" re-reads each file and feeds the next window indefinitely.
/// `Close(Write)` and ambiguous access kinds stay "modify".
fn is_read_only_access(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Access(
            AccessKind::Open(_)
                | AccessKind::Read
                | AccessKind::Close(AccessMode::Read | AccessMode::Execute)
        )
    )
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

/// Absolute path text for the renderer, without a Windows verbatim prefix.
fn emitted_absolute(path: &Path) -> String {
    crate::vaultscope::plain_path(path)
        .to_string_lossy()
        .into_owned()
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
        paths: vec![emitted_absolute(root)],
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
        if is_read_only_access(kind) {
            continue;
        }
        let mut kept: Vec<String> = Vec::new();
        for abs in paths {
            match rel_under_root(root, abs) {
                Some(rel) => {
                    if is_indexable_rel(&rel) {
                        // `./` keeps a first segment such as `C:` (legal on
                        // Unix) from reading as a drive-absolute path.
                        kept.push(format!("./{rel}"));
                    }
                }
                None => kept.push(emitted_absolute(abs)),
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

/// No file-id cache on any OS. The cache walks the whole tree at watch start
/// (hidden folders and symlink targets included), keeps one entry per file and
/// rescans its map on every remove. It only joins the two halves of a rename
/// into one event, and Mesa handles each path of an event on its own.
type FsDebouncer = Debouncer<RecommendedWatcher, NoCache>;

fn start_debouncer<F: DebounceEventHandler>(
    root: &Path,
    handler: F,
) -> Result<FsDebouncer, String> {
    let mut debouncer = new_debouncer_opt::<F, RecommendedWatcher, NoCache>(
        Duration::from_millis(WATCH_DEBOUNCE_MS),
        None,
        handler,
        NoCache::new(),
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;
    debouncer
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    Ok(debouncer)
}

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
    let debouncer = start_debouncer(
        &root_path,
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
    )?;

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
#[path = "vaultwatch_tests.rs"]
mod tests;
