use super::*;
#[test]
fn only_main_can_manage_credentials() {
    assert!(main_window_label_only("main").is_ok());
    for label in ["doc-1", "panel-1", "agent-1", "pi-harness", ""] {
        assert!(main_window_label_only(label).is_err());
    }
}
#[test]
fn renderer_responses_contain_only_references() {
    let saved = SyncSecrets {
        sync_token: "private-device-key".into(),
        peers: BTreeMap::from([("one".into(), "private-peer-key".into())]),
    };
    let output = serde_json::to_string(&references(&saved)).unwrap();
    assert!(!output.contains("private-"));
    assert!(output.contains(DEVICE));
    assert!(output.contains("credential:peer:one"));
    assert!(resolve_from(&saved, "private-device-key").is_err());
    assert_eq!(resolve_from(&saved, DEVICE).unwrap(), saved.sync_token);
    assert_eq!(
        resolve_from(&saved, "credential:peer:one").unwrap(),
        saved.peers["one"]
    );
    assert!(resolve_from(&saved, "credential:peer:missing").is_err());
}

use std::cell::{Cell, RefCell};

/// Credential store with Windows Credential Manager's blob limit and an
/// optional crash point: after `budget` writes or deletes, every later
/// write or delete fails, as if the process had stopped.
#[derive(Clone, Default)]
struct LimitedStore {
    entries: RefCell<BTreeMap<String, String>>,
    budget: Cell<Option<usize>>,
}
impl LimitedStore {
    fn spend(&self) -> Result<(), ()> {
        match self.budget.get() {
            Some(0) => Err(()),
            Some(n) => {
                self.budget.set(Some(n - 1));
                Ok(())
            }
            None => Ok(()),
        }
    }
}
impl CredentialStore for LimitedStore {
    fn get(&self, account: &str) -> Result<Option<String>, ()> {
        Ok(self.entries.borrow().get(account).cloned())
    }
    fn set(&self, account: &str, value: &str) -> Result<(), ()> {
        self.spend()?;
        if value.encode_utf16().count() * 2 > WINDOWS_BLOB_BYTES {
            return Err(());
        }
        self.entries
            .borrow_mut()
            .insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), ()> {
        self.spend()?;
        self.entries.borrow_mut().remove(account);
        Ok(())
    }
}
const WINDOWS: Layout = Layout::Chunked {
    max_utf16_units: WINDOWS_BLOB_BYTES / 2,
};
fn hex(seed: usize, salt: &str) -> String {
    crate::hex::sha256_hex(format!("{salt}{seed}").as_bytes())
}
fn secrets(peers: usize, salt: &str) -> SyncSecrets {
    SyncSecrets {
        sync_token: hex(0, salt),
        peers: (0..peers)
            .map(|i| (hex(i, "fingerprint"), hex(i, salt)))
            .collect(),
    }
}

#[test]
fn the_single_entry_record_exceeds_the_windows_blob_limit() {
    let store = LimitedStore::default();
    assert!(save_to(&store, Layout::Single, &secrets(8, "k")).is_ok());
    assert!(save_to(&store, Layout::Single, &secrets(50, "k")).is_err());
}

#[test]
fn chunked_record_round_trips_fifty_peers_under_the_windows_limit() {
    let store = LimitedStore::default();
    let fifty = secrets(50, "k");
    save_to(&store, WINDOWS, &fifty).unwrap();
    assert!(load_from(&store, WINDOWS).unwrap() == fifty);
    for peer in fifty.peers.keys() {
        let reference = format!("{PEER}{peer}");
        assert_eq!(
            resolve_from(&load_from(&store, WINDOWS).unwrap(), &reference).unwrap(),
            fifty.peers[peer]
        );
    }
    let most = secrets(256, "k");
    save_to(&store, WINDOWS, &most).unwrap();
    assert!(load_from(&store, WINDOWS).unwrap() == most);
    // Shrinking leaves only the index and the active slot's chunks.
    let three = secrets(3, "j");
    save_to(&store, WINDOWS, &three).unwrap();
    assert!(load_from(&store, WINDOWS).unwrap() == three);
    let index = read_index(&store).unwrap().unwrap();
    let mut expected: Vec<String> = (0..index.chunks)
        .map(|chunk| chunk_account(&index.slot, chunk))
        .collect();
    expected.push(INDEX.into());
    expected.sort();
    let names: Vec<String> = store.entries.borrow().keys().cloned().collect();
    assert_eq!(names, expected);
}

#[test]
fn chunked_layout_migrates_the_single_entry_record() {
    let store = LimitedStore::default();
    let old = secrets(5, "old");
    save_to(&store, Layout::Single, &old).unwrap();
    assert!(load_from(&store, WINDOWS).unwrap() == old);
    let new = secrets(40, "new");
    save_to(&store, WINDOWS, &new).unwrap();
    assert!(store.get(ACCOUNT).unwrap().is_none());
    assert!(load_from(&store, WINDOWS).unwrap() == new);
}

