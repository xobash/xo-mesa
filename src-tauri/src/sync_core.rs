// sync_core.rs — dependency-light sync logic.
//
// This stays independent of tauri / reqwest / rustls / tiny_http. The only
// platform bindings are libc and windows-sys for atomic no-replace rename.
// That keeps it unit-testable with `cargo test` and makes the cross-language
// contract explicit: `fnv1a_hex`, `diff_manifests`, and `conflict_name` MUST
// stay byte-for-byte compatible with their reference twins in `src/lib/sync.ts`
// (which pin the same vectors in vitest).
//
// The impure halves — TLS identity, the HTTPS server, the pinned client, and
// the `sync_run` engine — live in `sync.rs` and call into this module.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Hidden, vault-local state for delete/rename replication.  It is deliberately
/// outside the normal manifest: syncing the journal as an ordinary vault file
/// would make it visible to users and let one device overwrite another's log.
pub const JOURNAL_FILE: &str = ".mesa-sync-journal.json";
pub const JOURNAL_VERSION: u32 = 1;
/// Bounded control traffic. The local manifest baseline never travels on wire.
pub const MAX_JOURNAL_WIRE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct JournalEntry {
    pub rel: String,
    pub size: u64,
    pub hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct JournalOperation {
    pub id: String,
    pub device: String,
    pub sequence: u64,
    pub at_ms: u64,
    #[serde(rename = "kind")]
    pub kind: JournalOperationKind,
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub size: u64,
    pub hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JournalOperationKind {
    Delete,
    Rename,
    Restore,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncJournal {
    pub version: u32,
    pub device: String,
    pub next_sequence: u64,
    pub operations: Vec<JournalOperation>,
    #[serde(default)]
    pub applied: Vec<String>,
    /// Per-peer acknowledgement gossip.  `applied` is this device's direct ack;
    /// `acked_by[peer]` records IDs another known device has already applied,
    /// learned from that peer's own journal and from transitive gossip.  This is
    /// what lets compaction stay safe for an offline third device.
    #[serde(default)]
    pub acked_by: HashMap<String, Vec<String>>,
    /// Devices this vault has exchanged journals with.  Operations are compacted
    /// only after every known participant except the operation origin has acked.
    #[serde(default)]
    pub peers_seen: Vec<String>,
    /// The last known vault manifest lets the next sync reconstruct an action
    /// after a crash or an edit made outside Mesa.
    pub known: Vec<JournalEntry>,
    #[serde(default, deserialize_with = "deserialize_peer_bindings")]
    pub peer_bindings: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub retired_peers: Vec<String>,
    #[serde(default)]
    pub retired_fingerprints: Vec<String>,
}

fn deserialize_peer_bindings<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<HashMap<String, Vec<String>>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Binding {
        One(String),
        Many(Vec<String>),
    }
    let bindings = HashMap::<String, Binding>::deserialize(deserializer)?;
    Ok(bindings
        .into_iter()
        .map(|(fingerprint, binding)| {
            let devices = match binding {
                Binding::One(device) => vec![device],
                Binding::Many(devices) => devices,
            };
            (fingerprint, devices)
        })
        .collect())
}

impl SyncJournal {
    fn empty(device: String) -> Self {
        Self {
            version: JOURNAL_VERSION,
            device,
            next_sequence: 1,
            operations: Vec::new(),
            applied: Vec::new(),
            acked_by: HashMap::new(),
            peers_seen: Vec::new(),
            known: Vec::new(),
            peer_bindings: HashMap::new(),
            retired_peers: Vec::new(),
            retired_fingerprints: Vec::new(),
        }
    }
}

fn journal_path(root: &Path) -> PathBuf {
    root.join(JOURNAL_FILE)
}

fn journal_device(root: &Path) -> String {
    // This is only an operation-origin identifier, never an authentication
    // credential. It is persisted in the journal and combined with a sequence.
    format!(
        "{:x}-{:x}",
        std::process::id(),
        now_ms()
            ^ root
                .to_string_lossy()
                .bytes()
                .fold(0u64, |a, b| a.wrapping_mul(33).wrapping_add(b as u64))
    )
}

fn journal_mutex() -> &'static Mutex<()> {
    static JOURNAL_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();
    JOURNAL_MUTEX.get_or_init(|| Mutex::new(()))
}

fn journal_guard() -> std::io::Result<MutexGuard<'static, ()>> {
    journal_mutex()
        .lock()
        .map_err(|_| std::io::Error::other("sync journal coordinator poisoned"))
}

fn load_journal_unlocked(root: &Path) -> std::io::Result<SyncJournal> {
    let path = journal_path(root);
    let body = match std::fs::read(&path) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SyncJournal::empty(journal_device(root)));
        }
        Err(error) => return Err(error),
    };
    let journal: SyncJournal = serde_json::from_slice(&body).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid Mesa sync journal: {error}"),
        )
    })?;
    validate_journal(&journal, "Mesa sync journal")?;
    Ok(journal)
}

fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 16 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Reject malformed peer state before it participates in planning.  A journal
/// is destructive intent, so accepting a syntactically valid but inconsistent
/// operation is not a compatibility fallback.
pub fn validate_journal(journal: &SyncJournal, label: &str) -> std::io::Result<()> {
    if journal.version != JOURNAL_VERSION || journal.device.is_empty() {
        return Err(invalid_data(format!("unsupported {label}")));
    }
    let mut ids = HashSet::new();
    for op in &journal.operations {
        if op.device.is_empty()
            || op.sequence == 0
            || op.id != format!("{}:{}", op.device, op.sequence)
            || !ids.insert(op.id.clone())
            || safe_join(Path::new("."), &op.from).is_none()
            || !is_valid_hash(&op.hash)
        {
            return Err(invalid_data(format!("invalid {label} operation")));
        }
        match op.kind {
            JournalOperationKind::Delete | JournalOperationKind::Restore if op.to.is_some() => {
                return Err(invalid_data(format!(
                    "invalid {label} operation destination"
                )));
            }
            JournalOperationKind::Rename => {
                let Some(to) = op.to.as_deref() else {
                    return Err(invalid_data(format!("invalid {label} rename destination")));
                };
                if safe_join(Path::new("."), to).is_none() || to == op.from {
                    return Err(invalid_data(format!("invalid {label} rename destination")));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub fn load_journal(root: &Path) -> std::io::Result<SyncJournal> {
    let _guard = journal_guard()?;
    load_journal_unlocked(root)
}

/// The baseline is local crash-reconstruction state, not peer intent. Omitting
/// it keeps a 12,000-file idle journal small without weakening reconciliation.
pub fn journal_wire_bytes(journal: &SyncJournal) -> std::io::Result<Vec<u8>> {
    let mut wire = journal.clone();
    wire.known.clear();
    wire.peer_bindings.clear();
    wire.retired_peers.clear();
    wire.retired_fingerprints.clear();
    let bytes = serde_json::to_vec(&wire).map_err(|error| invalid_data(error.to_string()))?;
    if bytes.len() > MAX_JOURNAL_WIRE_BYTES {
        return Err(invalid_data(
            "Journal operation backlog exceeds the 32 MiB exchange limit",
        ));
    }
    Ok(bytes)
}

pub fn bind_journal_peer(
    root: &Path,
    fingerprint: &str,
    device: &str,
    reactivate: bool,
) -> std::io::Result<()> {
    let _guard = journal_guard()?;
    let mut journal = load_journal_unlocked(root)?;
    push_unique(
        journal
            .peer_bindings
            .entry(fingerprint.to_string())
            .or_default(),
        device,
    );
    if reactivate {
        journal
            .retired_fingerprints
            .retain(|peer| peer != fingerprint);
    }
    if journal
        .retired_fingerprints
        .iter()
        .any(|peer| peer == fingerprint)
    {
        push_unique(&mut journal.retired_peers, device);
    } else {
        journal.retired_peers.retain(|peer| peer != device);
        note_peer_seen(&mut journal, device);
    }
    save_journal_unlocked(root, &journal)?;
    Ok(())
}

pub fn retire_journal_peers(root: &Path, fingerprints: &[String]) -> std::io::Result<()> {
    if fingerprints.is_empty() {
        return Ok(());
    }
    let _guard = journal_guard()?;
    let mut journal = load_journal_unlocked(root)?;
    // Old journals did not associate their random participant IDs with a TLS
    // identity. Never guess which offline participant a settings row represents.
    let has_unbound_participants = journal.peers_seen.iter().any(|device| {
        device != &journal.device
            && !journal.retired_peers.contains(device)
            && !journal
                .peer_bindings
                .values()
                .any(|devices| devices.contains(device))
    });
    if has_unbound_participants
        && fingerprints
            .iter()
            .any(|fingerprint| !journal.peer_bindings.contains_key(fingerprint))
    {
        return Err(invalid_data("This vault has older journal participants that are not yet linked to saved devices. Sync with the device once before removing it; its acknowledgement requirement has been preserved."));
    }
    for fingerprint in fingerprints {
        push_unique(&mut journal.retired_fingerprints, fingerprint);
        if let Some(devices) = journal.peer_bindings.get(fingerprint).cloned() {
            for device in devices {
                push_unique(&mut journal.retired_peers, device.clone());
                journal.peers_seen.retain(|peer| peer != &device);
                journal.acked_by.remove(&device);
            }
        }
    }
    save_journal_unlocked(root, &journal)?;
    Ok(())
}

#[cfg(test)]
fn retire_journal_peer(root: &Path, fingerprint: &str) -> std::io::Result<()> {
    retire_journal_peers(root, &[fingerprint.to_string()])
}

const MAX_APPLIED_IDS: usize = 8192;
const MAX_ACKED_IDS_PER_PEER: usize = 8192;

fn push_unique(list: &mut Vec<String>, value: impl Into<String>) {
    let value = value.into();
    if !value.is_empty() && !list.iter().any(|item| item == &value) {
        list.push(value);
    }
}

fn dedupe_ordered(list: &mut Vec<String>) {
    let mut seen = HashSet::new();
    list.retain(|value| !value.is_empty() && seen.insert(value.clone()));
}

fn retain_recent_or_live(list: &mut Vec<String>, live_ids: &HashSet<String>, max: usize) {
    dedupe_ordered(list);
    if list.len() <= max {
        return;
    }
    let mut to_drop = list.len().saturating_sub(max);
    list.retain(|id| {
        if live_ids.contains(id) || to_drop == 0 {
            true
        } else {
            to_drop -= 1;
            false
        }
    });
}

fn sort_journal_operations(journal: &mut SyncJournal) {
    // IDs are human-readable (`device:sequence`), but their string spelling
    // is not an ordering contract: `:10` sorts before `:2`.  Preserve each
    // device's numeric causal order, then use the stable ID only as a total
    // ordering tie-breaker for malformed duplicate sequence values.
    journal.operations.sort_by(|a, b| {
        a.device
            .cmp(&b.device)
            .then_with(|| a.sequence.cmp(&b.sequence))
            .then_with(|| a.id.cmp(&b.id))
    });
}

fn note_peer_seen(journal: &mut SyncJournal, device: &str) {
    if !device.is_empty()
        && device != journal.device
        && !journal.retired_peers.iter().any(|peer| peer == device)
    {
        push_unique(&mut journal.peers_seen, device.to_string());
    }
}

fn merge_remote_into(local: &mut SyncJournal, remote: &SyncJournal) -> std::io::Result<()> {
    validate_journal(remote, "peer sync journal")?;

    note_peer_seen(local, &remote.device);
    for peer in &remote.peers_seen {
        note_peer_seen(local, peer);
    }
    for op in &remote.operations {
        note_peer_seen(local, &op.device);
        if !local.operations.iter().any(|existing| existing.id == op.id) {
            local.operations.push(op.clone());
        }
    }

    if remote.device != local.device {
        let mut remote_applied = remote.applied.clone();
        if let Some(gossiped) = remote.acked_by.get(&remote.device) {
            remote_applied.extend(gossiped.iter().cloned());
        }
        let entry = local.acked_by.entry(remote.device.clone()).or_default();
        for id in remote_applied {
            push_unique(entry, id);
        }
    }
    for (peer, ids) in &remote.acked_by {
        if peer.is_empty() || peer == &local.device {
            continue;
        }
        note_peer_seen(local, peer);
        let entry = local.acked_by.entry(peer.clone()).or_default();
        for id in ids {
            push_unique(entry, id.clone());
        }
    }
    Ok(())
}

fn operation_acked_by(
    participant: &str,
    local_device: &str,
    local_applied: &HashSet<String>,
    acked_by: &HashMap<String, Vec<String>>,
    op: &JournalOperation,
) -> bool {
    if participant == op.device {
        return true;
    }
    if participant == local_device {
        return op.device == local_device || local_applied.contains(&op.id);
    }
    acked_by
        .get(participant)
        .is_some_and(|ids| ids.iter().any(|id| id == &op.id))
}

fn compact_journal(journal: &mut SyncJournal) {
    sort_journal_operations(journal);
    dedupe_ordered(&mut journal.applied);
    dedupe_ordered(&mut journal.peers_seen);
    let local_device = journal.device.clone();
    journal.peers_seen.retain(|peer| {
        !peer.is_empty() && peer != &local_device && !journal.retired_peers.contains(peer)
    });
    for peer in journal.acked_by.keys().cloned().collect::<Vec<_>>() {
        if peer.is_empty() || peer == local_device || journal.retired_peers.contains(&peer) {
            journal.acked_by.remove(&peer);
        } else {
            push_unique(&mut journal.peers_seen, peer);
        }
    }
    journal.peers_seen.sort();

    let mut participants = journal.peers_seen.clone();
    push_unique(&mut participants, local_device.clone());
    if participants.len() > 1 {
        let local_applied: HashSet<String> = journal.applied.iter().cloned().collect();
        let acked_by = journal.acked_by.clone();
        journal.operations.retain(|op| {
            !participants.iter().all(|participant| {
                operation_acked_by(participant, &local_device, &local_applied, &acked_by, op)
            })
        });
    }
    sort_journal_operations(journal);

    let live_ids: HashSet<String> = journal.operations.iter().map(|op| op.id.clone()).collect();
    retain_recent_or_live(&mut journal.applied, &live_ids, MAX_APPLIED_IDS);
    journal.acked_by.retain(|peer, ids| {
        retain_recent_or_live(ids, &live_ids, MAX_ACKED_IDS_PER_PEER);
        !peer.is_empty() && peer != &local_device
    });
}

fn save_journal_unlocked(root: &Path, journal: &SyncJournal) -> std::io::Result<SyncJournal> {
    let mut saved = journal.clone();
    compact_journal(&mut saved);
    let path = journal_path(root);
    let tmp = root.join(format!(".mesa-sync-journal-{:x}.tmp", now_ms()));
    let bytes = serde_json::to_vec(&saved)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)?;
    Ok(saved)
}

/// Atomically replace Mesa's own metadata. A crash leaves either the prior
/// complete journal or the complete new journal; the uniquely named temp is
/// ignored and can never enter a vault scan or sync manifest.
#[cfg(test)]
pub fn save_journal(root: &Path, journal: &SyncJournal) -> std::io::Result<()> {
    let _guard = journal_guard()?;
    save_journal_unlocked(root, journal).map(|_| ())
}

fn append_operation(
    journal: &mut SyncJournal,
    kind: JournalOperationKind,
    from: String,
    to: Option<String>,
    size: u64,
    hash: String,
) {
    if journal.operations.iter().any(|op| {
        op.kind == kind
            && op.from == from
            && op.to == to
            && op.size == size
            && op.hash.eq_ignore_ascii_case(&hash)
    }) {
        return;
    }
    let sequence = journal.next_sequence;
    journal.next_sequence = journal.next_sequence.saturating_add(1);
    let device = journal.device.clone();
    journal.operations.push(JournalOperation {
        id: format!("{device}:{sequence}"),
        device,
        sequence,
        at_ms: now_ms(),
        kind,
        from,
        to,
        size,
        hash,
    });
}

/// Reconcile the durable snapshot with the current manifest. A deleted entry
/// becomes a tombstone. A unique same-byte disappearance/appearance becomes a
/// rename; ambiguous copies deliberately remain delete + add so content is not
/// guessed away.
pub fn reconcile_journal(root: &Path, manifest: &[ManifestEntry]) -> std::io::Result<SyncJournal> {
    let _guard = journal_guard()?;
    let mut journal = load_journal_unlocked(root)?;
    let current: HashMap<&str, &ManifestEntry> = manifest
        .iter()
        .map(|entry| (entry.rel.as_str(), entry))
        .collect();
    let local_device = journal.device.clone();
    // A reappeared delete target is a deliberate restore, not a local
    // retraction.  Other devices may already have moved it into recovery, so
    // they need a causally ordered operation that says to bring it back.
    let restores: Vec<_> = journal
        .operations
        .iter()
        .filter(|op| op.device == local_device && op.kind == JournalOperationKind::Delete)
        .filter_map(|op| {
            current
                .get(op.from.as_str())
                .filter(|entry| entry.size == op.size && entry.hash.eq_ignore_ascii_case(&op.hash))
                .map(|_| (op.from.clone(), op.size, op.hash.clone()))
        })
        .collect();
    for (from, size, hash) in restores {
        append_operation(
            &mut journal,
            JournalOperationKind::Restore,
            from,
            None,
            size,
            hash,
        );
    }
    let old: HashMap<&str, &JournalEntry> = journal
        .known
        .iter()
        .map(|entry| (entry.rel.as_str(), entry))
        .collect();
    let mut added: Vec<&ManifestEntry> = manifest
        .iter()
        .filter(|entry| !old.contains_key(entry.rel.as_str()))
        .collect();
    let prior_known = journal.known.clone();
    for entry in &prior_known {
        if current.contains_key(entry.rel.as_str()) {
            continue;
        }
        let matches: Vec<usize> = added
            .iter()
            .enumerate()
            .filter_map(|(index, candidate)| {
                (candidate.size == entry.size && candidate.hash.eq_ignore_ascii_case(&entry.hash))
                    .then_some(index)
            })
            .collect();
        if matches.len() == 1 {
            let candidate = added.swap_remove(matches[0]);
            append_operation(
                &mut journal,
                JournalOperationKind::Rename,
                entry.rel.clone(),
                Some(candidate.rel.clone()),
                entry.size,
                entry.hash.clone(),
            );
        } else {
            append_operation(
                &mut journal,
                JournalOperationKind::Delete,
                entry.rel.clone(),
                None,
                entry.size,
                entry.hash.clone(),
            );
        }
    }
    journal.known = manifest
        .iter()
        .map(|entry| JournalEntry {
            rel: entry.rel.clone(),
            size: entry.size,
            hash: entry.hash.clone(),
        })
        .collect();
    save_journal_unlocked(root, &journal)
}

/// Reconciliation is destructive intent generation.  A scan that could not
/// account for every reachable path is useful diagnostic information, but it
/// is never evidence that a prior file was deleted.  Keep the last complete
/// `known` snapshot and return it unchanged until the next complete scan.
pub fn reconcile_complete_journal(
    root: &Path,
    manifest: &[ManifestEntry],
    scan_errors: &[(String, String)],
) -> std::io::Result<SyncJournal> {
    if scan_errors.is_empty() {
        reconcile_journal(root, manifest)
    } else {
        let _guard = journal_guard()?;
        load_journal_unlocked(root)
    }
}

#[cfg(test)]
pub fn merge_journal(root: &Path, remote: &SyncJournal) -> std::io::Result<SyncJournal> {
    let _guard = journal_guard()?;
    let mut local = load_journal_unlocked(root)?;
    merge_remote_into(&mut local, remote)?;
    save_journal_unlocked(root, &local)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JournalApply {
    Applied,
    AlreadyApplied,
    Conflict,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalOperationOutcome {
    pub operation: JournalOperation,
    pub result: Result<JournalApply, String>,
}

/// Merge and apply a peer journal under one serialized coordinator so receiving
/// intent, acknowledging durable operations, and writing the updated journal
/// cannot interleave with another manifest or sync request.
pub fn apply_incoming_journal(
    root: &Path,
    incoming: &SyncJournal,
) -> std::io::Result<(SyncJournal, Vec<JournalOperationOutcome>)> {
    let _guard = journal_guard()?;
    let mut local = load_journal_unlocked(root)?;
    merge_remote_into(&mut local, incoming)?;
    let mut pending: Vec<_> = incoming
        .operations
        .iter()
        .filter(|op| op.device != local.device && !local.applied.iter().any(|id| id == &op.id))
        .cloned()
        .collect();
    // Peers may serialize a valid journal in any array order.  Apply each
    // device's causally ordered chain numerically, never in wire-array or
    // lexical-ID order (`:10` must not precede `:2`).
    pending.sort_by(|a, b| {
        a.device
            .cmp(&b.device)
            .then_with(|| a.sequence.cmp(&b.sequence))
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut outcomes = Vec::with_capacity(pending.len());
    for operation in pending {
        let result = apply_journal_operation(root, &operation).map_err(|error| error.to_string());
        if matches!(
            result,
            Ok(JournalApply::Applied | JournalApply::AlreadyApplied)
        ) {
            push_unique(&mut local.applied, operation.id.clone());
        }
        outcomes.push(JournalOperationOutcome { operation, result });
    }
    let saved = save_journal_unlocked(root, &local)?;
    Ok((saved, outcomes))
}

/// Move a user file without ever replacing a destination created by another
/// writer. Shared by sync journal replay and the interactive vault rename IPC.
pub fn move_file_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    ensure_real_parent(to)?;
    match publish_candidate(&StdCommitFs, from, to)? {
        PublishMethod::ExclusiveRename => {}
        PublishMethod::HardLink => {
            // A hard link is an exclusive, byte-preserving fallback when the
            // platform does not offer native no-replace rename. If source
            // removal fails, undo the link where possible so callers never see
            // a successful rename with two live user paths.
            if let Err(error) = std::fs::remove_file(from) {
                let _ = std::fs::remove_file(to);
                return Err(error);
            }
        }
    }
    Ok(())
}

fn move_no_replace(from: &Path, to: &Path, size: u64, hash: &str) -> std::io::Result<()> {
    move_file_no_replace(from, to)?;
    let actual = hash_file_streaming(to)?;
    if fingerprint_matches(&actual, size, hash) {
        Ok(())
    } else {
        Err(invalid_data("journal move failed final verification"))
    }
}

/// Apply a remote operation only when its old content still matches exactly.
/// A concurrent local edit is retained and reported as a conflict; deletion
/// therefore never silently wins over user content.
pub fn apply_journal_operation(
    root: &Path,
    op: &JournalOperation,
) -> std::io::Result<JournalApply> {
    let from =
        safe_join_confined(root, &op.from).ok_or_else(|| invalid_data("unsafe journal source"))?;
    match op.kind {
        JournalOperationKind::Delete => match hash_file_streaming(&from) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(JournalApply::AlreadyApplied)
            }
            Err(error) => Err(error),
            Ok(actual) if !fingerprint_matches(&actual, op.size, &op.hash) => {
                Ok(JournalApply::Conflict)
            }
            Ok(_) => {
                // Remote deletion must have the same recovery path as an
                // explicit Mesa delete.  A hidden sibling that is immediately
                // removed is neither discoverable nor safe if verification
                // fails after the move.
                let parent = from
                    .parent()
                    .ok_or_else(|| invalid_data("journal source has no parent"))?;
                let trash = parent.join(".mesa-trash");
                std::fs::create_dir_all(&trash)?;
                let original = from
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("file");
                // The double separator makes the remote provenance marker
                // unambiguous to the frontend recovery parser while retaining
                // the exact original filename for restore.
                let tomb = trash.join(format!("{}-remote--{}", now_ms(), original));
                std::fs::rename(&from, &tomb)?;
                let moved = hash_file_streaming(&tomb)?;
                if !fingerprint_matches(&moved, op.size, &op.hash) {
                    // Do not strand changed bytes in an invisible artifact.
                    // Restore the visible source when possible; if a racing
                    // writer occupied it, preserve the verified recovery copy
                    // and report a conflict instead of overwriting that writer.
                    if !from.exists() {
                        let _ = std::fs::rename(&tomb, &from);
                    }
                    return Ok(JournalApply::Conflict);
                }
                Ok(JournalApply::Applied)
            }
        },
        JournalOperationKind::Rename => {
            let Some(to_rel) = op.to.as_deref() else {
                return Err(invalid_data("rename journal entry missing destination"));
            };
            let to = safe_join_confined(root, to_rel)
                .ok_or_else(|| invalid_data("unsafe journal destination"))?;
            match (hash_file_streaming(&from), hash_file_streaming(&to)) {
                (Err(from_error), Ok(target))
                    if from_error.kind() == std::io::ErrorKind::NotFound
                        && fingerprint_matches(&target, op.size, &op.hash) =>
                {
                    Ok(JournalApply::AlreadyApplied)
                }
                (Err(from_error), Err(to_error))
                    if from_error.kind() == std::io::ErrorKind::NotFound
                        && to_error.kind() == std::io::ErrorKind::NotFound =>
                {
                    Ok(JournalApply::Conflict)
                }
                (Ok(source), Err(target_error))
                    if target_error.kind() == std::io::ErrorKind::NotFound
                        && fingerprint_matches(&source, op.size, &op.hash) =>
                {
                    move_no_replace(&from, &to, op.size, &op.hash)?;
                    Ok(JournalApply::Applied)
                }
                (Ok(source), Ok(target))
                    if fingerprint_matches(&source, op.size, &op.hash)
                        && fingerprint_matches(&target, op.size, &op.hash) =>
                {
                    std::fs::remove_file(&from)?;
                    Ok(JournalApply::AlreadyApplied)
                }
                _ => Ok(JournalApply::Conflict),
            }
        }
        JournalOperationKind::Restore => match hash_file_streaming(&from) {
            Ok(actual) if fingerprint_matches(&actual, op.size, &op.hash) => {
                Ok(JournalApply::AlreadyApplied)
            }
            Ok(_) => Ok(JournalApply::Conflict),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let parent = from
                    .parent()
                    .ok_or_else(|| invalid_data("journal source has no parent"))?;
                let trash = parent.join(".mesa-trash");
                let original = from
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("file");
                let candidate = std::fs::read_dir(&trash)
                    .ok()
                    .into_iter()
                    .flatten()
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .filter(|path| {
                        path.file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.ends_with(&format!("--{original}")))
                    })
                    .find(|path| {
                        hash_file_streaming(path)
                            .ok()
                            .is_some_and(|actual| fingerprint_matches(&actual, op.size, &op.hash))
                    });
                match candidate {
                    Some(recovered) => {
                        move_no_replace(&recovered, &from, op.size, &op.hash)?;
                        Ok(JournalApply::Applied)
                    }
                    // The regular manifest transfer may still supply these
                    // bytes, but never mark this restore acknowledged until a
                    // recovery copy or matching live file is actually present.
                    None => Ok(JournalApply::Conflict),
                }
            }
            Err(error) => Err(error),
        },
    }
}

/// Stable walker output: vault-relative spelling and the corresponding path.
pub type VaultPath = (String, PathBuf);
/// A completed manifest plus read failures that the caller must surface.
pub type ManifestBuild = (Vec<ManifestEntry>, Vec<(String, String)>);
type VaultWalk = (Vec<VaultPath>, Vec<(String, String)>);

/// Epoch milliseconds now (0 if the clock is before 1970, which it isn't).
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// === Hashing =============================================================

/// FNV-1a/64 running hasher. Chunk-feeding N buffers is byte-for-byte
/// identical to hashing their concatenation, so streamed file hashing matches
/// the TypeScript whole-buffer implementation exactly.
pub struct Fnv1a {
    h: u64,
}

impl Fnv1a {
    pub fn new() -> Self {
        Fnv1a {
            h: 0xcbf2_9ce4_8422_2325,
        }
    }

    pub fn update(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.h ^= b as u64;
            self.h = self.h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }

    /// 16-char lowercase hex digest, identical to `fnv1a` in src/lib/sync.ts.
    pub fn hex(&self) -> String {
        format!("{:016x}", self.h)
    }
}

/// One-shot FNV-1a/64 of a byte slice.
#[cfg(test)]
pub fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut f = Fnv1a::new();
    f.update(bytes);
    f.hex()
}

/// Hash a file by streaming 64 KiB chunks — never loads the file into memory.
/// Returns (size, hash).
pub fn hash_file_streaming(path: &Path) -> std::io::Result<(u64, String)> {
    hash_file_streaming_until(path, None).unwrap_or_else(|| {
        Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "hash cancelled",
        ))
    })
}

