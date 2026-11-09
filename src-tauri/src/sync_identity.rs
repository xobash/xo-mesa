use super::*;

// Persistent TLS identity and fingerprint cache.

#[derive(Clone)]
pub(super) struct Identity {
    pub(super) cert_pem: String,
    pub(super) key_pem: String,
    pub(super) fingerprint: String,
}

pub(super) fn identity_cache() -> &'static Mutex<Option<Arc<Identity>>> {
    static S: OnceLock<Mutex<Option<Arc<Identity>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// Lowercase hex SHA-256 of arbitrary bytes.
pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    crate::hex::encode(&Sha256::digest(bytes))
}

/// Fingerprint (SHA-256 of the DER) of the first certificate in a PEM blob.
pub(super) fn fingerprint_from_cert_pem(cert_pem: &str) -> Result<String, String> {
    let block = pem::parse(cert_pem).map_err(|e| e.to_string())?;
    Ok(sha256_hex(block.contents()))
}

/// One access-control entry, reduced to what the private-storage rule checks.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct AceSummary {
    pub(super) allow: bool,
    pub(super) current_user: bool,
    pub(super) mask: u32,
    pub(super) flags: u32,
}

/// A Windows security descriptor, reduced to owner, inheritance and entries.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AclSummary {
    pub(super) protected: bool,
    pub(super) owner_is_user: bool,
    pub(super) aces: Vec<AceSummary>,
}

/// FILE_ALL_ACCESS ("Full control").
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) const FULL_ACCESS: u32 = 0x001F_01FF;
/// OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE: applies to files and folders inside.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) const INHERIT_TO_CHILDREN: u32 = 0x3;

/// A private directory is owned by the current user, does not inherit from its
/// parent, and has exactly one entry: full control for the current user,
/// inherited by everything inside it.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn directory_is_private(acl: &AclSummary) -> bool {
    acl.protected
        && acl.owner_is_user
        && acl.aces
            == [AceSummary {
                allow: true,
                current_user: true,
                mask: FULL_ACCESS,
                flags: INHERIT_TO_CHILDREN,
            }]
}

/// A private file grants access to the current user only.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn file_is_private(acl: &AclSummary) -> bool {
    !acl.aces.is_empty() && acl.aces.iter().all(|ace| ace.allow && ace.current_user)
}

