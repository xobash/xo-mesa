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
#[derive(Default, Deserialize, Serialize)]
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
fn load() -> Result<SyncSecrets, String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|_| "credential store is unavailable")?;
    match entry.get_password() {
        Ok(value) if value.len() <= 65_536 => serde_json::from_str(&value)
            .map_err(|_| "saved credentials have an invalid format".into()),
        Ok(_) => Err("saved credentials exceed supported size".into()),
        Err(Error::NoEntry) => Ok(SyncSecrets::default()),
        Err(_) => Err("credential store could not read sync keys".into()),
    }
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
    Entry::new(SERVICE, ACCOUNT)
        .map_err(|_| "credential store unavailable")?
        .set_password(&serde_json::to_string(&saved).map_err(|_| "invalid credentials")?)
        .map_err(|_| "credential store could not save keys")?;
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
    let mut bytes = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes)
        .map_err(|_| "secure random source unavailable")?;
    let reference = format!(
        "credential:session:{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
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
pub async fn sync_secrets_generate(window: tauri::Window) -> Result<String, String> {
    main_window_label_only(window.label())?;
    tauri::async_runtime::spawn_blocking(|| {
        let _lock = LOCK.lock().map_err(|_| "credential state unavailable")?;
        let mut saved = load()?;
        let mut bytes = [0u8; 32];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes)
            .map_err(|_| "secure random source unavailable")?;
        saved.sync_token = bytes.iter().map(|b| format!("{b:02x}")).collect();
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
mod tests {
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
}
