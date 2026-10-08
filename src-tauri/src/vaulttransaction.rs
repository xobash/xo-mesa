//! Recoverable, reviewed multi-file writes. Durable intent precedes publication.
use crate::vaultwrite::{write_atomic, ExpectedCurrent, WRITE_LOCK};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

static ACCESS: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

// Readers may overlap; a research publication excludes Mesa sync/save/scan.
// On restart, recover under exclusive access before handing out a read lease.
pub async fn access(root: &Path) -> Result<tokio::sync::RwLockReadGuard<'static, ()>, String> {
    let guard = ACCESS.read().await;
    if !root.join(RECORD).try_exists().map_err(|e| e.to_string())? {
        return Ok(guard);
    }
    drop(guard);
    let guard = ACCESS.write().await;
    let owned_root = root.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || recover(&owned_root))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tokio::sync::RwLockWriteGuard::downgrade(guard))
}

pub fn require_recovered_target(path: &Path) -> Result<(), String> {
    for parent in path.ancestors().skip(1) {
        if parent
            .join(RECORD)
            .try_exists()
            .map_err(|e| e.to_string())?
        {
            return Err("Research recovery is pending. Reopen the vault before saving.".into());
        }
    }
    Ok(())
}

const RECORD: &str = ".mesa-research-transaction.json";
const LIMIT: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    rel_path: String,
    content: String,
    expected_content: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Entry {
    rel: String,
    #[serde(with = "hex_bytes_option")]
    before: Option<Vec<u8>>,
    #[serde(with = "hex_bytes")]
    after: Vec<u8>,
}

/// Record bytes as hex text: a 16 MiB entry stays near 32 MiB of JSON instead
/// of a number array several times larger. Records written as number arrays by
/// earlier versions still load.
mod hex_bytes {
    use serde::de::{self, SeqAccess, Visitor};
    use serde::{Deserializer, Serializer};
    use std::fmt;

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        let mut text = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            text.push_str(&format!("{byte:02x}"));
        }
        serializer.serialize_str(&text)
    }

    struct BytesVisitor;
    impl<'de> Visitor<'de> for BytesVisitor {
        type Value = Vec<u8>;
        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("hex text or a byte array")
        }
        fn visit_str<E: de::Error>(self, text: &str) -> Result<Vec<u8>, E> {
            let bytes = text.as_bytes();
            if !bytes.len().is_multiple_of(2) {
                return Err(E::custom("odd-length hex"));
            }
            bytes
                .chunks_exact(2)
                .map(|pair| {
                    let digit = |byte: u8| (byte as char).to_digit(16).map(|value| value as u8);
                    Some(digit(pair[0])? << 4 | digit(pair[1])?)
                })
                .collect::<Option<Vec<u8>>>()
                .ok_or_else(|| E::custom("invalid hex"))
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<u8>, A::Error> {
            let mut bytes = Vec::new();
            while let Some(byte) = seq.next_element::<u8>()? {
                bytes.push(byte);
            }
            Ok(bytes)
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        deserializer.deserialize_any(BytesVisitor)
    }
}