/// Native Windows private storage: a protected DACL for the current user, set
/// through the security API. No helper process runs, so application control
/// (AppLocker, WDAC) or a locked-down script host cannot block vault open. Only the
/// owner and DACL are written (never the SACL, which needs audit privilege),
/// and only when they differ from the private state.
#[cfg(windows)]
pub(super) mod private_acl {
    use super::{AceSummary, AclSummary, FULL_ACCESS, INHERIT_TO_CHILDREN};
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        AddAccessAllowedAceEx, EqualSid, GetAce, GetLengthSid, GetSecurityDescriptorControl,
        GetTokenInformation, InitializeAcl, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
        ACL_REVISION, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED,
        TOKEN_QUERY, TOKEN_USER, UNPROTECTED_DACL_SECURITY_INFORMATION,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACCESS_DENIED_ACE_TYPE: u8 = 1;

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    fn win32(code: u32) -> io::Result<()> {
        if code == 0 {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(code as i32))
        }
    }

    /// The process user's SID, kept inside its TOKEN_USER buffer.
    pub(in crate::sync) struct UserSid(Vec<u64>);

    impl UserSid {
        pub(in crate::sync) fn current() -> io::Result<Self> {
            let mut token: HANDLE = std::ptr::null_mut();
            // SAFETY: the pseudo process handle needs no close; `token` is
            // closed below on every path.
            if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut needed = 0u32;
            // SAFETY: a size query with a null buffer.
            unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
            // u64 storage keeps the pointer inside TOKEN_USER aligned.
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8).max(2)];
            // SAFETY: `buffer` holds at least `needed` bytes.
            let ok = unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    (buffer.len() * 8) as u32,
                    &mut needed,
                )
            };
            let error = io::Error::last_os_error();
            // SAFETY: `token` is a valid handle owned here.
            unsafe { CloseHandle(token) };
            if ok == 0 {
                return Err(error);
            }
            Ok(Self(buffer))
        }

        fn sid(&self) -> PSID {
            // SAFETY: the buffer was filled with a TOKEN_USER whose SID points
            // into the same buffer.
            unsafe { (*(self.0.as_ptr() as *const TOKEN_USER)).User.Sid }
        }
    }

    /// A descriptor returned by GetNamedSecurityInfoW, freed on drop.
    struct Descriptor {
        descriptor: PSECURITY_DESCRIPTOR,
        owner: PSID,
        dacl: *mut ACL,
    }

    impl Drop for Descriptor {
        fn drop(&mut self) {
            // SAFETY: the descriptor was allocated by the security API.
            unsafe { LocalFree(self.descriptor) };
        }
    }

    fn read(path: &Path) -> io::Result<Descriptor> {
        let name = wide(path);
        let mut found = Descriptor {
            descriptor: std::ptr::null_mut(),
            owner: std::ptr::null_mut(),
            dacl: std::ptr::null_mut(),
        };
        // SAFETY: every out pointer is valid; the descriptor owns owner and dacl.
        win32(unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut found.owner,
                std::ptr::null_mut(),
                &mut found.dacl,
                std::ptr::null_mut(),
                &mut found.descriptor,
            )
        })?;
        Ok(found)
    }

    /// Owner, inheritance and entries of `path` relative to the current user.
    pub(in crate::sync) fn summary(path: &Path, user: &UserSid) -> io::Result<AclSummary> {
        let found = read(path)?;
        let mut control = 0u16;
        let mut revision = 0u32;
        // SAFETY: the descriptor is valid until `found` drops.
        if unsafe { GetSecurityDescriptorControl(found.descriptor, &mut control, &mut revision) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: both SIDs are valid; a null owner is checked first.
        let owner_is_user =
            !found.owner.is_null() && unsafe { EqualSid(found.owner, user.sid()) } != 0;
        let mut aces = Vec::new();
        if found.dacl.is_null() {
            // A NULL DACL grants everyone full access.
            aces.push(AceSummary {
                allow: true,
                current_user: false,
                mask: FULL_ACCESS,
                flags: 0,
            });
        } else {
            // SAFETY: the DACL belongs to the live descriptor.
            let count = unsafe { (*found.dacl).AceCount };
            for index in 0..u32::from(count) {
                let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
                // SAFETY: `index` is below the ACE count.
                if unsafe { GetAce(found.dacl, index, &mut ace) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                // SAFETY: every ACE starts with an ACE_HEADER.
                let header = unsafe { *(ace as *const ACE_HEADER) };
                let simple = matches!(
                    header.AceType,
                    ACCESS_ALLOWED_ACE_TYPE | ACCESS_DENIED_ACE_TYPE
                );
                // Allowed and denied ACEs share one layout; other kinds
                // (object, callback) never count as private.
                let (mask, current_user) = if simple {
                    let entry = ace as *const ACCESS_ALLOWED_ACE;
                    // SAFETY: simple ACEs have this layout; the SID starts at SidStart.
                    unsafe {
                        let sid = std::ptr::addr_of!((*entry).SidStart) as PSID;
                        ((*entry).Mask, EqualSid(sid, user.sid()) != 0)
                    }
                } else {
                    (0, false)
                };
                aces.push(AceSummary {
                    allow: header.AceType == ACCESS_ALLOWED_ACE_TYPE,
                    current_user,
                    mask,
                    flags: u32::from(header.AceFlags),
                });
            }
        }
        Ok(AclSummary {
            protected: control & SE_DACL_PROTECTED != 0,
            owner_is_user,
            aces,
        })
    }

    fn write(path: &Path, info: u32, owner: PSID, acl: &[u64]) -> io::Result<()> {
        let name = wide(path);
        // SAFETY: the name is NUL-terminated and the ACL buffer is initialised.
        win32(unsafe {
            SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                info,
                owner,
                std::ptr::null_mut(),
                acl.as_ptr().cast(),
                std::ptr::null(),
            )
        })
    }

    /// An initialised ACL buffer holding `sid`'s full-control entry, or none.
    fn acl_for(sid: Option<PSID>) -> io::Result<Vec<u64>> {
        let ace_bytes = sid.map_or(0, |sid| {
            // SAFETY: the SID comes from the token buffer.
            std::mem::size_of::<ACCESS_ALLOWED_ACE>() - std::mem::size_of::<u32>()
                + unsafe { GetLengthSid(sid) } as usize
        });
        let size = (std::mem::size_of::<ACL>() + ace_bytes).next_multiple_of(4);
        let mut buffer = vec![0u64; size.div_ceil(8)];
        let acl = buffer.as_mut_ptr() as *mut ACL;
        // SAFETY: the buffer is at least `size` bytes and DWORD-aligned.
        if unsafe { InitializeAcl(acl, size as u32, ACL_REVISION) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if let Some(sid) = sid {
            // SAFETY: the ACL has room for exactly this entry.
            if unsafe {
                AddAccessAllowedAceEx(acl, ACL_REVISION, INHERIT_TO_CHILDREN, FULL_ACCESS, sid)
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(buffer)
    }

    /// Give `dir` a protected DACL with full control for the current user only.
    pub(in crate::sync) fn protect_directory(dir: &Path, user: &UserSid) -> io::Result<()> {
        let current = summary(dir, user)?;
        if super::directory_is_private(&current) {
            return Ok(());
        }
        let mut info = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
        let mut owner = std::ptr::null_mut();
        if !current.owner_is_user {
            info |= OWNER_SECURITY_INFORMATION;
            owner = user.sid();
        }
        write(dir, info, owner, &acl_for(Some(user.sid()))?)?;
        if !super::directory_is_private(&summary(dir, user)?) {
            return Err(io::Error::other("unexpected private directory access"));
        }
        Ok(())
    }

    /// Reset `file` to inherit only the private parent entry when it grants
    /// anyone else access.
    pub(in crate::sync) fn protect_file(file: &Path, user: &UserSid) -> io::Result<()> {
        if super::file_is_private(&summary(file, user)?) {
            return Ok(());
        }
        let info = DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION;
        write(file, info, std::ptr::null_mut(), &acl_for(None)?)?;
        if !super::file_is_private(&summary(file, user)?) {
            return Err(io::Error::other("unexpected private file access"));
        }
        Ok(())
    }
}

/// Establish private identity storage before reading or creating any key.
pub(super) fn protect_identity_directory(dir: &std::path::Path) -> Result<(), String> {
    protect_private_directory(dir, &["cert.pem", "key.pem", "identity.json"])
}

type ProtectedDirectories = Mutex<std::collections::HashSet<(PathBuf, Vec<String>)>>;

/// Protect a hot private directory once per process. Mesa creates its files
/// there through private stages, so later writes keep the protection. A
/// missing, replaced or symlinked directory is protected again.
pub(crate) fn protect_private_directory_once(
    dir: &std::path::Path,
    names: &[&str],
) -> Result<(), String> {
    static PROTECTED: OnceLock<ProtectedDirectories> = OnceLock::new();
    protect_once_with(
        PROTECTED.get_or_init(Default::default),
        dir,
        names,
        protect_private_directory,
    )
}

pub(super) fn protect_once_with(
    protected: &ProtectedDirectories,
    dir: &std::path::Path,
    names: &[&str],
    protect: impl FnOnce(&std::path::Path, &[&str]) -> Result<(), String>,
) -> Result<(), String> {
    let mut key_names: Vec<String> = names.iter().map(|name| (*name).to_string()).collect();
    key_names.sort();
    let key = (dir.to_path_buf(), key_names);
    let mut protected = protected
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let present = std::fs::symlink_metadata(dir)
        .map(|meta| meta.is_dir() && !meta.file_type().is_symlink())
        .unwrap_or(false);
    if present && protected.contains(&key) {
        return Ok(());
    }
    protected.remove(&key);
    protect(dir, names)?;
    protected.insert(key);
    Ok(())
}
pub(crate) fn protect_private_directory(
    dir: &std::path::Path,
    names: &[&str],
) -> Result<(), String> {
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
                sync_core::platform_fs::sync_directory(parent).map_err(|e| e.to_string())?;
            }
        }
        use std::os::unix::fs::OpenOptionsExt;
        let directory = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(dir)
            .map_err(|e| e.to_string())?;
        sync_core::file_metadata::private(&directory).map_err(|e| e.to_string())?;
        directory
            .set_permissions(fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
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
    let user = private_acl::UserSid::current()
        .map_err(|e| format!("could not read the current Windows user: {e}"))?;
    #[cfg(windows)]
    {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        private_acl::protect_directory(dir, &user)
            .map_err(|e| format!("could not restrict sync identity ACL: {e}"))?;
    }
    for &name in names {
        let path = dir.join(name);
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err("sync identity must contain regular files".into());
            }
            #[cfg(unix)]
            if name != "cert.pem" {
                use std::os::unix::fs::OpenOptionsExt;
                use std::os::unix::fs::PermissionsExt;
                let file = fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(&path)
                    .map_err(|e| e.to_string())?;
                sync_core::file_metadata::private(&file).map_err(|e| e.to_string())?;
                file.set_permissions(fs::Permissions::from_mode(0o600))
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
            // Reset old explicit file grants to the private parent ACL.
            #[cfg(windows)]
            private_acl::protect_file(&path, &user)
                .map_err(|e| format!("could not restrict sync identity file ACL: {e}"))?;
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
    #[cfg(unix)]
    sync_core::file_metadata::private(&file).map_err(|e| e.to_string())?;
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
    // A no-op on Windows: file bytes are flushed; directory durability is not claimed.
    sync_core::platform_fs::sync_directory(dir).map_err(|e| e.to_string())?;
    // Also persist the first-run directory entry in its existing parent.
    if let Some(parent) = dir.parent() {
        sync_core::platform_fs::sync_directory(parent).map_err(|e| e.to_string())?;
    }
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
pub(super) fn get_identity(app: &tauri::AppHandle) -> Result<Arc<Identity>, String> {
    let mut guard = identity_cache().lock().map_err(|e| e.to_string())?;
    if let Some(id) = guard.as_ref() {
        return Ok(id.clone());
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("sync-identity");
    let id = Arc::new(load_identity(&dir, None)?);
    *guard = Some(id.clone());
    Ok(id)
}

/// `get_identity` on the blocking pool: the first call reads or creates the
/// identity on disk and protects its directory.
pub(super) async fn get_identity_async(app: &tauri::AppHandle) -> Result<Arc<Identity>, String> {
    // Every server request asks; once loaded, answer without a blocking task.
    // `try_lock` never waits behind a first load that holds the lock.
    if let Ok(guard) = identity_cache().try_lock() {
        if let Some(id) = guard.as_ref() {
            return Ok(id.clone());
        }
    }
    let app = app.clone();
    tokio::task::spawn_blocking(move || get_identity(&app))
        .await
        .map_err(|error| error.to_string())?
}

/// This device's certificate fingerprint (lowercase hex SHA-256), for the UI to
/// display so users can compare it out-of-band with a peer.
// Blocking work: run off the main (UI) thread.
#[tauri::command(async)]
pub fn sync_identity(app: tauri::AppHandle) -> Result<String, String> {
    Ok(get_identity(&app)?.fingerprint.clone())
}