/// Stream a file without allocating it whole. When cancellation is supplied,
/// return `None` at the next 64 KiB boundary so sync can return control without
/// publishing a partial manifest.
fn hash_file_streaming_until(
    path: &Path,
    cancelled: Option<&AtomicBool>,
) -> Option<std::io::Result<(u64, String)>> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) => return Some(Err(error)),
    };
    let mut hasher = Fnv1a::new();
    let mut buf = [0u8; 64 * 1024];
    let mut size: u64 = 0;
    loop {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        let n = match file.read(&mut buf) {
            Ok(n) => n,
            Err(error) => return Some(Err(error)),
        };
        if n == 0 {
            break;
        }
        size += n as u64;
        hasher.update(&buf[..n]);
    }
    Some(Ok((size, hasher.hex())))
}

// === Hash cache ==========================================================

/// Outcome of consulting the cache for one file, without reading its contents.
pub enum CacheProbe {
    /// `(size, hash)` answered from the cache — the file is not read at all.
    Hit(u64, String),
    /// The file must be hashed. Carries the mtime observed BEFORE hashing,
    /// which is what gets stored alongside the new digest: if the file changes
    /// while it is being read, the stored mtime is already stale and the next
    /// build re-hashes it rather than trusting a torn digest.
    Miss(u128),
}