#[test]
fn interrupted_saves_leave_the_previous_or_new_record_readable() {
    let old = secrets(6, "old");
    let new = secrets(50, "new");
    // Start from a single entry, from a chunked record that already moved
    // slots once, and from a newer single entry beside a chunked record.
    for start in 0..3 {
        let initial = LimitedStore::default();
        match start {
            0 => save_to(&initial, Layout::Single, &old).unwrap(),
            1 => {
                save_to(&initial, WINDOWS, &old).unwrap();
                save_to(&initial, WINDOWS, &old).unwrap();
            }
            _ => {
                save_to(&initial, WINDOWS, &secrets(9, "older")).unwrap();
                save_to(&initial, Layout::Single, &old).unwrap();
            }
        }
        assert!(load_from(&initial, WINDOWS).unwrap() == old);
        let mut completed = false;
        for crash_after in 0.. {
            let store = initial.clone();
            store.budget.set(Some(crash_after));
            let result = save_to(&store, WINDOWS, &new);
            store.budget.set(None);
            let after = load_from(&store, WINDOWS)
                .unwrap_or_else(|e| panic!("crash after {crash_after} lost keys: {e}"));
            assert!(after == old || after == new, "crash after {crash_after}");
            // The next save repairs any interrupted layout.
            save_to(&store, WINDOWS, &secrets(2, "next")).unwrap();
            assert!(load_from(&store, WINDOWS).unwrap() == secrets(2, "next"));
            assert_eq!(store.entries.borrow().len(), 2, "crash after {crash_after}");
            if result.is_ok() {
                assert!(after == new);
                completed = true;
                break;
            }
        }
        assert!(completed);
    }
}

#[test]
fn a_damaged_chunk_fails_closed() {
    let store = LimitedStore::default();
    save_to(&store, WINDOWS, &secrets(20, "k")).unwrap();
    let account = chunk_account("a", 1);
    let damaged = store.get(&account).unwrap().unwrap().replacen('a', "b", 1);
    store.set(&account, &damaged).unwrap();
    assert!(load_from(&store, WINDOWS).is_err());
    store.delete(&account).unwrap();
    assert!(load_from(&store, WINDOWS).is_err());
}

#[test]
fn a_damaged_record_names_the_reset_and_only_the_reset_recovers() {
    assert!(DAMAGED.starts_with("Saved sync keys are damaged"));
    let store = LimitedStore::default();
    save_to(&store, WINDOWS, &secrets(30, "k")).unwrap();
    store.delete(&chunk_account("a", 1)).unwrap();
    assert_eq!(load_from(&store, WINDOWS).err().as_deref(), Some(DAMAGED));
    // Ordinary saves keep failing closed; nothing resets on its own.
    assert_eq!(load_from(&store, WINDOWS).err().as_deref(), Some(DAMAGED));
    assert!(store.get(INDEX).unwrap().is_some());
    // Leftovers of both slots and a single entry are all cleared.
    store.set(&chunk_account("b", 7), "stale").unwrap();
    store.set(ACCOUNT, "{damaged").unwrap();
    let fresh = secrets(0, "fresh");
    reset_to(&store, WINDOWS, &fresh).unwrap();
    assert!(load_from(&store, WINDOWS).unwrap() == fresh);
    let names: Vec<String> = store.entries.borrow().keys().cloned().collect();
    assert_eq!(names, vec![chunk_account("a", 0), INDEX.to_string()]);
    // The single-entry layout recovers the same way.
    let single = LimitedStore::default();
    single.set(ACCOUNT, "{damaged").unwrap();
    assert_eq!(
        load_from(&single, Layout::Single).err().as_deref(),
        Some(DAMAGED)
    );
    reset_to(&single, Layout::Single, &fresh).unwrap();
    assert!(load_from(&single, Layout::Single).unwrap() == fresh);
}

#[test]
fn a_single_entry_written_after_migration_wins_until_the_next_save() {
    let store = LimitedStore::default();
    let before = secrets(4, "before");
    save_to(&store, Layout::Single, &before).unwrap();
    let migrated = secrets(20, "migrated");
    save_to(&store, WINDOWS, &migrated).unwrap();
    // A leftover copy of the replaced entry (interrupted cleanup) is stale.
    store
        .set(ACCOUNT, &serde_json::to_string(&before).unwrap())
        .unwrap();
    assert!(load_from(&store, WINDOWS).unwrap() == migrated);
    // An earlier build, after a downgrade, saves a re-paired record.
    let repaired = secrets(3, "repaired");
    save_to(&store, Layout::Single, &repaired).unwrap();
    assert!(load_from(&store, WINDOWS).unwrap() == repaired);
    // The upgraded build moves it into the chunked layout again.
    let next = secrets(12, "next");
    save_to(&store, WINDOWS, &next).unwrap();
    assert!(store.get(ACCOUNT).unwrap().is_none());
    assert!(load_from(&store, WINDOWS).unwrap() == next);
}

#[test]
fn chunks_respect_utf16_units() {
    let value = "a\u{1F600}".repeat(1000);
    let chunks = split_utf16(&value, 1280);
    assert_eq!(chunks.concat(), value);
    assert!(chunks.iter().all(|c| c.encode_utf16().count() <= 1280));
}
