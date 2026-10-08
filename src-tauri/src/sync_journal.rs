//! Durable operation journal, peer acknowledgements and conflict-preserving reconciliation.
use super::*;

/// Hidden, vault-local state for delete/rename replication.  It is deliberately
/// outside the normal manifest: syncing the journal as an ordinary vault file
/// would make it visible to users and let one device overwrite another's log.
pub const JOURNAL_FILE: &str = ".mesa-sync-journal.json";
pub const JOURNAL_VERSION: u32 = 2;
pub const SYNC_PROTOCOL_VERSION: u32 = 3;
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
    /// Last content known to be identical on this device and each TLS peer.
    /// Kept locally; a peer cannot declare the base used for a replacement.
    #[serde(default)]
    pub peer_bases: HashMap<String, Vec<JournalEntry>>,
    #[serde(default, deserialize_with = "deserialize_peer_bindings")]
    pub peer_bindings: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub retired_peers: Vec<String>,
    #[serde(default)]
    pub retired_fingerprints: Vec<String>,
}

pub(super) fn deserialize_peer_bindings<'de, D: serde::Deserializer<'de>>(
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
    pub(super) fn empty(device: String) -> Self {
        Self {
            version: JOURNAL_VERSION,
            device,
            next_sequence: 1,
            operations: Vec::new(),
            applied: Vec::new(),
            acked_by: HashMap::new(),
            peers_seen: Vec::new(),
            known: Vec::new(),
            peer_bases: HashMap::new(),
            peer_bindings: HashMap::new(),
            retired_peers: Vec::new(),
            retired_fingerprints: Vec::new(),
        }
    }
}

pub(super) fn journal_path(root: &Path) -> PathBuf {
    root.join(JOURNAL_FILE)
}

pub(super) fn journal_device(root: &Path) -> String {
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

pub(super) fn journal_mutex() -> &'static Mutex<()> {
    static JOURNAL_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();
    JOURNAL_MUTEX.get_or_init(|| Mutex::new(()))
}

pub(super) fn journal_guard() -> std::io::Result<MutexGuard<'static, ()>> {
    journal_mutex()
        .lock()
        .map_err(|_| std::io::Error::other("sync journal coordinator poisoned"))
}

pub(super) fn load_journal_unlocked(root: &Path) -> std::io::Result<SyncJournal> {
    #[cfg(windows)]
    let _root_guard = WindowsParentGuard::acquire(&root.join(JOURNAL_FILE), false)?;
    let path = journal_path(root);
    let body = match open_file_no_follow(&path) {
        Ok(mut file) => {
            let mut body = Vec::new();
            file.read_to_end(&mut body)?;
            body
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SyncJournal::empty(journal_device(root)));
        }
        Err(error) => return Err(error),
    };
    let mut journal: SyncJournal = serde_json::from_slice(&body).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid Mesa sync journal: {error}"),
        )
    })?;
    if journal.version == 1 {
        migrate_legacy_journal(root, &mut journal)?;
        save_journal_unlocked(root, &journal)?;
    }
    validate_journal(&journal, "Mesa sync journal")?;
    Ok(journal)
}

