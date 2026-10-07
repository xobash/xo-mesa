use super::*;

// Persistent TLS identity and fingerprint cache.

#[derive(Clone)]
pub(super) struct Identity {
    pub(super) cert_pem: String,
    pub(super) key_pem: String,
    pub(super) fingerprint: String,
}

pub(super) fn identity_cache() -> &'static Mutex<Option<Identity>> {
    static S: OnceLock<Mutex<Option<Identity>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// Lowercase hex SHA-256 of arbitrary bytes.
pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Fingerprint (SHA-256 of the DER) of the first certificate in a PEM blob.
pub(super) fn fingerprint_from_cert_pem(cert_pem: &str) -> Result<String, String> {
    let block = pem::parse(cert_pem).map_err(|e| e.to_string())?;
    Ok(sha256_hex(block.contents()))
}

/// Establish private identity storage before reading or creating any key.
pub(super) fn protect_identity_directory(dir: &std::path::Path) -> Result<(), String> {
    use std::fs;
    if dir.exists()
        && fs::symlink_metadata(dir)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("sync identity directory must not be a symlink".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        // Persist every newly created ancestor before any identity can be
        // advertised, including a completely new app configuration directory.
        let mut missing_parents = Vec::new();
        for parent in dir.ancestors().skip(1) {
            if parent.try_exists().map_err(|e| e.to_string())? {
                break;
            }
            missing_parents.push(parent);
        }
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder.create(dir).map_err(|e| e.to_string())?;
        for created in missing_parents {
            if let Some(parent) = created.parent() {
                fs::File::open(parent)
                    .and_then(|file| file.sync_all())
                    .map_err(|e| e.to_string())?;
            }
        }
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        if fs::metadata(dir)
            .map_err(|e| e.to_string())?
            .permissions()
            .mode()
            & 0o777
            != 0o700
        {
            return Err("sync identity directory permissions could not be restricted".into());
        }
    }
    #[cfg(windows)]
    {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        // Use the process identity SID, never a renderer-provided account name.
        // The path travels as data through an environment variable, not code.
        let script = r#"$ErrorActionPreference='Stop'; $p=$env:MESA_IDENTITY_DIRECTORY; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl; $actual=Get-Acl -LiteralPath $p; if(-not $actual.AreAccessRulesProtected){throw 'Unprotected identity ACL'}; foreach($r in $actual.Access){if($r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Unexpected identity access'}}"#;
        let status = std::process::Command::new("powershell.exe")
            // A PowerShell 7 parent passes incompatible module paths through
            // native child processes. Let Windows PowerShell use its own modules.
            .env_remove("PSModulePath")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("MESA_IDENTITY_DIRECTORY", dir)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("could not restrict sync identity ACL".into());
        }
    }
    for name in ["cert.pem", "key.pem", "identity.json"] {
        let path = dir.join(name);
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err("sync identity must contain regular files".into());
            }
            #[cfg(unix)]
            if name != "cert.pem" {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                    .map_err(|e| e.to_string())?;
                if fs::metadata(&path)
                    .map_err(|e| e.to_string())?
                    .permissions()
                    .mode()
                    & 0o777
                    != 0o600
                {
                    return Err("sync key permissions could not be restricted".into());
                }
            }
            #[cfg(windows)]
            {
                // Reset old explicit file grants to the private parent ACL.
                let status = std::process::Command::new("icacls.exe")
                    .arg(&path)
                    .args(["/reset", "/Q"])
                    .status()
                    .map_err(|e| e.to_string())?;
                if !status.success() {
                    return Err("could not restrict sync identity file ACL".into());
                }
            }
        }
    }
    #[cfg(windows)]
    {
        let script = r#"$ErrorActionPreference='Stop'; $p=$env:MESA_IDENTITY_DIRECTORY; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; foreach($name in @('cert.pem','key.pem','identity.json')) { $file=Join-Path $p $name; if(Test-Path -LiteralPath $file) { $acl=Get-Acl -LiteralPath $file; $rules=@($acl.Access); if($rules.Count -eq 0){throw 'Missing identity access'}; foreach($r in $rules){if($r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $r.AccessControlType -ne 'Allow'){throw 'Unexpected identity file access'}} } }"#;
        let status = std::process::Command::new("powershell.exe")
            // A PowerShell 7 parent passes incompatible module paths through
            // native child processes. Let Windows PowerShell use its own modules.
            .env_remove("PSModulePath")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("MESA_IDENTITY_DIRECTORY", dir)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("sync identity file ACL verification failed".into());
        }
    }
    Ok(())
}