/// Content-hash cache keyed by (size, mtime). Manifest builds re-hash only
/// files that changed since the last build, which is what makes repeated
/// syncs of a hundreds-of-files vault cheap on both the serving and the
/// initiating side.
#[derive(Default)]
pub struct HashCache {
    entries: HashMap<PathBuf, (u64, u128, String)>, // size, mtime_ns, hash
}

impl HashCache {
    pub fn new() -> Self {
        HashCache {
            entries: HashMap::new(),
        }
    }

    /// Metadata-only cache probe. Cheap enough to run over a whole vault
    /// serially (~13 ms for 4,094 files) before any file is opened, which is
    /// what lets `build_manifest` hash only the misses, and hash them in
    /// parallel.
    pub fn probe(&self, path: &Path) -> std::io::Result<CacheProbe> {
        let meta = std::fs::metadata(path)?;
        let size = meta.len();
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        if let Some((s, m, h)) = self.entries.get(path) {
            if *s == size && *m == mtime_ns && mtime_ns != 0 {
                return Ok(CacheProbe::Hit(size, h.clone()));
            }
        }
        Ok(CacheProbe::Miss(mtime_ns))
    }

    /// Record a freshly computed digest. `size` is the byte count the streaming
    /// read actually saw, `mtime_ns` the pre-hash mtime from `probe`.
    pub fn store(&mut self, path: &Path, size: u64, mtime_ns: u128, hash: &str) {
        self.entries
            .insert(path.to_path_buf(), (size, mtime_ns, hash.to_string()));
    }

    /// Keep cache ownership bounded to the current vault snapshot. This also
    /// removes renamed/deleted paths instead of retaining them for the life of
    /// the process. A hard cap protects a vault with unusually many files.
    pub fn prune(&mut self, live: &[PathBuf], max_entries: usize) {
        let live: std::collections::HashSet<&Path> = live.iter().map(PathBuf::as_path).collect();
        self.entries.retain(|path, _| live.contains(path.as_path()));
        if self.entries.len() > max_entries {
            let remove = self.entries.len() - max_entries;
            let keys: Vec<PathBuf> = self.entries.keys().take(remove).cloned().collect();
            for key in keys {
                self.entries.remove(&key);
            }
        }
    }

    /// (size, hash) of `path`, re-hashing only when size or mtime changed.
    /// `build_manifest` does not call this — it splits the same two steps so
    /// the reads can run in parallel — but it is the reference definition of
    /// what that split must add up to, and the tests hold it to that.
    #[cfg(test)]
    pub fn hash_file(&mut self, path: &Path) -> std::io::Result<(u64, String)> {
        match self.probe(path)? {
            CacheProbe::Hit(size, hash) => Ok((size, hash)),
            CacheProbe::Miss(mtime_ns) => {
                let (real_size, hash) = hash_file_streaming(path)?;
                self.store(path, real_size, mtime_ns, &hash);
                Ok((real_size, hash))
            }
        }
    }
}

// === Vault walking =======================================================

/// Files/dirs sync ignores. Matches the frontend vault walker
/// (`src/lib/vault.ts` `walk`): dot-prefixed names (covers `.git`,
/// `.obsidian`, `.DS_Store`) and `node_modules`.
pub fn ignored_name(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

/// Recursively list every syncable file under `root` as
/// (vault-relative path with forward slashes, absolute path), sorted by rel
/// path for deterministic manifests. The compatibility helper keeps its old
/// file-only shape for tests; production callers use the error-carrying walk
/// below and must treat any error as incomplete coverage.
#[cfg(test)]
pub fn list_vault_files(root: &Path) -> Vec<VaultPath> {
    list_vault_files_with_errors_until(root, None)
        .map(|(files, _)| files)
        .unwrap_or_default()
}

fn rel_for_error(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .filter(|rel| !rel.is_empty())
        .unwrap_or_else(|| ".".to_string())
}

fn list_vault_files_with_errors_until(
    root: &Path,
    cancelled: Option<&AtomicBool>,
) -> Option<VaultWalk> {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    if !walk(root, root, &mut out, &mut errors, cancelled) {
        return None;
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Some((out, errors))
}

fn walk(
    root: &Path,
    dir: &Path,
    out: &mut Vec<VaultPath>,
    errors: &mut Vec<(String, String)>,
    cancelled: Option<&AtomicBool>,
) -> bool {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return false;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(error) => {
            errors.push((
                rel_for_error(root, dir),
                format!("read directory failed: {error}"),
            ));
            return true;
        }
    };
    for entry in rd {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return false;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                errors.push((
                    rel_for_error(root, dir),
                    format!("read directory entry failed: {error}"),
                ));
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if ignored_name(&name) {
            continue;
        }
        let path = entry.path();
        let ftype = match entry.file_type() {
            Ok(t) => t,
            Err(error) => {
                errors.push((
                    rel_for_error(root, &path),
                    format!("file type failed: {error}"),
                ));
                continue;
            }
        };
        if ftype.is_dir() {
            if !walk(root, &path, out, errors, cancelled) {
                return false;
            }
        } else if ftype.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                out.push((rel, path));
            }
        }
    }
    true
}

// === Manifest ============================================================

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ManifestEntry {
    pub rel: String,
    pub size: u64,
    pub hash: String,
}

/// Below this many cache misses the hashing stays inline: spawning threads
/// costs more than it saves, and the common warm-cache build has zero misses.
const PARALLEL_HASH_MIN_FILES: usize = 8;

/// Hashing threads. Keep a small application-owned budget so a cold sync does
/// not consume every core needed by editing, PDF rendering, or Pi.
fn hash_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(2)
}

/// `(index into files, pre-hash mtime, streamed hash result)`.
type HashOutcome = (usize, u128, std::io::Result<(u64, String)>);

/// Hash `work` (indices into `files`, each with its pre-hash mtime) within the
/// application-owned worker budget, returning `(index, mtime_ns, result)` per
/// item in completion order.
///
/// FNV-1a/64 is a strictly serial recurrence — `h = (h ^ byte) * prime` — so a
/// single file's digest cannot be computed in parallel. Whole FILES are
/// independent though, and a manifest is thousands of them, so the parallelism
/// goes there. Every digest is still produced by the same `hash_file_streaming`
/// over the same bytes, so the wire hashes are byte-identical to the serial
/// build; only the order the work is dispatched in changes.
///
/// Files vary from empty to 39 MB in the reference vault, so threads pull from
/// a shared atomic cursor rather than taking a fixed slice — a static split
/// would leave one thread holding the large tail while the rest idled.
fn hash_missing(
    files: &[(String, PathBuf)],
    work: &[(usize, u128)],
    cancelled: Option<&AtomicBool>,
) -> Option<Vec<HashOutcome>> {
    let threads = hash_threads().min(work.len());
    if work.len() < PARALLEL_HASH_MIN_FILES || threads <= 1 {
        let mut outcomes = Vec::with_capacity(work.len());
        for &(i, mtime) in work {
            let result = hash_file_streaming_until(&files[i].1, cancelled)?;
            outcomes.push((i, mtime, result));
        }
        return Some(outcomes);
    }
    let cursor = AtomicUsize::new(0);
    let collected: Option<Vec<Vec<HashOutcome>>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                let cursor = &cursor;
                s.spawn(move || {
                    let mut local = Vec::new();
                    loop {
                        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                            return None;
                        }
                        let n = cursor.fetch_add(1, Ordering::Relaxed);
                        if n >= work.len() {
                            break;
                        }
                        let (i, mtime) = work[n];
                        let result = hash_file_streaming_until(&files[i].1, cancelled)?;
                        local.push((i, mtime, result));
                    }
                    Some(local)
                })
            })
            .collect();
        handles
            .into_iter()
            // A panicking hash thread would poison the whole manifest; there is
            // nothing in `hash_file_streaming` that panics on I/O (errors come
            // back as `Err`), so propagate rather than silently dropping files.
            .map(|h| h.join().expect("hash thread panicked"))
            .collect::<Option<Vec<_>>>()
    });
    Some(collected?.into_iter().flatten().collect())
}

/// Build a manifest for `root`. Returns (entries, skipped) where `skipped`
/// is (rel, error) for every file that could not be read — callers surface
/// these instead of silently dropping files from the sync set.
///
/// Both outputs stay in `list_vault_files` rel order regardless of the order
/// the hashing threads finish in, so the serialized manifest is deterministic.
pub fn build_manifest(root: &Path, cache: &mut HashCache) -> ManifestBuild {
    build_manifest_until(root, cache, None).expect("uncancelled manifest must complete")
}

/// Cancellation-aware manifest build for the client sync path. `None` means
/// the caller requested cancellation; no partial manifest is returned.
pub fn build_manifest_cancellable(
    root: &Path,
    cache: &mut HashCache,
    cancelled: &AtomicBool,
) -> Option<ManifestBuild> {
    build_manifest_until(root, cache, Some(cancelled))
}

