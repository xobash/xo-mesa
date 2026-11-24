// Staged update packages and their install (`updater.rs`, `docs/updates.md`).
//
// A verified package waits on disk until the guarded quit or Restart. Before
// it is installed it is verified again from disk with the same key and
// signed-version rule as the plugin. On macOS Mesa swaps the `.app` itself:
// the plugin's own install falls back to an AppleScript administrator prompt
// when the rename is refused, and Mesa never shows a prompt.

use base64::Engine;
use std::path::{Path, PathBuf};

/// Largest staged package Mesa reads back (an AppImage is ~100 MB).
pub(crate) const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;

fn base64_text(value: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|_| "unreadable base64".to_string())?;
    String::from_utf8(bytes).map_err(|_| "not UTF-8".to_string())
}

/// The version recorded in a minisign trusted comment (`...\tversion:X`).
pub(crate) fn signed_version(trusted_comment: &str) -> Option<&str> {
    trusted_comment
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        .map(|version| version.trim_start_matches('v'))
}

pub(crate) const SIGNATURE_REFUSED: &str =
    "The update's signature did not verify, so it was not installed.";

/// Verify `bytes` against a base64 `.sig` and the configured public key, and
/// require the signed version to be `version`.
pub(crate) fn verify_package(
    bytes: &[u8],
    signature: &str,
    pubkey: &str,
    version: &str,
) -> Result<(), String> {
    let refused = || SIGNATURE_REFUSED.to_string();
    let key = base64_text(pubkey)
        .ok()
        .and_then(|text| minisign_verify::PublicKey::decode(&text).ok())
        .ok_or_else(refused)?;
    let signature = base64_text(signature)
        .ok()
        .and_then(|text| minisign_verify::Signature::decode(&text).ok())
        .ok_or_else(refused)?;
    key.verify(bytes, &signature, true).map_err(|_| refused())?;
    match signed_version(signature.trusted_comment()) {
        Some(signed) if signed == version.trim_start_matches('v') => Ok(()),
        _ => Err(refused()),
    }
}

/// Replace any earlier staged package with `bytes`; returns its path.
pub(crate) fn stage_package(dir: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Mesa could not prepare the update folder.".into()),
    }
    std::fs::create_dir_all(dir).map_err(|_| "Mesa could not prepare the update folder.")?;
    let path = dir.join("package");
    std::fs::write(&path, bytes).map_err(|_| "Mesa could not save the update.")?;
    Ok(path)
}

/// Read a staged package back, bounded.
pub(crate) fn read_staged(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|_| "The downloaded update is missing.")?;
    let mut bytes = Vec::new();
    file.take(MAX_PACKAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The downloaded update could not be read.")?;
    if bytes.len() as u64 > MAX_PACKAGE_BYTES {
        return Err("The downloaded update is too large.".into());
    }
    Ok(bytes)
}

#[cfg(unix)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const BUNDLE_REFUSED: &str =
    "Mesa could not replace itself in its folder. Download the new version from Mesa's Releases page.";

#[cfg(unix)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn sibling(bundle: &Path, suffix: &str) -> Option<PathBuf> {
    let name = bundle.file_name()?.to_str()?;
    Some(bundle.parent()?.join(format!(".{name}.{suffix}")))
}

#[cfg(unix)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Swap `bundle` (an `.app` folder) for the one in a verified `.app.tar.gz`,
/// using only renames in the bundle's own folder. Any refusal (a protected
/// folder, app-management protection, an immutable flag) leaves the old
/// bundle in place and returns `BUNDLE_REFUSED`; nothing asks for a password.
#[cfg(unix)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn swap_bundle(bundle: &Path, archive: &[u8]) -> Result<(), String> {
    let (Some(stage), Some(backup)) = (sibling(bundle, "mesa-update"), sibling(bundle, "mesa-old"))
    else {
        return Err(BUNDLE_REFUSED.into());
    };
    if remove_if_present(&stage).is_err() || remove_if_present(&backup).is_err() {
        return Err(BUNDLE_REFUSED.into());
    }
    std::fs::create_dir(&stage).map_err(|_| BUNDLE_REFUSED.to_string())?;
    let result = swap_from_stage(bundle, &stage, &backup, archive);
    let _ = remove_if_present(&stage);
    result
}

#[cfg(unix)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn swap_from_stage(
    bundle: &Path,
    stage: &Path,
    backup: &Path,
    archive: &[u8],
) -> Result<(), String> {
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    tar.set_preserve_permissions(true);
    // `unpack` refuses absolute and `..` paths and links that leave `stage`.
    tar.unpack(stage)
        .map_err(|_| "The update package could not be unpacked.".to_string())?;
    let new_app = single_app_folder(stage)?;
    std::fs::rename(bundle, backup).map_err(|_| BUNDLE_REFUSED.to_string())?;
    if std::fs::rename(&new_app, bundle).is_err() {
        // Put the running version back; a failed restore is reported too.
        return match std::fs::rename(backup, bundle) {
            Ok(()) => Err(BUNDLE_REFUSED.into()),
            Err(_) => Err(
                "Mesa could not finish the update. Reinstall it from Mesa's Releases page.".into(),
            ),
        };
    }
    let _ = remove_if_present(backup);
    Ok(())
}

/// The archive holds exactly one top-level `*.app` folder.
#[cfg(unix)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn single_app_folder(stage: &Path) -> Result<PathBuf, String> {
    let malformed = || "The update package is not a Mesa app.".to_string();
    let mut found = None;
    for (index, entry) in std::fs::read_dir(stage)
        .map_err(|_| malformed())?
        .enumerate()
    {
        let path = entry.map_err(|_| malformed())?.path();
        if index > 0 || !path.is_dir() || path.extension().is_none_or(|ext| ext != "app") {
            return Err(malformed());
        }
        found = Some(path);
    }
    found.ok_or_else(malformed)
}

#[cfg(test)]
#[path = "update_install_tests.rs"]
mod tests;
