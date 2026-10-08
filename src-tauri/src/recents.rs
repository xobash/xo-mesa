//! Main-owned private recent-vault catalogue; renderers receive ids and labels.
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager, State};

#[derive(Default, Deserialize, Serialize)]
struct Catalogue {
    entries: Vec<Entry>,
    last: Option<String>,
}
#[derive(Deserialize, Serialize)]
struct Entry {
    id: String,
    root: String,
}
#[derive(Serialize)]
pub struct RecentVault {
    id: String,
    label: String,
}
#[derive(Serialize)]
pub struct RecentState {
    entries: Vec<RecentVault>,
    last: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    List,
    Remember,
    Forget,
    Clear,
}

fn read(path: &Path) -> Result<Catalogue, String> {
    match crate::sync_core::open_file_no_follow(path) {
        Ok(mut file) => {
            use std::io::Read;
            if file
                .metadata()
                .map_err(|_| "Cannot inspect recent vaults")?
                .len()
                > 64 * 1024
            {
                return Err("Recent vault catalogue exceeds its limit".into());
            }
            let mut bytes = Vec::new();
            file.by_ref()
                .take(64 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "Cannot read recent vaults")?;
            if bytes.len() > 64 * 1024 {
                return Err("Recent vault catalogue exceeds its limit".into());
            }
            let catalogue: Catalogue =
                serde_json::from_slice(&bytes).map_err(|_| "Cannot decode recent vaults")?;
            if catalogue.entries.len() > 8 {
                return Err("Recent vault catalogue exceeds its entry limit".into());
            }
            Ok(catalogue)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Catalogue::default()),
        Err(_) => Err("Cannot read recent vaults".into()),
    }
}
fn reply(catalogue: &Catalogue) -> RecentState {
    RecentState {
        entries: catalogue
            .entries
            .iter()
            .map(|entry| RecentVault {
                id: entry.id.clone(),
                label: Path::new(&entry.root)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Vault")
                    .chars()
                    .filter(|ch| !ch.is_control())
                    .take(80)
                    .collect(),
            })
            .collect(),
        last: catalogue.last.clone(),
    }
}
fn remember(catalogue: &mut Catalogue, root: String) -> Result<(), String> {
    let id = catalogue
        .entries
        .iter()
        .find(|e| e.root == root)
        .map(|e| e.id.clone())
        .unwrap_or_else(String::new);
    let id = if id.is_empty() {
        use ring::rand::SecureRandom;
        let mut bytes = [0u8; 16];
        ring::rand::SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| "Cannot create a recent vault id")?;
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    } else {
        id
    };
    catalogue.entries.retain(|e| e.root != root);
    catalogue.entries.insert(
        0,
        Entry {
            id: id.clone(),
            root,
        },
    );
    catalogue.entries.truncate(8);
    catalogue.last = Some(id);
    Ok(())
}
fn storage(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot locate private app storage")?
        .join("vault-state");
    crate::sync::protect_private_directory(
        &dir,
        &[
            "recent-vaults.json",
            "approved-vault-roots.json",
            "storage-key",
        ],
    )?;
    Ok(dir.join("recent-vaults.json"))
}
#[tauri::command(async)]
pub fn vault_recents(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, crate::vaultscope::VaultScopeState>,
    action: Action,
    root: Option<String>,
    id: Option<String>,
) -> Result<RecentState, String> {
    crate::require_main(window.label())?;
    let _guard = state.0.lock().map_err(|_| "Vault state is unavailable")?;
    let path = storage(&app)?;
    let mut catalogue = read(&path)?;
    match action {
        Action::List => return Ok(reply(&catalogue)),
        Action::Remember => {
            let root = crate::vaultscope::require_approved(
                &app,
                root.as_deref().ok_or("Vault root is missing")?,
            )?;
            remember(
                &mut catalogue,
                root.to_str().ok_or("Vault root is not UTF-8")?.into(),
            )?;
        }
        Action::Forget => {
            let id = id.ok_or("Recent vault id is missing")?;
            if let Some(entry) = catalogue.entries.iter().find(|e| e.id == id) {
                crate::vaultscope::revoke_native(&app, &entry.root)?;
            }
            catalogue.entries.retain(|e| e.id != id);
            if catalogue.last.as_ref() == Some(&id) {
                catalogue.last = None;
            }
        }
        Action::Clear => {
            for entry in &catalogue.entries {
                crate::vaultscope::revoke_native(&app, &entry.root)?;
            }
            catalogue = Catalogue::default();
        }
    }
    let mut bytes = serde_json::to_vec(&catalogue).map_err(|_| "Cannot encode recent vaults")?;
    while bytes.len() > 64 * 1024 && catalogue.entries.len() > 1 {
        catalogue.entries.pop();
        bytes = serde_json::to_vec(&catalogue).map_err(|_| "Cannot encode recent vaults")?;
    }
    if bytes.len() > 64 * 1024 {
        return Err("Recent vault root exceeds its storage limit".into());
    }
    crate::vaultwrite::write_atomic(&path, &bytes, &crate::vaultwrite::ExpectedCurrent::Any)?;
    Ok(reply(&catalogue))
}
#[tauri::command(async)]
pub fn vault_recent_resolve(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, crate::vaultscope::VaultScopeState>,
    id: String,
) -> Result<String, String> {
    crate::require_main(window.label())?;
    let _guard = state.0.lock().map_err(|_| "Vault state is unavailable")?;
    let catalogue = read(&storage(&app)?)?;
    catalogue
        .entries
        .into_iter()
        .find(|e| e.id == id)
        .map(|e| e.root)
        .ok_or("Recent vault is unavailable".into())
}
/// Opaque renderer storage identity. This is a namespace, never file authority.
#[tauri::command(async)]
pub fn vault_storage_id(
    app: AppHandle,
    state: State<'_, crate::vaultscope::VaultScopeState>,
    root: String,
) -> Result<String, String> {
    if root.is_empty() || root.len() > 16 * 1024 {
        return Err("Invalid vault storage namespace".into());
    }
    let _guard = state.0.lock().map_err(|_| "Vault state is unavailable")?;
    let path = storage(&app)?.with_file_name("storage-key");
    let key = storage_key(&path)?;
    Ok(namespace(&key, &root))
}
fn namespace(key: &[u8], root: &str) -> String {
    let tag = ring::hmac::sign(
        &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, key),
        root.as_bytes(),
    );
    format!(
        "vault:{}",
        tag.as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}