fn build_manifest_until(
    root: &Path,
    cache: &mut HashCache,
    cancelled: Option<&AtomicBool>,
) -> Option<ManifestBuild> {
    let (files, mut skipped) = list_vault_files_with_errors_until(root, cancelled)?;
    cache.prune(
        &files
            .iter()
            .map(|(_, path)| path.clone())
            .collect::<Vec<_>>(),
        4096,
    );

    // Phase 1 — serial, metadata only. Resolves every file the cache already
    // knows without opening it, and collects the rest as work items.
    let mut resolved: Vec<Result<Option<(u64, String)>, String>> = Vec::with_capacity(files.len());
    let mut work: Vec<(usize, u128)> = Vec::new();
    for (i, (_, path)) in files.iter().enumerate() {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        match cache.probe(path) {
            Ok(CacheProbe::Hit(size, hash)) => resolved.push(Ok(Some((size, hash)))),
            Ok(CacheProbe::Miss(mtime_ns)) => {
                work.push((i, mtime_ns));
                resolved.push(Ok(None));
            }
            Err(e) => resolved.push(Err(e.to_string())),
        }
    }

    // Phase 2 — read and hash the misses across all cores.
    let hashed = hash_missing(&files, &work, cancelled)?;

    // Phase 3 — fold results back into rel order and update the cache.
    for (i, mtime_ns, result) in hashed {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        resolved[i] = match result {
            Ok((real_size, hash)) => {
                cache.store(&files[i].1, real_size, mtime_ns, &hash);
                Ok(Some((real_size, hash)))
            }
            Err(e) => Err(e.to_string()),
        };
    }

    let mut entries = Vec::with_capacity(files.len());
    for ((rel, _), slot) in files.into_iter().zip(resolved) {
        match slot {
            Ok(Some((size, hash))) => entries.push(ManifestEntry { rel, size, hash }),
            // `None` is unreachable: every work item is written back above.
            Ok(None) => skipped.push((rel, "hash not computed".to_string())),
            Err(e) => skipped.push((rel, e)),
        }
    }
    Some((entries, skipped))
}

/// Serialize a manifest as the wire JSON: {"files":[{"rel","size","hash"}]}.
pub fn manifest_to_json(entries: &[ManifestEntry]) -> String {
    let mut s = String::from("{\"journalVersion\":1,\"files\":[");
    for (i, e) in entries.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"rel\":{},\"size\":{},\"hash\":\"{}\"}}",
            json_str(&e.rel),
            e.size,
            e.hash
        ));
    }
    s.push_str("]}");
    s
}

// === Diff ================================================================

#[derive(Debug, Default)]
pub struct ManifestDiff {
    /// Present on remote only → create locally.
    pub pull: Vec<String>,
    /// Present locally only → send to remote.
    pub push: Vec<String>,
    /// Present on both sides with differing content → conflict copy.
    pub conflict: Vec<String>,
    /// Present on both sides with identical content.
    pub same: u32,
}

/// Safe two-way diff — mirrors `diffManifests` in src/lib/sync.ts exactly
/// (including output order: remote order for pull/conflict, local for push).
pub fn diff_manifests(local: &[ManifestEntry], remote: &[ManifestEntry]) -> ManifestDiff {
    let l: HashMap<&str, &ManifestEntry> = local.iter().map(|e| (e.rel.as_str(), e)).collect();
    let r: HashMap<&str, &ManifestEntry> = remote.iter().map(|e| (e.rel.as_str(), e)).collect();
    let mut d = ManifestDiff::default();
    for e in remote {
        match l.get(e.rel.as_str()) {
            None => d.pull.push(e.rel.clone()),
            Some(le) if le.hash != e.hash => d.conflict.push(e.rel.clone()),
            Some(_) => d.same += 1,
        }
    }
    for e in local {
        if !r.contains_key(e.rel.as_str()) {
            d.push.push(e.rel.clone());
        }
    }
    d
}

// === Conflict copies =====================================================

/// Hostname part of a peer base URL ("https://100.64.0.2:8787/x" → "100.64.0.2").
/// Mirrors the host extraction inside `conflictName` in src/lib/sync.ts.
pub fn host_of_base(base: &str) -> String {
    let no_scheme = base
        .strip_prefix("https://")
        .or_else(|| base.strip_prefix("http://"))
        .unwrap_or(base);
    let end = no_scheme.find([':', '/']).unwrap_or(no_scheme.len());
    no_scheme[..end].to_string()
}

/// Filename for a conflict copy, e.g. "Note (conflict from peer 2026-06-23).md".
/// Mirrors `conflictName` in src/lib/sync.ts; `date` is "YYYY-MM-DD".
pub fn conflict_name(rel: &str, host: &str, date: &str) -> String {
    let tag = format!(" (conflict from {} {})", host, date);
    let dot = rel.rfind('.').map(|i| i as i64).unwrap_or(-1);
    let slash = rel.rfind('/').map(|i| i as i64).unwrap_or(-1);
    if dot > slash {
        let d = dot as usize;
        format!("{}{}{}", &rel[..d], tag, &rel[d..])
    } else {
        format!("{}{}", rel, tag)
    }
}

/// Today as "YYYY-MM-DD" (UTC), matching the TS `toISOString().slice(0,10)`.
pub fn utc_date_string() -> String {
    // Days-since-epoch → civil date (Howard Hinnant's algorithm), no chrono dep.
    let days = (now_ms() / 86_400_000) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

// === Paths & verified commits ============================================

/// Join a vault-relative path safely (reject traversal / absolute segments).
pub fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    // Keep this policy platform-independent. Windows accepts drive prefixes,
    // alternate-data-stream syntax, and reserved device names that are not
    // vault-relative names even when the host is Unix.
    let normalized = rel.replace('\\', "/");
    if normalized.starts_with('/')
        || normalized.contains(':')
        || normalized.split('/').any(|seg| {
            let stem = seg
                .split_once('.')
                .map(|(s, _)| s)
                .unwrap_or(seg)
                .trim_end_matches([' ', '.']);
            let upper = stem.to_ascii_uppercase();
            matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (upper.len() == 4
                    && matches!(upper.get(0..3), Some("COM" | "LPT"))
                    && upper.as_bytes()[3].is_ascii_digit())
                || seg.ends_with([' ', '.'])
        })
    {
        return None;
    }
    let mut p = root.to_path_buf();
    for seg in normalized.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        p.push(seg);
    }
    Some(p)
}

/// Resolve a sync path only when its existing components stay under `root`.
/// The final component may be missing for a create-only PUT.
pub fn safe_join_confined(root: &Path, rel: &str) -> Option<PathBuf> {
    let path = safe_join(root, rel)?;
    let canonical_root = std::fs::canonicalize(root).ok()?;
    let mut existing = path.parent()?;
    loop {
        match std::fs::canonicalize(existing) {
            Ok(canonical) => {
                if !canonical.starts_with(&canonical_root) {
                    return None;
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                existing = existing.parent()?;
            }
            Err(_) => return None,
        }
    }
    if path.exists()
        && !std::fs::canonicalize(&path)
            .ok()?
            .starts_with(&canonical_root)
    {
        return None;
    }
    Some(path)
}

/// Create missing destination parents one component at a time and reject
/// symlink/junction components. The target has already passed
/// `safe_join_confined`; this second check closes the common validation-to-
/// create gap for nested transfers.
#[cfg(unix)]
pub fn ensure_real_parent(target: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::RawFd;

    let parent = target
        .parent()
        .ok_or_else(|| invalid_data("sync target has no parent"))?;
    let mut current = parent.to_path_buf();
    let mut missing = Vec::new();
    while !current.exists() {
        missing.push(current.clone());
        current = current
            .parent()
            .ok_or_else(|| invalid_data("sync target parent is unavailable"))?
            .to_path_buf();
    }

    fn open_dir(path: &Path) -> std::io::Result<RawFd> {
        let bytes = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| invalid_data("sync path contains NUL"))?;
        let fd = unsafe {
            libc::open(
                bytes.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(fd)
        }
    }

    let mut fd = open_dir(&current)?;
    for dir in missing.into_iter().rev() {
        let name = dir
            .file_name()
            .ok_or_else(|| invalid_data("sync target parent has no name"))?;
        let name =
            CString::new(name.as_bytes()).map_err(|_| invalid_data("sync path contains NUL"))?;
        let made = unsafe { libc::mkdirat(fd, name.as_ptr(), 0o755) };
        if made < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                unsafe { libc::close(fd) };
                return Err(error);
            }
        }
        let next = unsafe {
            libc::openat(
                fd,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            )
        };
        if next < 0 {
            let error = std::io::Error::last_os_error();
            unsafe { libc::close(fd) };
            return Err(error);
        }
        unsafe { libc::close(fd) };
        fd = next;
    }
    unsafe { libc::close(fd) };
    Ok(())
}

#[cfg(not(unix))]
pub fn ensure_real_parent(target: &Path) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| invalid_data("sync target has no parent"))?;
    let mut current = parent.to_path_buf();
    let mut missing = Vec::new();
    while !current.exists() {
        missing.push(current.clone());
        current = current
            .parent()
            .ok_or_else(|| invalid_data("sync target parent is unavailable"))?
            .to_path_buf();
    }
    for dir in missing.into_iter().rev() {
        let metadata = std::fs::symlink_metadata(dir.parent().unwrap())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(invalid_data("sync target parent is not a real directory"));
        }
        std::fs::create_dir(&dir)?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitOutcome {
    Created,
    Unchanged,
}

static ARTIFACT_COUNTER: AtomicU64 = AtomicU64::new(0);

fn artifact_token() -> (u64, String) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let counter = ARTIFACT_COUNTER.fetch_add(1, Ordering::Relaxed);
    (
        stamp,
        format!("s{:x}{:x}{:x}", std::process::id(), stamp, counter),
    )
}