// Only local version-one records need this compatibility digest. It never
// accepts peer content or guards a version-two filesystem operation.
pub(super) fn legacy_fingerprint(path: &Path) -> std::io::Result<(u64, String, String)> {
    let mut file = open_file_no_follow(path)?;
    let mut weak = 0xcbf2_9ce4_8422_2325u64;
    let mut strong = ContentHasher::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut size = 0;
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        strong.update(&buffer[..n]);
        for byte in &buffer[..n] {
            weak ^= *byte as u64;
            weak = weak.wrapping_mul(0x0000_0100_0000_01b3);
        }
        size += n as u64;
    }
    Ok((size, format!("{weak:016x}"), strong.hex()))
}
pub(super) fn migrated_hash(
    root: &Path,
    rels: &[&str],
    size: u64,
    hash: &str,
) -> std::io::Result<String> {
    for rel in rels {
        let Some(path) = safe_join_confined(root, rel) else {
            continue;
        };
        let mut candidates = vec![path.clone()];
        if let Some(parent) = path.parent() {
            if let Ok(items) = std::fs::read_dir(parent.join(".mesa-trash")) {
                candidates.extend(items.filter_map(Result::ok).map(|e| e.path()));
            }
        }
        for candidate in candidates {
            if std::fs::symlink_metadata(&candidate)
                .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
            {
                if let Ok((length, old, new)) = legacy_fingerprint(&candidate) {
                    if length == size && old.eq_ignore_ascii_case(hash) {
                        return Ok(new);
                    }
                }
            }
        }
    }
    Err(invalid_data("Sync journal upgrade needs original bytes that are no longer available. The old journal is retained; restore its recovery files before retrying."))
}
pub(super) fn migrate_legacy_journal(
    root: &Path,
    journal: &mut SyncJournal,
) -> std::io::Result<()> {
    // Upgrade every destructive guard before changing the durable record.
    // An unavailable original fails closed instead of weakening its guard.
    for op in &mut journal.operations {
        let mut rels = vec![op.from.as_str()];
        if let Some(to) = &op.to {
            rels.push(to);
        }
        op.hash = migrated_hash(root, &rels, op.size, &op.hash)?;
    }
    let old_known = std::mem::take(&mut journal.known);
    for entry in old_known {
        let path = safe_join_confined(root, &entry.rel)
            .ok_or_else(|| invalid_data("unsafe old journal path"))?;
        if !path.exists() {
            if !journal.operations.iter().any(|op| op.from == entry.rel) {
                let hash = migrated_hash(root, &[&entry.rel], entry.size, &entry.hash)?;
                append_operation(
                    journal,
                    JournalOperationKind::Delete,
                    entry.rel,
                    None,
                    entry.size,
                    hash,
                );
            }
            continue;
        }
        let (size, hash) = hash_file_streaming(&path)?;
        journal.known.push(JournalEntry {
            rel: entry.rel,
            size,
            hash,
        });
    }
    // Old common versions cannot authorize strong-hash replacement; establish
    // them again through a complete new exchange (divergence keeps both files).
    journal.peer_bases.clear();
    journal.version = JOURNAL_VERSION;
    validate_journal(journal, "upgraded Mesa sync journal")
}

pub(super) fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
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

pub fn peer_baseline(root: &Path, fingerprint: &str) -> std::io::Result<Vec<JournalEntry>> {
    Ok(load_journal(root)?
        .peer_bases
        .remove(fingerprint)
        .unwrap_or_default())
}

pub fn save_peer_baseline(
    root: &Path,
    fingerprint: &str,
    common: Vec<JournalEntry>,
) -> std::io::Result<()> {
    let _guard = journal_guard()?;
    let mut journal = load_journal_unlocked(root)?;
    journal.peer_bases.insert(fingerprint.to_string(), common);
    save_journal_unlocked(root, &journal)?;
    Ok(())
}