mod hex_bytes_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    #[derive(Serialize)]
    struct Hex<'a>(#[serde(with = "super::hex_bytes")] &'a Vec<u8>);
    #[derive(Deserialize)]
    struct Owned(#[serde(with = "super::hex_bytes")] Vec<u8>);

    pub fn serialize<S: Serializer>(
        bytes: &Option<Vec<u8>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        bytes.as_ref().map(Hex).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Vec<u8>>, D::Error> {
        Ok(Option::<Owned>::deserialize(deserializer)?.map(|owned| owned.0))
    }
}
#[derive(Serialize, Deserialize)]
struct Record {
    version: u32,
    committed: bool,
    entries: Vec<Entry>,
}

fn target(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel
        .split('/')
        .any(|s| s.is_empty() || s.starts_with('.') || s.contains('\\'))
    {
        return Err("unsafe research path".into());
    }
    let path = crate::sync_core::safe_join_confined(root, rel).ok_or("unsafe research path")?;
    if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err("research target is not a regular file".into());
    }
    Ok(path)
}
fn read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
        Ok(m) if !m.is_file() || m.file_type().is_symlink() || m.len() > LIMIT as u64 => {
            Err("research file is unsupported or too large".into())
        }
        Ok(_) => fs::read(path).map(Some).map_err(|e| e.to_string()),
    }
}
fn expected(bytes: Option<&[u8]>) -> ExpectedCurrent {
    match bytes {
        None => ExpectedCurrent::Missing,
        Some(bytes) => ExpectedCurrent::Hash {
            sha256: format!("{:x}", Sha256::digest(bytes)),
            size: bytes.len() as u64,
        },
    }
}
fn flush_folder(root: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = root;
    #[cfg(unix)]
    fs::File::open(root)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn flush_parents(root: &Path, target: &Path) -> Result<(), String> {
    let mut folder = target.parent().ok_or("research target has no parent")?;
    loop {
        if !folder.starts_with(root) {
            return Err("research parent escaped the vault".into());
        }
        flush_folder(folder)?;
        if folder == root {
            return Ok(());
        }
        folder = folder.parent().ok_or("research parent escaped the vault")?;
    }
}
fn save_record(root: &Path, record: &Record, first: bool) -> Result<(), String> {
    let bytes = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    let path = root.join(RECORD);
    write_atomic(
        &path,
        &bytes,
        &if first {
            ExpectedCurrent::Missing
        } else {
            ExpectedCurrent::Any
        },
    )
}
fn remove_record(root: &Path) -> Result<(), String> {
    fs::remove_file(root.join(RECORD)).map_err(|e| e.to_string())?;
    flush_folder(root)
}
fn validate(record: &Record) -> Result<(), String> {
    let mut paths = HashSet::new();
    let size: usize = record
        .entries
        .iter()
        .map(|e| e.after.len() + e.before.as_ref().map_or(0, Vec::len))
        .sum();
    if record.version != 1
        || record.entries.len() > 256
        || size > LIMIT
        || record.entries.iter().any(|e| !paths.insert(e.rel.clone()))
    {
        return Err("invalid research recovery record".into());
    }
    Ok(())
}
fn rollback(root: &Path, record: &Record) -> Result<(), String> {
    let mut failures = Vec::new();
    for (index, entry) in record.entries.iter().enumerate().rev() {
        let result = (|| {
            let path = target(root, &entry.rel)?;
            let current = read(&path)?;
            if current == entry.before {
                return Ok(());
            }
            if current.as_deref() != Some(entry.after.as_slice()) {
                return Err(format!("{} changed outside the transaction", entry.rel));
            }
            match &entry.before {
                Some(bytes) => write_atomic(&path, bytes, &expected(Some(&entry.after))),
                None => {
                    // Rename to hidden recovery storage instead of deleting authored
                    // bytes. Recheck immediately; external replacement stays intact.
                    let rescue = root.join(format!(
                        ".mesa-research-created-{:x}-{:x}.tmp",
                        crate::sync_core::now_ms(),
                        index
                    ));
                    crate::sync_core::move_file_no_replace(&path, &rescue)
                        .map_err(|e| e.to_string())?;
                    if read(&rescue)?.as_deref() != Some(entry.after.as_slice()) {
                        let _ = crate::sync_core::move_file_no_replace(&rescue, &path);
                        return Err(format!("{} changed during recovery", entry.rel));
                    }
                    // Make both the source unlink and rescued bytes durable.
                    flush_parents(root, &path)?;
                    flush_folder(root)
                }
            }
        })();
        if let Err(error) = result {
            failures.push(error);
        }
    }
    if failures.is_empty() {
        remove_record(root)
    } else {
        Err(format!(
            "Research recovery is pending: {}. The recovery record and originals were retained.",
            failures.join("; ")
        ))
    }
}
fn recover_unlocked(root: &Path) -> Result<(), String> {
    let path = root.join(RECORD);
    if !path.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    if fs::symlink_metadata(&path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Research recovery is pending: invalid record path".into());
    }
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    use std::io::Read;
    (&mut file)
        .take((LIMIT * 8 + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > LIMIT * 8 {
        return Err("Research recovery is pending: record exceeds limit".into());
    }
    let record: Record = serde_json::from_slice(&bytes)
        .map_err(|_| "Research recovery is pending: unreadable record")?;
    validate(&record)?;
    if record.committed {
        remove_record(root)
    } else {
        rollback(root, &record)
    }
}
pub fn recover(root: &Path) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    recover_unlocked(root).map_err(|e| format!("Research recovery is pending: {e}"))
}
fn apply(
    root: &Path,
    changes: Vec<Change>,
    stop_after: Option<usize>,
) -> Result<Vec<String>, String> {
    recover_unlocked(root)?;
    if changes.len() > 256
        || changes
            .iter()
            .try_fold(0usize, |n, c| {
                n.checked_add(c.content.len())?
                    .checked_add(c.expected_content.as_ref().map_or(0, String::len))
            })
            .is_none_or(|n| n > LIMIT)
    {
        return Err("research transaction exceeds limits".into());
    }
    let mut record = Record {
        version: 1,
        committed: false,
        entries: Vec::new(),
    };
    for change in changes {
        let path = target(root, &change.rel_path)?;
        let before = read(&path)?;
        if before.as_deref() != change.expected_content.as_ref().map(|s| s.as_bytes()) {
            return Err(format!("{} changed since review", change.rel_path));
        }
        record.entries.push(Entry {
            rel: change.rel_path,
            before,
            after: change.content.into_bytes(),
        });
    }
    validate(&record)?;
    if record.entries.is_empty() {
        return Ok(Vec::new());
    }
    save_record(root, &record, true)?;
    for (index, entry) in record.entries.iter().enumerate() {
        if stop_after == Some(index) {
            return Err("simulated interruption".into());
        }
        let result = (|| {
            let path = target(root, &entry.rel)?;
            crate::sync_core::ensure_real_parent(&path).map_err(|e| e.to_string())?;
            write_atomic(&path, &entry.after, &expected(entry.before.as_deref()))?;
            if read(&path)?.as_deref() != Some(entry.after.as_slice()) {
                return Err(format!(
                    "{} changed before research verification",
                    entry.rel
                ));
            }
            // The leaf write flushes its folder; also flush new ancestor
            // entries before the durable completion marker can discard intent.
            flush_parents(root, &path)
        })();
        if let Err(error) = result {
            return match rollback(root, &record) {
                Ok(()) => Err(format!("{error}. The original files were restored.")),
                Err(recovery) => Err(format!("{error}. {recovery}")),
            };
        }
    }
    if stop_after == Some(record.entries.len()) {
        return Err("simulated interruption".into());
    }
    record.committed = true;
    if let Err(error) = save_record(root, &record, false) {
        // Without durable completion, recovery must undo this transaction.
        record.committed = false;
        // A failed cleanup may leave the completed marker on disk. Publish
        // durable rollback intent before undoing any target. If that fails,
        // keep the complete file set and recovery record for the next open.
        if let Err(recovery) = save_record(root, &record, false) {
            return Err(format!("{error}. Research recovery is pending: {recovery}"));
        }
        return match rollback(root, &record) {
            Ok(()) => Err(format!("{error}. The original files were restored.")),
            Err(recovery) => Err(format!("{error}. {recovery}")),
        };
    }
    let paths = record.entries.iter().map(|e| e.rel.clone()).collect();
    // A committed record left after cleanup failure is harmless and retryable.
    let _ = remove_record(root);
    Ok(paths)
}
#[tauri::command]
pub async fn vault_apply_research(
    app: tauri::AppHandle,
    window: tauri::Window,
    root: String,
    changes: Vec<Change>,
) -> Result<Vec<String>, String> {
    if window.label() != "main" {
        return Err("research apply belongs to the main workspace".into());
    }
    let root = crate::vaultscope::require_approved(&app, &root)?;
    // Avoid queuing a writer behind an outgoing sync whose network requests
    // need this server to keep accepting readers. Applies and outgoing sync
    // reserve the same run slot before taking the access lease.
    let run = crate::sync::SyncRunGuard::acquire()?;
    let access = ACCESS.write().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _run = run;
        let _access = access;
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        apply(&root, changes, None)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn folder(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("mesa-research-{label}-{}", std::process::id()));
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
        let changes = vec![Change {
            rel_path: "reports/topic/new.md".into(),
            content: "reviewed content".into(),
            expected_content: None,
        }];
        assert!(apply(&root, changes, Some(1)).is_err());
        assert_eq!(
            fs::read(root.join("reports/topic/new.md")).unwrap(),
            b"reviewed content"
        );
        recover(&root).unwrap();
        assert!(!root.join("reports/topic/new.md").exists());
        assert!(!root.join(RECORD).exists());
        let rescued: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".mesa-research-created-")
            })
            .collect();
        assert_eq!(rescued.len(), 1);
        assert_eq!(fs::read(rescued[0].path()).unwrap(), b"reviewed content");
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
}