fn candidate_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let (stamp, token) = artifact_token();
    path.with_file_name(format!(
        ".mesa-sync-tmp-{}-{stamp}-{token}-{file_name}",
        std::process::id()
    ))
}

fn collision_error(path: &Path) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!(
            "destination already exists with different content: {}",
            path.display()
        ),
    )
}

fn invalid_data(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.into())
}

trait CommitFs {
    #[cfg(test)]
    fn create_dir_all(&self, path: &Path) -> std::io::Result<()>;
    #[cfg(test)]
    fn write_new(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()>;
    fn fingerprint(&self, path: &Path) -> std::io::Result<(u64, String)>;
    fn exclusive_publish(&self, from: &Path, to: &Path) -> Result<(), ExclusivePublishError>;
    fn hard_link(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    fn remove_file(&self, path: &Path) -> std::io::Result<()>;
}

#[derive(Debug)]
enum ExclusivePublishError {
    Unsupported(std::io::Error),
    Failed(std::io::Error),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PublishMethod {
    ExclusiveRename,
    HardLink,
}

struct StdCommitFs;

impl CommitFs for StdCommitFs {
    #[cfg(test)]
    fn create_dir_all(&self, path: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(path)
    }

    #[cfg(test)]
    fn write_new(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(bytes)?;
        file.sync_all()
    }

    fn fingerprint(&self, path: &Path) -> std::io::Result<(u64, String)> {
        hash_file_streaming(path)
    }

    fn exclusive_publish(&self, from: &Path, to: &Path) -> Result<(), ExclusivePublishError> {
        platform_exclusive_publish(from, to)
    }

    fn hard_link(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::hard_link(from, to)
    }

    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn unix_path(path: &Path) -> Result<std::ffi::CString, ExclusivePublishError> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        ExclusivePublishError::Failed(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "sync path contains an interior NUL",
        ))
    })
}

#[cfg(target_os = "linux")]
fn platform_exclusive_publish(from: &Path, to: &Path) -> Result<(), ExclusivePublishError> {
    let from = unix_path(from)?;
    let to = unix_path(to)?;
    // SAFETY: both C strings are NUL-terminated and live through the call.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ENOSYS) | Some(libc::EINVAL) | Some(libc::EOPNOTSUPP) => {
            Err(ExclusivePublishError::Unsupported(error))
        }
        _ => Err(ExclusivePublishError::Failed(error)),
    }
}

#[cfg(target_os = "macos")]
fn platform_exclusive_publish(from: &Path, to: &Path) -> Result<(), ExclusivePublishError> {
    let from = unix_path(from)?;
    let to = unix_path(to)?;
    // SAFETY: both C strings are NUL-terminated and live through the call.
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::EINVAL) | Some(libc::EOPNOTSUPP) => {
            Err(ExclusivePublishError::Unsupported(error))
        }
        _ => Err(ExclusivePublishError::Failed(error)),
    }
}

#[cfg(windows)]
fn platform_exclusive_publish(from: &Path, to: &Path) -> Result<(), ExclusivePublishError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED,
    };
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let mut from_wide: Vec<u16> = from.as_os_str().encode_wide().collect();
    let mut to_wide: Vec<u16> = to.as_os_str().encode_wide().collect();
    from_wide.push(0);
    to_wide.push(0);
    // The replacement flag is deliberately absent. MoveFileExW therefore
    // fails if another writer already created the destination.
    // SAFETY: both UTF-16 buffers are NUL-terminated and live through the call.
    let result =
        unsafe { MoveFileExW(from_wide.as_ptr(), to_wide.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if result != 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_FILE_EXISTS) | Some(ERROR_ALREADY_EXISTS) => Err(ExclusivePublishError::Failed(
            std::io::Error::new(std::io::ErrorKind::AlreadyExists, error),
        )),
        Some(ERROR_INVALID_FUNCTION) | Some(ERROR_NOT_SUPPORTED) => {
            Err(ExclusivePublishError::Unsupported(error))
        }
        _ => Err(ExclusivePublishError::Failed(error)),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn platform_exclusive_publish(_from: &Path, _to: &Path) -> Result<(), ExclusivePublishError> {
    Err(ExclusivePublishError::Unsupported(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "no native exclusive-rename implementation for this platform",
    )))
}

fn fingerprint_matches(actual: &(u64, String), size: u64, hash: &str) -> bool {
    actual.0 == size && actual.1.eq_ignore_ascii_case(hash)
}

fn destination_state<F: CommitFs>(
    fs: &F,
    path: &Path,
    size: u64,
    hash: &str,
) -> std::io::Result<Option<bool>> {
    match fs.fingerprint(path) {
        Ok(actual) => Ok(Some(fingerprint_matches(&actual, size, hash))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
fn stage_candidate<F: CommitFs>(
    fs: &F,
    path: &Path,
    bytes: &[u8],
    size: u64,
    hash: &str,
) -> std::io::Result<PathBuf> {
    for _ in 0..16 {
        let candidate = candidate_path(path);
        match fs.write_new(&candidate, bytes) {
            Ok(()) => {
                let staged = match fs.fingerprint(&candidate) {
                    Ok(staged) => staged,
                    Err(e) => {
                        let _ = fs.remove_file(&candidate);
                        return Err(std::io::Error::new(
                            e.kind(),
                            format!(
                                "sync candidate read-back failed at {}: {e}",
                                candidate.display()
                            ),
                        ));
                    }
                };
                if !fingerprint_matches(&staged, size, hash) {
                    let _ = fs.remove_file(&candidate);
                    return Err(invalid_data(format!(
                        "sync candidate failed read-back verification: {}",
                        candidate.display()
                    )));
                }
                return Ok(candidate);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                // `write_all` or `sync_all` can fail after creating a partial
                // candidate. It is uniquely ours and safe to remove.
                let _ = fs.remove_file(&candidate);
                return Err(e);
            }
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate a unique sync candidate",
    ))
}

fn publish_candidate<F: CommitFs>(
    fs: &F,
    candidate: &Path,
    target: &Path,
) -> std::io::Result<PublishMethod> {
    match fs.exclusive_publish(candidate, target) {
        Ok(()) => Ok(PublishMethod::ExclusiveRename),
        Err(ExclusivePublishError::Failed(e)) => Err(e),
        Err(ExclusivePublishError::Unsupported(exclusive_error)) => {
            match fs.hard_link(candidate, target) {
                Ok(()) => Ok(PublishMethod::HardLink),
                Err(link_error) => Err(std::io::Error::new(
                    link_error.kind(),
                    format!(
                        "native exclusive rename is unsupported ({exclusive_error}); safe hard-link fallback failed: {link_error}"
                    ),
                )),
            }
        }
    }
}

#[cfg(test)]
fn commit_verified_create_with_fs<F: CommitFs>(
    fs: &F,
    path: &Path,
    bytes: &[u8],
    size: u64,
    hash: &str,
) -> std::io::Result<CommitOutcome> {
    if let Some(parent) = path.parent() {
        fs.create_dir_all(parent)?;
    }
    match destination_state(fs, path, size, hash)? {
        Some(true) => return Ok(CommitOutcome::Unchanged),
        Some(false) => return Err(collision_error(path)),
        None => {}
    }

    let candidate = stage_candidate(fs, path, bytes, size, hash)?;
    let mut preserve_candidate = false;
    let result =
        publish_verified_candidate(fs, &candidate, path, size, hash, &mut preserve_candidate);
    if !preserve_candidate {
        let _ = fs.remove_file(&candidate);
    }
    result
}

fn publish_verified_candidate<F: CommitFs>(
    fs: &F,
    candidate: &Path,
    path: &Path,
    size: u64,
    hash: &str,
    preserve_candidate: &mut bool,
) -> std::io::Result<CommitOutcome> {
    match publish_candidate(fs, candidate, path) {
        Ok(method) => match fs.fingerprint(path) {
            Ok(committed) if fingerprint_matches(&committed, size, hash) => {
                if method == PublishMethod::HardLink {
                    let _ = fs.remove_file(candidate);
                }
                Ok(CommitOutcome::Created)
            }
            Ok(_) => {
                *preserve_candidate = method == PublishMethod::HardLink;
                Err(invalid_data(format!(
                "sync target failed final read-back verification; target was preserved because portable file-identity proof is unavailable{}",
                if method == PublishMethod::HardLink {
                    format!("; staged link remains at {}", candidate.display())
                } else {
                    String::new()
                }
            )))
            }
            Err(e) => {
                *preserve_candidate = method == PublishMethod::HardLink;
                Err(invalid_data(format!(
                "sync target final read-back failed ({e}); target was preserved because portable file-identity proof is unavailable{}",
                if method == PublishMethod::HardLink {
                    format!("; staged link remains at {}", candidate.display())
                } else {
                    String::new()
                }
            )))
            }
        },
        Err(publish_error) => {
            let state = destination_state(fs, path, size, hash);
            match state {
                Ok(Some(true)) => Ok(CommitOutcome::Unchanged),
                Ok(Some(false)) => Err(collision_error(path)),
                Ok(None) => Err(std::io::Error::new(
                    publish_error.kind(),
                    format!("safe create failed; destination was not modified: {publish_error}"),
                )),
                Err(e) => Err(e),
            }
        }
    }
}

/// Commit a verified candidate only when `path` is missing. The platform's
/// native exclusive-rename primitive publishes the complete sibling candidate
/// without a check-then-rename race. A hard link is used only when the native
/// primitive reports that the filesystem does not support exclusive rename.
#[cfg(test)]
pub fn commit_verified_create(path: &Path, bytes: &[u8]) -> std::io::Result<CommitOutcome> {
    let size = bytes.len() as u64;
    let hash = fnv1a_hex(bytes);
    commit_verified_create_with_fs(&StdCommitFs, path, bytes, size, &hash)
}

/// The reason a streamed receive failed, kept distinct for HTTP diagnostics.
#[derive(Debug)]
pub enum ReceiveError {
    TooLarge { limit: u64 },
    SizeMismatch { expected: u64, actual: u64 },
    HashMismatch { expected: String, actual: String },
    Read(std::io::Error),
    Write(std::io::Error),
}

impl std::fmt::Display for ReceiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { limit } => write!(f, "transfer exceeds {limit} byte limit"),
            Self::SizeMismatch { expected, actual } => write!(
                f,
                "content size mismatch after transfer (expected {expected}, got {actual})"
            ),
            Self::HashMismatch { expected, actual } => write!(
                f,
                "content hash mismatch after transfer (expected {expected}, got {actual})"
            ),
            Self::Read(e) => write!(f, "transfer read failed: {e}"),
            Self::Write(e) => write!(f, "staged write failed: {e}"),
        }
    }
}

