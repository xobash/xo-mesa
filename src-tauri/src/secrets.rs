use keyring::{Entry, Error};
use serde::Deserialize;
use std::collections::BTreeMap;
use tauri::WebviewWindow;

const SERVICE: &str = "dev.xo.mesa.sync";
const ACCOUNT: &str = "device-and-peer-keys";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncSecrets {
    sync_token: String,
    peers: BTreeMap<String, String>,
}

fn main_window_label_only(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("sync credentials are available only in the main window".into())
    }
}

fn main_window_only(window: &WebviewWindow) -> Result<(), String> {
    main_window_label_only(window.label())
}

#[tauri::command]
pub async fn sync_secrets_read(window: WebviewWindow) -> Result<Option<String>, String> {
    main_window_only(&window)?;
    tauri::async_runtime::spawn_blocking(|| {
        let entry = Entry::new(SERVICE, ACCOUNT).map_err(|_| "credential store is unavailable")?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(Error::NoEntry) => Ok(None),
            Err(_) => Err("credential store could not read sync keys"),
        }
    })
    .await
    .map_err(|_| "credential store task failed".to_string())?
    .map_err(str::to_string)
}

#[tauri::command]
pub async fn sync_secrets_write(window: WebviewWindow, value: String) -> Result<(), String> {
    main_window_only(&window)?;
    if value.len() > 65_536 {
        return Err("sync credentials are too large".into());
    }
    let parsed: SyncSecrets = serde_json::from_str(&value)
        .map_err(|_| "sync credentials have an invalid format".to_string())?;
    if parsed.sync_token.len() > 4096
        || parsed.peers.len() > 256
        || parsed
            .peers
            .iter()
            .any(|(id, key)| id.len() > 256 || key.len() > 4096)
    {
        return Err("sync credentials exceed the supported size".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let entry = Entry::new(SERVICE, ACCOUNT).map_err(|_| "credential store is unavailable")?;
        entry
            .set_password(&value)
            .map_err(|_| "credential store could not save sync keys")
    })
    .await
    .map_err(|_| "credential store task failed".to_string())?
    .map_err(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::main_window_label_only;

    #[test]
    fn only_the_main_window_can_read_or_write_sync_credentials() {
        assert!(main_window_label_only("main").is_ok());
        for label in ["doc-1", "panel-1", "agent-1", "pi-harness", ""] {
            assert!(main_window_label_only(label).is_err());
        }
    }
}