pub(super) fn persist_identity_key(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct IdentityBundle {
    pub(super) version: u32,
    pub(super) cert_pem: String,
    pub(super) key_pem: String,
}

pub(super) fn validate_identity(cert_pem: String, key_pem: String) -> Result<Identity, String> {
    let fingerprint = fingerprint_from_cert_pem(&cert_pem)?;
    let id = Identity {
        cert_pem,
        key_pem,
        fingerprint,
    };
    // Reject corrupt or mismatched pairs before advertising a fingerprint.
    sync_server_config(&id)?;
    Ok(id)
}

pub(super) fn flush_identity_directory(dir: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::fs::File::open(dir)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        // Also persist the first-run directory entry in its existing parent.
        if let Some(parent) = dir.parent() {
            std::fs::File::open(parent)
                .and_then(|file| file.sync_all())
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(unix))]
    let _ = dir; // Windows file bytes are flushed; directory durability is not claimed.
    Ok(())
}

/// One create-only publication of a validated cert/key bundle. `stop` simulates
/// abrupt interruption at each boundary; abandoned private staging is never loaded.
pub(super) fn load_identity(dir: &std::path::Path, stop: Option<u8>) -> Result<Identity, String> {
    protect_identity_directory(dir)?;
    let bundle_path = dir.join("identity.json");
    if bundle_path.try_exists().map_err(|e| e.to_string())? {
        let bytes = std::fs::read(&bundle_path).map_err(|e| e.to_string())?;
        let bundle: IdentityBundle = serde_json::from_slice(&bytes)
            .map_err(|_| "sync identity bundle is invalid; restore its backup".to_string())?;
        if bundle.version != 1 {
            return Err("unsupported sync identity bundle version".into());
        }
        let id = validate_identity(bundle.cert_pem, bundle.key_pem)?;
        flush_identity_directory(dir)?;
        return Ok(id);
    }
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");
    let id = if key_path.try_exists().map_err(|e| e.to_string())? {
        // An existing key may belong to an advertised identity. Never rotate it.
        if !cert_path.try_exists().map_err(|e| e.to_string())? {
            return Err("sync identity certificate is missing; restore it from backup".into());
        }
        validate_identity(
            std::fs::read_to_string(&cert_path).map_err(|e| e.to_string())?,
            std::fs::read_to_string(&key_path).map_err(|e| e.to_string())?,
        )?
    } else {
        // The legacy writer published the certificate first. A lone certificate
        // could never complete get_identity or be advertised; retain it and recover.
        let CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["mesa.example".into(), "localhost".into()])
                .map_err(|e| e.to_string())?;
        validate_identity(cert.pem(), signing_key.serialize_pem())?
    };
    let bundle = IdentityBundle {
        version: 1,
        cert_pem: id.cert_pem.clone(),
        key_pem: id.key_pem.clone(),
    };
    let bytes = serde_json::to_vec(&bundle).map_err(|e| e.to_string())?;
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let stage = dir.join(format!(
        "identity-{}-{}-{}.pending",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    // Private create-only staging; never expose a partial bundle as the identity.
    let result: Result<(), String> = (|| {
        if stop == Some(1) {
            persist_identity_key(&stage, &bytes[..bytes.len() / 2])?;
            return Err("identity interruption during staging".into());
        }
        persist_identity_key(&stage, &bytes)?;
        // The private parent ACL applies to staging; verify bytes before publication.
        let readback = std::fs::read(&stage).map_err(|e| e.to_string())?;
        if readback != bytes {
            return Err("sync identity staging verification failed".into());
        }
        flush_identity_directory(dir)?;
        if stop == Some(2) {
            return Err("identity interruption before publication".into());
        }
        sync_core::move_file_no_replace(&stage, &bundle_path).map_err(|e| e.to_string())?;
        if stop == Some(3) {
            return Err("identity interruption after publication".into());
        }
        flush_identity_directory(dir)?;
        protect_identity_directory(dir)?;
        Ok(())
    })();
    if stop.is_none() {
        let _ = std::fs::remove_file(&stage);
    }
    result?;
    Ok(id)
}

/// Cache only an identity whose complete bundle was durably published.
pub(super) fn get_identity(app: &tauri::AppHandle) -> Result<Identity, String> {
    let mut guard = identity_cache().lock().map_err(|e| e.to_string())?;
    if let Some(id) = guard.as_ref() {
        return Ok(id.clone());
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("sync-identity");
    let id = load_identity(&dir, None)?;
    *guard = Some(id.clone());
    Ok(id)
}

/// This device's certificate fingerprint (lowercase hex SHA-256), for the UI to
/// display so users can compare it out-of-band with a peer.
#[tauri::command]
pub fn sync_identity(app: tauri::AppHandle) -> Result<String, String> {
    Ok(get_identity(&app)?.fingerprint)
}