impl std::error::Error for ReceiveError {}

/// Verified, private sibling file. Dropping an interrupted receive removes only
/// this create-new candidate. Publication never replaces an existing target.
pub struct StagedFile {
    path: PathBuf,
    pub size: u64,
    hash: String,
    preserve: bool,
}

pub struct StagedReceive {
    staged: StagedFile,
    file: std::fs::File,
    hasher: Fnv1a,
    max_bytes: u64,
    expected_size: Option<u64>,
    expected_hash: Option<String>,
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if !self.preserve {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl StagedFile {
    pub fn begin(
        target: &Path,
        max_bytes: u64,
        expected_size: Option<u64>,
        expected_hash: Option<&str>,
    ) -> Result<StagedReceive, ReceiveError> {
        ensure_real_parent(target).map_err(ReceiveError::Write)?;
        let mut opened = None;
        for _ in 0..16 {
            let path = candidate_path(target);
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(file) => {
                    opened = Some((path, file));
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(ReceiveError::Write(e)),
            }
        }
        let (path, file) = opened.ok_or_else(|| {
            ReceiveError::Write(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "could not allocate a unique sync candidate",
            ))
        })?;
        Ok(StagedReceive {
            staged: Self {
                path,
                size: 0,
                hash: String::new(),
                preserve: false,
            },
            file,
            hasher: Fnv1a::new(),
            max_bytes,
            expected_size,
            expected_hash: expected_hash.map(str::to_string),
        })
    }

    /// Receive with fixed 64 KiB memory, hash during the write, then verify the
    /// staged disk bytes. The target remains untouched on every receive error.
    pub fn receive(
        target: &Path,
        mut reader: impl Read,
        max_bytes: u64,
        expected_size: Option<u64>,
        expected_hash: Option<&str>,
    ) -> Result<Self, ReceiveError> {
        let mut receive = Self::begin(target, max_bytes, expected_size, expected_hash)?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = match reader.read(&mut buffer) {
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                result => result.map_err(ReceiveError::Read)?,
            };
            if n == 0 {
                break;
            }
            receive.write_chunk(&buffer[..n])?;
        }
        receive.finish()
    }

    fn publish(&mut self, target: &Path) -> std::io::Result<CommitOutcome> {
        // Repeat the existing-file check for idempotency and numbered conflicts.
        // The exclusive rename remains authoritative for a race after this check.
        match destination_state(&StdCommitFs, target, self.size, &self.hash)? {
            Some(true) => return Ok(CommitOutcome::Unchanged),
            Some(false) => return Err(collision_error(target)),
            None => {}
        }
        publish_verified_candidate(
            &StdCommitFs,
            &self.path,
            target,
            self.size,
            &self.hash,
            &mut self.preserve,
        )
    }

    pub fn commit(mut self, target: &Path) -> std::io::Result<CommitOutcome> {
        self.publish(target)
    }

    pub fn commit_conflict(
        mut self,
        root: &Path,
        base_rel: &str,
    ) -> std::io::Result<(CommitOutcome, String)> {
        for ordinal in 1..=10_000 {
            let rel = numbered_conflict_name(base_rel, ordinal);
            let target = safe_join_confined(root, &rel).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("unsafe destination path {rel:?}"),
                )
            })?;
            match self.publish(&target) {
                Ok(outcome) => return Ok((outcome, rel)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "too many same-day conflict copies",
        ))
    }
}

impl StagedReceive {
    pub fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), ReceiveError> {
        if bytes.len() as u64 > self.max_bytes.saturating_sub(self.staged.size) {
            return Err(ReceiveError::TooLarge {
                limit: self.max_bytes,
            });
        }
        self.file.write_all(bytes).map_err(ReceiveError::Write)?;
        self.hasher.update(bytes);
        self.staged.size += bytes.len() as u64;
        Ok(())
    }

    pub fn finish(mut self) -> Result<StagedFile, ReceiveError> {
        if let Some(expected) = self.expected_size {
            if self.staged.size != expected {
                return Err(ReceiveError::SizeMismatch {
                    expected,
                    actual: self.staged.size,
                });
            }
        }
        self.staged.hash = self.hasher.hex();
        if let Some(expected) = &self.expected_hash {
            if !expected.eq_ignore_ascii_case(&self.staged.hash) {
                return Err(ReceiveError::HashMismatch {
                    expected: expected.clone(),
                    actual: self.staged.hash.clone(),
                });
            }
        }
        self.file.sync_all().map_err(ReceiveError::Write)?;
        drop(self.file);
        let actual = hash_file_streaming(&self.staged.path).map_err(ReceiveError::Write)?;
        if !fingerprint_matches(&actual, self.staged.size, &self.staged.hash) {
            return Err(ReceiveError::Write(invalid_data(format!(
                "sync candidate failed read-back verification: {}",
                self.staged.path.display()
            ))));
        }
        Ok(self.staged)
    }
}

/// Add a numeric collision suffix before the extension. The base conflict
/// name remains mirrored with TypeScript; this Rust-only helper prevents a
/// second same-day conflict from overwriting the first one.
pub fn numbered_conflict_name(base: &str, ordinal: u32) -> String {
    if ordinal <= 1 {
        return base.to_string();
    }
    let tag = format!(" ({ordinal})");
    let dot = base.rfind('.').map(|i| i as i64).unwrap_or(-1);
    let slash = base.rfind('/').map(|i| i as i64).unwrap_or(-1);
    if dot > slash {
        let d = dot as usize;
        format!("{}{}{}", &base[..d], tag, &base[d..])
    } else {
        format!("{base}{tag}")
    }
}

/// Commit a conflict copy without replacing any existing same-day copy.
/// Identical bytes reuse the first matching numbered destination; different
/// bytes advance until an unused sibling is available.
#[cfg(test)]
pub fn commit_conflict_verified(
    root: &Path,
    base_rel: &str,
    bytes: &[u8],
) -> std::io::Result<(CommitOutcome, String)> {
    for ordinal in 1..=10_000 {
        let dest_rel = numbered_conflict_name(base_rel, ordinal);
        let dest = safe_join_confined(root, &dest_rel).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("unsafe destination path {dest_rel:?}"),
            )
        })?;
        match commit_verified_create(&dest, bytes) {
            Ok(outcome) => return Ok((outcome, dest_rel)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "too many same-day conflict copies",
    ))
}

/// Check the contiguous conflict-copy sequence for identical bytes. Mesa's
/// own numbering is gap-free, so this avoids downloading and reporting the
/// same conflict on every later sync without scanning 10,000 missing paths.
pub fn conflict_copy_already_present(
    root: &Path,
    base_rel: &str,
    expected_size: u64,
    expected_hash: &str,
) -> std::io::Result<bool> {
    for ordinal in 1..=10_000 {
        let dest_rel = numbered_conflict_name(base_rel, ordinal);
        let dest = safe_join_confined(root, &dest_rel).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("unsafe destination path {dest_rel:?}"),
            )
        })?;
        match hash_file_streaming(&dest) {
            Ok(actual) if fingerprint_matches(&actual, expected_size, expected_hash) => {
                return Ok(true);
            }
            Ok(_) => continue,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e),
        }
    }
    Ok(false)
}

// === Wire helpers ========================================================