/// The baseline is local crash-reconstruction state, not peer intent. Omitting
/// it keeps a 12,000-file idle journal small without weakening reconciliation.
pub fn journal_wire_bytes(journal: &SyncJournal) -> std::io::Result<Vec<u8>> {
    let mut wire = journal.clone();
    wire.known.clear();
    wire.peer_bases.clear();
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
pub(super) fn retire_journal_peer(root: &Path, fingerprint: &str) -> std::io::Result<()> {
    retire_journal_peers(root, &[fingerprint.to_string()])
}

const MAX_APPLIED_IDS: usize = 8192;
const MAX_ACKED_IDS_PER_PEER: usize = 8192;

pub(super) fn push_unique(list: &mut Vec<String>, value: impl Into<String>) {
    let value = value.into();
    if !value.is_empty() && !list.iter().any(|item| item == &value) {
        list.push(value);
    }
}

pub(super) fn dedupe_ordered(list: &mut Vec<String>) {
    let mut seen = HashSet::new();
    list.retain(|value| !value.is_empty() && seen.insert(value.clone()));
}

pub(super) fn retain_recent_or_live(
    list: &mut Vec<String>,
    live_ids: &HashSet<String>,
    max: usize,
) {
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

pub(super) fn sort_journal_operations(journal: &mut SyncJournal) {
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

pub(super) fn note_peer_seen(journal: &mut SyncJournal, device: &str) {
    if !device.is_empty()
        && device != journal.device
        && !journal.retired_peers.iter().any(|peer| peer == device)
    {
        push_unique(&mut journal.peers_seen, device.to_string());
    }
}

pub(super) fn merge_remote_into(
    local: &mut SyncJournal,
    remote: &SyncJournal,
) -> std::io::Result<()> {
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

pub(super) fn operation_acked_by(
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

pub(super) fn compact_journal(journal: &mut SyncJournal) {
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

pub(super) fn save_journal_unlocked(
    root: &Path,
    journal: &SyncJournal,
) -> std::io::Result<SyncJournal> {
    #[cfg(windows)]
    let _root_guard = WindowsParentGuard::acquire(&root.join(JOURNAL_FILE), false)?;
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

pub(super) fn append_operation(
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

#[cfg(not(unix))]
pub(super) fn move_no_replace(
    from: &Path,
    to: &Path,
    size: u64,
    hash: &str,
) -> std::io::Result<()> {
    #[cfg(windows)]
    let _source_parents = WindowsParentGuard::acquire(from, false)?;
    #[cfg(windows)]
    let _target_parents = WindowsParentGuard::acquire(to, true)?;
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
    #[cfg(unix)]
    {
        apply_journal_operation_rooted(root, op)
    }
    #[cfg(not(unix))]
    {
        let from = safe_join_confined(root, &op.from)
            .ok_or_else(|| invalid_data("unsafe journal source"))?;
        #[cfg(windows)]
        let _source_parents = WindowsParentGuard::acquire(&from, true)?;
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
                    #[cfg(windows)]
                    let _trash_parents =
                        WindowsParentGuard::acquire(&trash.join("candidate"), true)?;
                    std::fs::create_dir_all(&trash)?;
                    let original = from
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("file");
                    // The double separator makes the remote provenance marker
                    // unambiguous to the frontend recovery parser while retaining
                    // the exact original filename for restore.
                    let tomb = trash.join(format!("{}-remote--{}", now_ms(), original));
                    move_file_no_replace(&from, &tomb)?;
                    let moved = hash_file_streaming(&tomb)?;
                    if !fingerprint_matches(&moved, op.size, &op.hash) {
                        // Do not strand changed bytes in an invisible artifact.
                        // Restore the visible source when possible; if a racing
                        // writer occupied it, preserve the verified recovery copy
                        // and report a conflict instead of overwriting that writer.
                        if !from.exists() {
                            let _ = move_file_no_replace(&tomb, &from);
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
                #[cfg(windows)]
                let _target_parents = WindowsParentGuard::acquire(&to, true)?;
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
                    #[cfg(windows)]
                    let _trash_parents =
                        WindowsParentGuard::acquire(&trash.join("candidate"), true)?;
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
                            hash_file_streaming(path).ok().is_some_and(|actual| {
                                fingerprint_matches(&actual, op.size, &op.hash)
                            })
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
}

#[cfg(unix)]
pub(super) fn apply_journal_operation_rooted(
    root: &Path,
    op: &JournalOperation,
) -> std::io::Result<JournalApply> {
    let from = match RootedTarget::resolve(root, &op.from, false) {
        Ok(path) => Some(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let from_hash = match &from {
        Some(path) => match path.fingerprint(&path.name) {
            Ok(hash) => Some(hash),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        },
        None => None,
    };
    match op.kind {
        JournalOperationKind::Delete => {
            let Some(actual) = from_hash else {
                return Ok(JournalApply::AlreadyApplied);
            };
            if !fingerprint_matches(&actual, op.size, &op.hash) {
                return Ok(JournalApply::Conflict);
            }
            let from = from.ok_or_else(|| invalid_data("journal source vanished"))?;
            let (parent, name) = op.from.rsplit_once('/').unwrap_or(("", op.from.as_str()));
            let tomb_rel = format!(
                "{}{}.mesa-trash/{}-remote--{}",
                if parent.is_empty() { "" } else { parent },
                if parent.is_empty() { "" } else { "/" },
                now_ms(),
                name
            );
            let tomb = RootedTarget::resolve(root, &tomb_rel, true)?;
            match from.move_no_replace(&tomb, op.size, &op.hash) {
                Ok(()) => Ok(JournalApply::Applied),
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                    if let Ok(actual) = tomb.fingerprint(&tomb.name) {
                        let _ = tomb.move_no_replace(&from, actual.0, &actual.1);
                    }
                    Ok(JournalApply::Conflict)
                }
                Err(error) => Err(error),
            }
        }
        JournalOperationKind::Rename => {
            let to_rel = op
                .to
                .as_deref()
                .ok_or_else(|| invalid_data("rename journal entry missing destination"))?;
            let to = RootedTarget::resolve(root, to_rel, true)?;
            let to_hash = match to.fingerprint(&to.name) {
                Ok(hash) => Some(hash),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error),
            };
            match (from_hash, to_hash) {
                (None, Some(target)) if fingerprint_matches(&target, op.size, &op.hash) => {
                    Ok(JournalApply::AlreadyApplied)
                }
                (Some(source), None) if fingerprint_matches(&source, op.size, &op.hash) => {
                    from.ok_or_else(|| invalid_data("journal source vanished"))?
                        .move_no_replace(&to, op.size, &op.hash)?;
                    Ok(JournalApply::Applied)
                }
                (Some(source), Some(target))
                    if fingerprint_matches(&source, op.size, &op.hash)
                        && fingerprint_matches(&target, op.size, &op.hash) =>
                {
                    let from = from.ok_or_else(|| invalid_data("journal source vanished"))?;
                    from.unlink(&from.name)?;
                    Ok(JournalApply::AlreadyApplied)
                }
                _ => Ok(JournalApply::Conflict),
            }
        }
        JournalOperationKind::Restore => {
            if let Some(actual) = from_hash {
                return Ok(if fingerprint_matches(&actual, op.size, &op.hash) {
                    JournalApply::AlreadyApplied
                } else {
                    JournalApply::Conflict
                });
            }
            let from = RootedTarget::resolve(root, &op.from, true)?;
            let (parent, name) = op.from.rsplit_once('/').unwrap_or(("", op.from.as_str()));
            let probe_rel = format!(
                "{}{}.mesa-trash/_",
                if parent.is_empty() { "" } else { parent },
                if parent.is_empty() { "" } else { "/" }
            );
            let trash = match RootedTarget::resolve(root, &probe_rel, false) {
                Ok(path) => path,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(JournalApply::Conflict)
                }
                Err(error) => return Err(error),
            };
            for candidate_name in trash.list_parent_names()? {
                if !candidate_name.ends_with(&format!("--{name}")) {
                    continue;
                }
                let candidate = trash.child(&candidate_name)?;
                if candidate
                    .fingerprint(&candidate.name)
                    .ok()
                    .is_some_and(|actual| fingerprint_matches(&actual, op.size, &op.hash))
                {
                    candidate.move_no_replace(&from, op.size, &op.hash)?;
                    return Ok(JournalApply::Applied);
                }
            }
            Ok(JournalApply::Conflict)
        }
    }
}