fn storage_key(path: &Path) -> Result<[u8; 32], String> {
    use std::io::Read;
    match crate::sync_core::open_file_no_follow(path) {
        Ok(mut file) => {
            if file
                .metadata()
                .map_err(|_| "Cannot inspect storage key")?
                .len()
                != 32
            {
                return Err("Invalid storage key".into());
            }
            let mut bytes = [0; 32];
            file.read_exact(&mut bytes)
                .map_err(|_| "Cannot read storage key")?;
            Ok(bytes)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            use ring::rand::SecureRandom;
            let mut bytes = [0; 32];
            ring::rand::SystemRandom::new()
                .fill(&mut bytes)
                .map_err(|_| "Cannot generate storage key")?;
            crate::vaultwrite::write_atomic(
                path,
                &bytes,
                &crate::vaultwrite::ExpectedCurrent::Missing,
            )?;
            Ok(bytes)
        }
        Err(_) => Err("Cannot read storage key".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn storage_namespaces_are_stable_private_and_installation_specific() {
        let path = std::env::temp_dir().join(format!("mesa-storage-key-{}", std::process::id()));
        let key = storage_key(&path).unwrap();
        assert_eq!(key, storage_key(&path).unwrap());
        let id = namespace(&key, "/synthetic/private/vault");
        assert_eq!(id, namespace(&key, "/synthetic/private/vault"));
        assert!(!id.contains("synthetic"));
        assert_ne!(id, namespace(&[0; 32], "/synthetic/private/vault"));
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn catalogue_replies_do_not_contain_roots_and_ids_are_stable() {
        let mut catalogue = Catalogue::default();
        remember(&mut catalogue, "/synthetic/private/vault".into()).unwrap();
        let id = catalogue.last.clone().unwrap();
        remember(&mut catalogue, "/synthetic/other/notes".into()).unwrap();
        remember(&mut catalogue, "/synthetic/private/vault".into()).unwrap();
        assert_eq!(catalogue.last.as_ref(), Some(&id));
        assert_eq!(catalogue.entries.len(), 2);
        let bytes = serde_json::to_string(&reply(&catalogue)).unwrap();
        assert!(!bytes.contains("synthetic"));
        assert!(bytes.contains("vault"));
        for n in 0..12 {
            remember(&mut catalogue, format!("/synthetic/{n}")).unwrap();
        }
        assert_eq!(catalogue.entries.len(), 8);
    }
    #[test]
    fn private_catalogue_roundtrip_and_symlink_rejection() {
        let dir = std::env::temp_dir().join(format!("mesa-recents-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("recent.json");
        crate::vaultwrite::write_atomic(
            &path,
            br#"{"entries":[],"last":null}"#,
            &crate::vaultwrite::ExpectedCurrent::Missing,
        )
        .unwrap();
        assert!(read(&path).unwrap().entries.is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            let link = dir.join("linked.json");
            symlink(&path, &link).unwrap();
            assert!(read(&link).is_err());
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