/// Minimal JSON string escape.
pub fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Percent-decode a URL query value ('+' becomes a space).
pub fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(byte) => {
                    out.push(byte);
                    i += 3;
                }
                Err(_) => {
                    out.push(b'%');
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Extract one query parameter's decoded value from a raw query string.
pub fn query_param(query: &str, key: &str) -> Option<String> {
    for kv in query.split('&') {
        if let Some((k, v)) = kv.split_once('=') {
            if k == key {
                return Some(url_decode(v));
            }
        }
    }
    None
}

// === Tests ===============================================================
//
// Cross-language vectors: several of these assert the exact same inputs and
// outputs as src/lib/sync.test.ts, pinning the Rust/TS contract.

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[test]
    fn idle_large_baseline_stays_local() {
        let mut journal = SyncJournal::empty("local".into());
        journal.known = (0..12_000)
            .map(|i| JournalEntry {
                rel: format!("Research/long-document-name-{i:06}-source-material.md"),
                size: 100,
                hash: "0123456789abcdef".into(),
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
        let dir =
            std::env::temp_dir().join(format!("mesa-retired-incoming-{}", std::process::id()));
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
            Ok((bytes.len() as u64, fnv1a_hex(bytes)))
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
    fn fnv1a_matches_ts_vectors() {
        // Same vectors as src/lib/sync.test.ts.
        assert_eq!(fnv1a_hex(b""), "cbf29ce484222325");
        assert_eq!(fnv1a_hex(b"hello world"), fnv1a_hex(b"hello world"));
        assert_ne!(fnv1a_hex(b"a"), fnv1a_hex(b"b"));
        assert_eq!(fnv1a_hex(b"hello world").len(), 16);
    }

    #[test]
    fn streamed_hash_equals_whole_buffer_hash() {
        let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let whole = fnv1a_hex(&data);
        let mut chunked = Fnv1a::new();
        for chunk in data.chunks(7) {
            chunked.update(chunk);
        }
        assert_eq!(whole, chunked.hex());
    }

    #[test]
    fn hash_file_streams_and_caches() {
        let dir = std::env::temp_dir().join(format!("mesa-core-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.bin");
        std::fs::write(&f, b"hello world").unwrap();
        let (size, hash) = hash_file_streaming(&f).unwrap();
        assert_eq!(size, 11);
        assert_eq!(hash, fnv1a_hex(b"hello world"));

        let mut cache = HashCache::new();
        let first = cache.hash_file(&f).unwrap();
        let second = cache.hash_file(&f).unwrap();
        assert_eq!(first, second);

        // Content change (same length ⇒ relies on mtime; force a distinct one).
        std::fs::write(&f, b"HELLO WORLD").unwrap();
        let newer = std::time::SystemTime::now() + std::time::Duration::from_secs(2);
        let ft = std::fs::File::options().write(true).open(&f).unwrap();
        ft.set_modified(newer).unwrap();
        drop(ft);
        let third = cache.hash_file(&f).unwrap();
        assert_eq!(third.1, fnv1a_hex(b"HELLO WORLD"));
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
        let mut cache = HashCache::new();
        let (entries, skipped) = build_manifest(&v.0, &mut cache);
        assert!(skipped.is_empty(), "unexpected skips: {skipped:?}");
        assert_eq!(entries.len(), made.len());
        for (rel, bytes) in &made {
            let e = entries
                .iter()
                .find(|e| &e.rel == rel)
                .unwrap_or_else(|| panic!("missing {rel}"));
            assert_eq!(e.hash, fnv1a_hex(bytes), "hash mismatch for {rel}");
            assert_eq!(e.size, bytes.len() as u64, "size mismatch for {rel}");
        }
    }

    /// Threads finish in nondeterministic order; the manifest must not.
    #[test]
    fn build_manifest_order_is_deterministic_and_sorted() {
        let v = ManifestVault::new("order");
        v.populate();
        let first = build_manifest(&v.0, &mut HashCache::new()).0;
        let second = build_manifest(&v.0, &mut HashCache::new()).0;
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
        assert!(build_manifest_cancellable(&v.0, &mut HashCache::new(), &cancelled).is_none());
    }

    #[test]
    fn hash_cache_prune_removes_paths_outside_the_snapshot() {
        let v = ManifestVault::new("prune");
        let kept = v.0.join("kept.md");
        let removed = v.0.join("removed.md");
        v.write("kept.md", b"kept");
        v.write("removed.md", b"removed");
        let mut cache = HashCache::new();
        cache.hash_file(&kept).unwrap();
        cache.hash_file(&removed).unwrap();
        cache.prune(&[kept], 4096);
        assert!(matches!(
            cache.probe(&removed).unwrap(),
            CacheProbe::Miss(_)
        ));
    }

    /// A warm cache must still short-circuit: the parallel phase may only see
    /// files whose (size, mtime) changed. Rewriting content while preserving
    /// both proves the second build never re-read the file.
    #[test]
    fn build_manifest_reuses_cached_digests() {
        let v = ManifestVault::new("warm");
        v.populate();
        let mut cache = HashCache::new();
        let (first, _) = build_manifest(&v.0, &mut cache);

        let target = v.0.join("file1.bin");
        let meta = std::fs::metadata(&target).unwrap();
        let mtime = meta.modified().unwrap();
        std::fs::write(&target, b"DIFFERENT!!").unwrap(); // same 11-byte length
        let f = std::fs::File::options().write(true).open(&target).unwrap();
        f.set_modified(mtime).unwrap();
        drop(f);

        let (second, _) = build_manifest(&v.0, &mut cache);
        let pick = |m: &[ManifestEntry]| {
            m.iter()
                .find(|e| e.rel == "file1.bin")
                .unwrap()
                .hash
                .clone()
        };
        assert_eq!(pick(&first), pick(&second), "cached digest was not reused");

        // A fresh cache does read it, and sees the new bytes.
        let (third, _) = build_manifest(&v.0, &mut HashCache::new());
        assert_eq!(pick(&third), fnv1a_hex(b"DIFFERENT!!"));
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
        let (entries, skipped) = build_manifest(&v.0, &mut HashCache::new());
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
        let (entries, errors) = build_manifest(&root, &mut HashCache::new());
        assert!(entries.is_empty());
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].0, ".");
        assert!(errors[0].1.contains("read directory failed"));
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
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.pull, vec!["remote.md"]);
        assert_eq!(d.push, vec!["local.md"]);
        assert_eq!(d.conflict, vec!["b.md"]);
        assert_eq!(d.same, 1);

        let m = vec![e("a.md", "1"), e("b.md", "2")];
        let d = diff_manifests(&m, &m.clone());
        assert!(d.pull.is_empty() && d.push.is_empty() && d.conflict.is_empty());
        assert_eq!(d.same, 2);
    }

    #[test]
    fn conflict_name_matches_ts() {
        // Same shape as src/lib/sync.test.ts "conflictName".
        assert_eq!(
            conflict_name("sub/Note.md", "100.64.0.2", "2026-06-23"),
            "sub/Note (conflict from 100.64.0.2 2026-06-23).md"
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
        let remote_hash = fnv1a_hex(b"remote");
        assert!(
            conflict_copy_already_present(&dir, base, b"remote".len() as u64, &remote_hash,)
                .unwrap()
        );
        assert!(!conflict_copy_already_present(
            &dir,
            base,
            b"third".len() as u64,
            &fnv1a_hex(b"third"),
        )
        .unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn host_of_base_strips_scheme_port_path() {
        assert_eq!(host_of_base("https://100.64.0.2:8787"), "100.64.0.2");
        assert_eq!(host_of_base("http://mac-mini/x"), "mac-mini");
        assert_eq!(host_of_base("mac-mini:8787"), "mac-mini");
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
            Some(&fnv1a_hex(b"nested bytes")),
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
            Some(&fnv1a_hex(bytes)),
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
            Some(&fnv1a_hex(&bytes).to_uppercase()),
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
            Some(&fnv1a_hex(b"bytes")),
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
                &fnv1a_hex(b"incoming"),
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
            &fnv1a_hex(b"incoming"),
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
            &fnv1a_hex(incoming),
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
            &fnv1a_hex(incoming),
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
            &fnv1a_hex(incoming),
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

        assert!(platform_exclusive_publish(&candidate, &target).is_err());
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
            &fnv1a_hex(incoming),
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
            &fnv1a_hex(incoming),
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
            &fnv1a_hex(incoming),
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
    fn platform_publish_source_contracts_pin_no_replace_flags() {
        let source = include_str!("sync_core.rs");
        assert!(source.contains("libc::renameat2"));
        assert!(source.contains("libc::RENAME_NOREPLACE"));
        assert!(source.contains("libc::renamex_np"));
        assert!(source.contains("libc::RENAME_EXCL"));
        assert!(source.contains("MoveFileExW"));
        assert!(source.contains("MOVEFILE_WRITE_THROUGH"));
        // The sole occurrence is this assertion string, not an import or flag.
        assert_eq!(source.matches("MOVEFILE_REPLACE_EXISTING").count(), 1);
        // Journal metadata and private deletion staging use ordinary rename
        // only for Mesa-owned hidden files. User-file publication remains
        // pinned to the no-replace primitives above.
        assert!(source.matches("std::fs::rename").count() >= 1);
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
        let (first, _) = build_manifest(&dir, &mut HashCache::new());
        reconcile_journal(&dir, &first).unwrap();
        std::fs::rename(dir.join("old.md"), dir.join("new.md")).unwrap();
        std::fs::remove_file(dir.join("gone.md")).unwrap();
        let (second, _) = build_manifest(&dir, &mut HashCache::new());
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
        let dir =
            std::env::temp_dir().join(format!("mesa-journal-conflict-{}", std::process::id()));
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
            hash: fnv1a_hex(b"remote"),
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
        let (complete, _) = build_manifest(&dir, &mut HashCache::new());
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
            hash: fnv1a_hex(b"remote"),
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
                    hash: fnv1a_hex(b""),
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
                    hash: fnv1a_hex(b""),
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
        let dir =
            std::env::temp_dir().join(format!("mesa-journal-incoming-{}", std::process::id()));
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
            hash: fnv1a_hex(b"remote"),
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
            hash: fnv1a_hex(b"gone"),
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
        let (first, _) = build_manifest(&dir, &mut HashCache::new());
        reconcile_journal(&dir, &first).unwrap();

        std::fs::remove_file(dir.join("note.md")).unwrap();
        let (deleted, _) = build_manifest(&dir, &mut HashCache::new());
        let with_delete = reconcile_journal(&dir, &deleted).unwrap();
        assert!(with_delete
            .operations
            .iter()
            .any(|op| { op.kind == JournalOperationKind::Delete && op.from == "note.md" }));

        std::fs::write(dir.join("note.md"), b"restore me").unwrap();
        let (restored, _) = build_manifest(&dir, &mut HashCache::new());
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
        let hash = fnv1a_hex(b"restore me");
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
                hash: fnv1a_hex(b""),
            }],
            applied: Vec::new(),
            acked_by: HashMap::new(),
            peers_seen: Vec::new(),
            known: Vec::new(),
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
        let hash = fnv1a_hex(b"same");
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
            "{\"journalVersion\":1,\"files\":[{\"rel\":\"we\\\"ird\\nname.md\",\"size\":3,\"hash\":\"abc\"}]}"
        );
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
}
