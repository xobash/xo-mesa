//! OS credentials stay native. Renderers hold references, not reusable network keys.
use keyring::{Entry, Error};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
};
const SERVICE: &str = "dev.xo.mesa.sync";
const ACCOUNT: &str = "device-and-peer-keys";
const DEVICE: &str = "credential:device";
const PEER: &str = "credential:peer:";
#[derive(Clone, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncSecrets {
    sync_token: String,
    peers: BTreeMap<String, String>,
}
static LOCK: Mutex<()> = Mutex::new(());
fn temporary() -> &'static Mutex<BTreeMap<String, String>> {
    static STORE: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}
fn main_window_label_only(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("sync credentials belong to the main workspace".into())
    }
}
/// One credential-store operation surface, so the record layout is testable
/// against a store with the Windows size limit.
trait CredentialStore {
    fn get(&self, account: &str) -> Result<Option<String>, ()>;
    fn set(&self, account: &str, value: &str) -> Result<(), ()>;
    /// A missing entry is not an error.
    fn delete(&self, account: &str) -> Result<(), ()>;
}
struct OsStore;
impl CredentialStore for OsStore {
    fn get(&self, account: &str) -> Result<Option<String>, ()> {
        match Entry::new(SERVICE, account).map_err(|_| ())?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(Error::NoEntry) => Ok(None),
            Err(_) => Err(()),
        }
    }
    fn set(&self, account: &str, value: &str) -> Result<(), ()> {
        Entry::new(SERVICE, account)
            .map_err(|_| ())?
            .set_password(value)
            .map_err(|_| ())
    }
    fn delete(&self, account: &str) -> Result<(), ()> {
        match Entry::new(SERVICE, account)
            .map_err(|_| ())?
            .delete_credential()
        {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
}
/// How the record maps onto credential-store entries.
///
/// `Single` keeps the whole record in `ACCOUNT`: one keychain item however
/// many peers, so pairing never adds macOS Keychain prompts. `Chunked` exists for Windows
/// Credential Manager, which refuses a blob over 2,560 bytes of UTF-16
/// (`CRED_MAX_CREDENTIAL_BLOB_SIZE`, about eight peers in one record). Chunks
/// live in two alternating slots; one small index entry names the complete
/// slot and its SHA-256, so a crash at any point leaves the previous record or
/// the new one readable, never a mix.
#[derive(Clone, Copy)]
enum Layout {
    // Production builds construct `Single` everywhere except Windows and
    // `Chunked` only on Windows; tests use both everywhere.
    #[cfg_attr(windows, allow(dead_code))]
    Single,
    #[cfg_attr(not(windows), allow(dead_code))]
    Chunked { max_utf16_units: usize },
}
#[cfg(windows)]
const PLATFORM_LAYOUT: Layout = Layout::Chunked {
    max_utf16_units: WINDOWS_BLOB_BYTES / 2,
};
#[cfg(not(windows))]
const PLATFORM_LAYOUT: Layout = Layout::Single;
#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_BLOB_BYTES: usize = 2560;
const MAX_RECORD_BYTES: usize = 65_536;
// 65,536 UTF-8 bytes never need more than 53 chunks of 1,280 UTF-16 units.
const MAX_CHUNKS: usize = 64;
const INDEX: &str = "device-and-peer-keys.index";
const SLOTS: [&str; 2] = ["a", "b"];
#[derive(Deserialize, Serialize, PartialEq)]
struct ChunkIndex {
    slot: String,
    chunks: usize,
    sha256: String,
    /// SHA-256 of the single-entry record this index replaced. A single entry
    /// with any other content was written later, by an earlier Mesa build
    /// after a downgrade, and is newer than this index.
    #[serde(default)]
    superseded: Option<String>,
}
fn chunk_account(slot: &str, chunk: usize) -> String {
    format!("{ACCOUNT}.{slot}.{chunk}")
}
fn split_utf16(value: &str, max_units: usize) -> Vec<String> {
    let mut chunks = vec![String::new()];
    let mut units = 0;
    for ch in value.chars() {
        if units + ch.len_utf16() > max_units {
            chunks.push(String::new());
            units = 0;
        }
        units += ch.len_utf16();
        chunks.last_mut().expect("one chunk").push(ch);
    }
    chunks
}
const READ_FAILED: &str = "credential store could not read sync keys";
/// Reads fail closed on damage; recovery is the explicit reset in Sync. The
/// renderer recognizes the first sentence (`SYNC_KEYS_DAMAGED` in syncSecrets.ts).
const DAMAGED: &str = "Saved sync keys are damaged or incomplete, so Mesa will not use them. Choose Reset sync keys in Sync to start over. Every paired device must then pair again with the new key.";
const SAVE_FAILED: &str = "credential store could not save keys";
fn parse_record(value: &str) -> Result<SyncSecrets, String> {
    if value.len() > MAX_RECORD_BYTES {
        return Err(DAMAGED.into());
    }
    serde_json::from_str(value).map_err(|_| DAMAGED.into())
}
fn read_index(store: &dyn CredentialStore) -> Result<Option<ChunkIndex>, String> {
    match store.get(INDEX).map_err(|_| READ_FAILED)? {
        None => Ok(None),
        Some(value) => match serde_json::from_str::<ChunkIndex>(&value) {
            Ok(index) if SLOTS.contains(&index.slot.as_str()) && index.chunks <= MAX_CHUNKS => {
                Ok(Some(index))
            }
            _ => Err(DAMAGED.into()),
        },
    }
}
fn read_chunks(store: &dyn CredentialStore, index: &ChunkIndex) -> Result<String, String> {
    let mut value = String::new();
    for chunk in 0..index.chunks {
        let part = store
            .get(&chunk_account(&index.slot, chunk))
            .map_err(|_| READ_FAILED)?
            .ok_or(DAMAGED)?;
        value.push_str(&part);
        if value.len() > MAX_RECORD_BYTES {
            return Err(DAMAGED.into());
        }
    }
    if crate::hex::sha256_hex(value.as_bytes()) != index.sha256 {
        return Err(DAMAGED.into());
    }
    Ok(value)
}
fn read_legacy(store: &dyn CredentialStore) -> Result<Option<String>, String> {
    store.get(ACCOUNT).map_err(|_| READ_FAILED.into())
}
fn load_from(store: &dyn CredentialStore, layout: Layout) -> Result<SyncSecrets, String> {
    let legacy = read_legacy(store)?;
    if let Layout::Chunked { .. } = layout {
        // The index is published only after its slot is complete; without one,
        // the single-entry record (written before this layout) is current. A
        // single entry the index did not replace is newer still: the next
        // save moves it into the chunked layout again.
        if let Some(index) = read_index(store)? {
            let newer = legacy
                .as_deref()
                .filter(|value| Some(crate::hex::sha256_hex(value.as_bytes())) != index.superseded);
            if newer.is_none() {
                return parse_record(&read_chunks(store, &index)?);
            }
        }
    }
    legacy.map_or_else(|| Ok(SyncSecrets::default()), |value| parse_record(&value))
}
fn save_to(store: &dyn CredentialStore, layout: Layout, saved: &SyncSecrets) -> Result<(), String> {
    let value = serde_json::to_string(saved).map_err(|_| "invalid credentials")?;
    if value.len() > MAX_RECORD_BYTES {
        return Err("credentials exceed supported size".into());
    }
    let Layout::Chunked { max_utf16_units } = layout else {
        return store.set(ACCOUNT, &value).map_err(|_| SAVE_FAILED.into());
    };
    let previous = read_index(store)?;
    let superseded = read_legacy(store)?.map(|value| crate::hex::sha256_hex(value.as_bytes()));
    let slot = match &previous {
        Some(index) if index.slot == SLOTS[0] => SLOTS[1],
        _ => SLOTS[0],
    };
    let chunks = split_utf16(&value, max_utf16_units);
    if chunks.len() > MAX_CHUNKS {
        return Err("credentials exceed supported size".into());
    }
    // Write and verify the inactive slot; the current index still names the
    // previous complete record until the new index replaces it.
    for (chunk, part) in chunks.iter().enumerate() {
        store
            .set(&chunk_account(slot, chunk), part)
            .map_err(|_| SAVE_FAILED)?;
    }
    // A crash can interrupt an earlier write or cleanup anywhere, so clear the
    // whole tail of this slot rather than stopping at the first gap.
    for stale in chunks.len()..MAX_CHUNKS {
        store
            .delete(&chunk_account(slot, stale))
            .map_err(|_| SAVE_FAILED)?;
    }
    let index = ChunkIndex {
        slot: slot.into(),
        chunks: chunks.len(),
        sha256: crate::hex::sha256_hex(value.as_bytes()),
        superseded,
    };
    if read_chunks(store, &index).ok().as_deref() != Some(value.as_str()) {
        return Err(SAVE_FAILED.into());
    }
    store
        .set(
            INDEX,
            &serde_json::to_string(&index).map_err(|_| "invalid credentials")?,
        )
        .map_err(|_| SAVE_FAILED)?;
    if read_index(store).ok().flatten().as_ref() != Some(&index) {
        return Err(SAVE_FAILED.into());
    }
    // The new record is published and verified. Removing the superseded
    // entries is best-effort: reads never consult them while the index exists.
    if let Some(old) = previous.filter(|old| old.slot != slot) {
        for chunk in 0..old.chunks {
            let _ = store.delete(&chunk_account(&old.slot, chunk));
        }
    }
    let _ = store.delete(ACCOUNT);
    Ok(())
}
/// Explicit recovery from a damaged record: remove every entry of either
/// layout, then save `fresh`. Only the user's confirmed reset calls this.
fn reset_to(
    store: &dyn CredentialStore,
    layout: Layout,
    fresh: &SyncSecrets,
) -> Result<(), String> {
    if let Layout::Chunked { .. } = layout {
        // The index goes first, so an interrupted reset never names a slot
        // that is being cleared.
        store.delete(INDEX).map_err(|_| SAVE_FAILED)?;
        for slot in SLOTS {
            for chunk in 0..MAX_CHUNKS {
                store
                    .delete(&chunk_account(slot, chunk))
                    .map_err(|_| SAVE_FAILED)?;
            }
        }
        store.delete(ACCOUNT).map_err(|_| SAVE_FAILED)?;
    }
    save_to(store, layout, fresh)
}
fn random_key() -> Result<String, String> {
    Ok(crate::hex::random_hex::<32>().ok_or("secure random source unavailable")?)
}
fn load() -> Result<SyncSecrets, String> {
    load_from(&OsStore, PLATFORM_LAYOUT)
}
fn references(saved: &SyncSecrets) -> SyncSecrets {
    SyncSecrets {
        sync_token: if saved.sync_token.is_empty() {
            String::new()
        } else {
            DEVICE.into()
        },
        peers: saved
            .peers
            .iter()
            .filter(|(_, key)| !key.is_empty())
            .map(|(id, _)| (id.clone(), format!("{PEER}{id}")))
            .collect(),
    }
}
fn resolve_from(saved: &SyncSecrets, reference: &str) -> Result<String, String> {
    if reference == DEVICE {
        return Ok(saved.sync_token.clone());
    }
    if let Some(id) = reference.strip_prefix(PEER) {
        return saved
            .peers
            .get(id)
            .cloned()
            .ok_or("peer credential is missing".into());
    }
    temporary()
        .lock()
        .map_err(|_| "credential state unavailable")?
        .get(reference)
        .cloned()
        .ok_or("sync requires a native credential reference".into())
}
pub(crate) fn resolve(reference: &str) -> Result<String, String> {
    let _lock = LOCK.lock().map_err(|_| "credential state unavailable")?;
    resolve_from(&load()?, reference)
}
pub(crate) async fn resolve_async(reference: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || resolve(&reference))
        .await
        .map_err(|_| "credential task failed")?
}
fn store(input: SyncSecrets) -> Result<SyncSecrets, String> {
    let old = load()?;
    let expand = |key: String| {
        if key.starts_with("credential:") {
            resolve_from(&old, &key)
        } else {
            Ok(key)
        }
    };
    let saved = SyncSecrets {
        sync_token: expand(input.sync_token)?,
        peers: input
            .peers
            .into_iter()
            .map(|(id, key)| Ok((id, expand(key)?)))
            .collect::<Result<_, String>>()?,
    };
    if saved.sync_token.len() > 4096
        || saved.peers.len() > 256
        || saved
            .peers
            .iter()
            .any(|(id, key)| id.len() > 256 || key.len() > 4096)
    {
        return Err("credentials exceed supported size".into());
    }
    save_to(&OsStore, PLATFORM_LAYOUT, &saved)?;
    Ok(references(&saved))
}
#[tauri::command]
pub async fn sync_secrets_read(window: tauri::Window) -> Result<Option<String>, String> {
    main_window_label_only(window.label())?;
    tauri::async_runtime::spawn_blocking(|| {
        let _lock = LOCK.lock().map_err(|_| "credential state unavailable")?;
        serde_json::to_string(&references(&load()?))
            .map(Some)
            .map_err(|_| "invalid credentials".into())
    })
    .await
    .map_err(|_| "credential task failed")?
}
#[tauri::command]
pub async fn sync_secrets_write(window: tauri::Window, value: String) -> Result<String, String> {
    main_window_label_only(window.label())?;
    if value.len() > 65_536 {
        return Err("credentials exceed supported size".into());
    }
    let input: SyncSecrets = serde_json::from_str(&value).map_err(|_| "invalid credentials")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = LOCK.lock().map_err(|_| "credential state unavailable")?;
        serde_json::to_string(&store(input)?).map_err(|_| "invalid credentials".into())
    })
    .await
    .map_err(|_| "credential task failed")?
}
#[tauri::command]
pub fn sync_secrets_import(window: tauri::Window, value: String) -> Result<String, String> {
    main_window_label_only(window.label())?;
    crate::sync::require_sync_key(&value)?;
    let reference = format!(
        "credential:session:{}",
        crate::hex::random_hex::<32>().ok_or("secure random source unavailable")?
    );
    let mut temporary = temporary()
        .lock()
        .map_err(|_| "credential state unavailable")?;
    if temporary.len() >= 128 {
        return Err("too many temporary credentials; restart Mesa".into());
    }
    temporary.insert(reference.clone(), value);
    Ok(reference)
}
#[tauri::command]
pub async fn sync_secrets_generate(
    window: tauri::Window,
    reset: Option<bool>,
) -> Result<String, String> {
    main_window_label_only(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = LOCK.lock().map_err(|_| "credential state unavailable")?;
        if reset == Some(true) {
            // Confirmed in the renderer: discard every saved key, including
            // all peer keys, and start over with a new device key.
            let fresh = SyncSecrets {
                sync_token: random_key()?,
                peers: BTreeMap::new(),
            };
            reset_to(&OsStore, PLATFORM_LAYOUT, &fresh)?;
            return Ok(DEVICE.to_string());
        }
        let mut saved = load()?;
        saved.sync_token = random_key()?;
        store(saved)?;
        Ok(DEVICE.to_string())
    })
    .await
    .map_err(|_| "credential task failed")?
}
#[tauri::command]
pub async fn sync_secrets_show(
    app: tauri::AppHandle,
    window: tauri::Window,
    reference: String,
) -> Result<(), String> {
    main_window_label_only(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let key = resolve(&reference)?;
        app.dialog().message(format!("Enter this key on your other device:\n\n{key}\n\nKeep it private. Anyone with this key can access a receiving vault.")).title("Device sync key").blocking_show();
        Ok(())
    }).await.map_err(|_| "credential task failed")?
}
#[cfg(test)]
#[path = "secrets_tests.rs"]
mod tests;
