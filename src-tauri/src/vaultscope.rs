use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_fs::FsExt;

static APPROVED_ROOTS: Mutex<Option<(PathBuf, ApprovedRoots)>> = Mutex::new(None);

const APPROVED_ROOTS_FILE: &str = "approved-vault-roots.json";

#[derive(Clone, Default, Deserialize, Serialize)]
struct ApprovedRoots {
    roots: BTreeSet<String>,
    /// Approved roots whose user also allowed Pi as a trusted external process.
    #[serde(
        default,
        rename = "piProcess",
        skip_serializing_if = "BTreeSet::is_empty"
    )]
    pi_process: BTreeSet<String>,
}

#[derive(Default)]
pub struct VaultScopeState(pub(crate) Mutex<()>);

fn normalized_root(root: &str) -> Result<String, String> {
    let path = Path::new(root);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("vault root must be an absolute path without parent traversal".into());
    }
    Ok(root_key(root, cfg!(windows)))
}

/// Comparison key of an absolute root: forward slashes, no trailing separator.
/// Windows keys also drop a simplifiable verbatim prefix and are lowercased,
/// so `\\?\C:\Vault` (canonicalize) and `C:\Vault` (folder dialog) are one root.
/// Unix keys are unchanged from earlier releases.
fn root_key(root: &str, windows: bool) -> String {
    let root = if windows {
        strip_verbatim_prefix(root)
    } else {
        Cow::Borrowed(root)
    };
    let mut normalized = root.replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    if windows {
        normalized = normalized.to_lowercase();
        // `c:` alone is drive-relative; a drive-root vault keeps its separator.
        if normalized.len() == 2 && normalized.ends_with(':') {
            normalized.push('/');
        }
    }
    normalized
}

/// `text` without its Windows verbatim prefix (`\\?\` or `//?/`) when the rest
/// is an ordinary drive or UNC path that Win32 path parsing would not rewrite:
/// `\\?\C:\x` becomes `C:\x`, `\\?\UNC\srv\share\x` becomes `\\srv\share\x`.
/// Anything else, including a segment with a trailing dot or a device name that
/// only the verbatim form can reach, is returned unchanged. Pure text, so the
/// rule is tested on every platform; [`plain_path`] applies it to `Path`s
/// that leave Mesa.
pub(crate) fn strip_verbatim_prefix(text: &str) -> Cow<'_, str> {
    let is_sep = |ch: char| ch == '\\' || ch == '/';
    let mut chars = text.chars();
    let lead: [Option<char>; 4] = [chars.next(), chars.next(), chars.next(), chars.next()];
    let [Some(a), Some(b), Some('?'), Some(d)] = lead else {
        return Cow::Borrowed(text);
    };
    if !(is_sep(a) && is_sep(b) && is_sep(d)) {
        return Cow::Borrowed(text);
    }
    let rest = &text[4..];
    let segments_ok = |tail: &str, required: usize| {
        let parts: Vec<&str> = tail.split(is_sep).collect();
        let last = parts.len().saturating_sub(1);
        parts.len() >= required
            && parts.iter().enumerate().all(|(index, part)| {
                if part.is_empty() {
                    // Only a single trailing separator, after the required parts.
                    return index == last && index >= required;
                }
                *part != "." && *part != ".." && !crate::sync_core::windows_reserved_segment(part)
            })
    };
    let bytes = rest.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let tail = &rest[2..];
        if tail.starts_with(is_sep) && segments_ok(&tail[1..], 0) {
            return Cow::Borrowed(rest);
        }
        return Cow::Borrowed(text);
    }
    // Compare bytes: byte 3 may sit inside a multibyte character.
    if bytes.len() > 4
        && bytes[..3].eq_ignore_ascii_case(b"UNC")
        && matches!(bytes[3], b'\\' | b'/')
    {
        // Byte 4 follows an ASCII separator, so it is a character boundary.
        let unc = &rest[4..];
        if segments_ok(unc, 2) {
            return Cow::Owned(format!("{a}{a}{unc}"));
        }
    }
    Cow::Borrowed(text)
}

/// Plain spelling of a resolved path for storage, IPC, the opener and child
/// processes. On Windows this drops the `\\?\` prefix through
/// [`strip_verbatim_prefix`], which also turns `\\?\UNC\server\share` into
/// `\\server\share` (`dunce::simplified` leaves UNC paths verbatim). Other
/// platforms return the path unchanged.
pub(crate) fn plain_path(path: &Path) -> PathBuf {
    if !cfg!(windows) {
        return path.to_path_buf();
    }
    match path.to_str() {
        Some(text) => PathBuf::from(strip_verbatim_prefix(text).into_owned()),
        None => path.to_path_buf(),
    }
}

/// `fs::canonicalize`, with one Windows fallback to `std::path::absolute`.
/// Some volumes (RAM disks, some virtual cloud drives) cannot report a final
/// path, so canonicalize fails with "Incorrect function" or "not supported"
/// for every path on them. Canonicalize exists here to resolve links and 8.3
/// short names before containment and visibility checks, so the fallback is
/// used only when there is nothing for it to resolve: no existing component
/// is a reparse point (symlink, junction, cloud placeholder) and no component
/// has a short-name shape. Otherwise the original error stands (fail closed).
pub(crate) fn resolve_path(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    let path = path.as_ref();
    match fs::canonicalize(path) {
        Err(error) if cfg!(windows) && final_path_unsupported(&error) => {
            absolute_without_aliases(path).ok_or(error)
        }
        result => result,
    }
}

/// `path` relative to `root`, component by component. Windows folds case:
/// approval keys are lowercase, and on a volume where `resolve_path` falls
/// back to `std::path::absolute` nothing restores the on-disk case of the root.
/// Other platforms compare exactly, as `Path::strip_prefix` does.
fn under_root<'a>(path: &'a Path, root: &Path) -> Option<&'a Path> {
    strip_root(path, root, cfg!(windows))
}

fn strip_root<'a>(path: &'a Path, root: &Path, fold_case: bool) -> Option<&'a Path> {
    let mut rest = path.components();
    for expected in root.components() {
        let actual = rest.next()?;
        let same = actual == expected
            || (fold_case
                && actual.as_os_str().to_string_lossy().to_lowercase()
                    == expected.as_os_str().to_string_lossy().to_lowercase());
        if !same {
            return None;
        }
    }
    Some(rest.as_path())
}

/// ERROR_INVALID_FUNCTION and ERROR_NOT_SUPPORTED: the volume, not the path.
fn final_path_unsupported(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(1 | 50))
}

/// An 8.3 alias such as `GIT~1` or `NOTES~12.MD`, which only the OS expands.
fn short_name_shaped(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    stem.rsplit_once('~')
        .is_some_and(|(_, tail)| !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()))
}

fn is_link_like(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn absolute_without_aliases(path: &Path) -> Option<PathBuf> {
    if path
        .components()
        .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return None;
    }
    let absolute = std::path::absolute(path).ok()?;
    for ancestor in absolute.ancestors() {
        if ancestor
            .file_name()
            .is_some_and(|name| name.to_str().is_none_or(short_name_shaped))
        {
            return None;
        }
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if is_link_like(&metadata) => return None,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
    }
    Some(absolute)
}

/// Re-key a loaded record with the current spelling rule. Windows records
/// written before verbatim prefixes were dropped hold `//?/c:/…` keys.
fn rekey_approved_roots(roots: &mut ApprovedRoots, windows: bool) -> bool {
    if !windows {
        return false;
    }
    let rekey = |set: &BTreeSet<String>| -> BTreeSet<String> {
        set.iter().map(|root| root_key(root, true)).collect()
    };
    let migrated = ApprovedRoots {
        roots: rekey(&roots.roots),
        pi_process: rekey(&roots.pi_process),
    };
    let changed = migrated.roots != roots.roots || migrated.pi_process != roots.pi_process;
    *roots = migrated;
    changed
}

fn approved_roots_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot locate private vault storage")?;
    let dir = app_data.join("vault-state");
    crate::sync::protect_private_directory_once(
        &dir,
        &[APPROVED_ROOTS_FILE, "recent-vaults.json"],
    )?;
    let path = dir.join(APPROVED_ROOTS_FILE);
    let legacy = app_data.join(APPROVED_ROOTS_FILE);
    if !path.exists() && legacy.exists() {
        let roots = load_approved_roots(&legacy)?;
        save_approved_roots(&path, &roots)?;
        fs::remove_file(legacy).map_err(|_| "Cannot remove legacy vault approval metadata")?;
    }
    Ok(path)
}

fn load_approved_roots(path: &Path) -> Result<ApprovedRoots, String> {
    cached_approved_roots(path, &APPROVED_ROOTS)
}

fn cached_approved_roots(
    path: &Path,
    cache: &Mutex<Option<(PathBuf, ApprovedRoots)>>,
) -> Result<ApprovedRoots, String> {
    let mut cached = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((cached_path, roots)) = cached.as_ref() {
        if cached_path == path {
            return Ok(roots.clone());
        }
    }
    let mut roots = read_approved_roots(path)?;
    if rekey_approved_roots(&mut roots, cfg!(windows)) {
        // Best effort: the in-memory record is already migrated, and the cache
        // lock serializes this write with every other approval publication.
        let _ = write_approved_roots(path, &roots);
    }
    *cached = Some((path.to_path_buf(), roots.clone()));
    Ok(roots)
}

fn invalidate_approved_roots() {
    *APPROVED_ROOTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

fn read_approved_roots(path: &Path) -> Result<ApprovedRoots, String> {
    match super::sync_core::open_file_no_follow(path).and_then(|mut file| {
        use std::io::Read;
        let mut bytes = Vec::new();
        file.by_ref()
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 1024 * 1024 {
            return Err(std::io::Error::other(
                "Vault approval record exceeds its limit",
            ));
        }
        Ok(bytes)
    }) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("cannot read approved vault roots: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ApprovedRoots::default()),
        Err(error) => Err(format!("cannot read approved vault roots: {error}")),
    }
}

fn require_approved_from(approval_path: &Path, root: &str) -> Result<PathBuf, String> {
    normalized_root(root)?;
    let canonical =
        resolve_path(root).map_err(|error| format!("vault root is unavailable: {error}"))?;
    if !canonical.is_dir() {
        return Err("vault root is not a directory".into());
    }
    let canonical_text = canonical
        .to_str()
        .ok_or_else(|| "vault root is not valid UTF-8".to_string())?;
    let approved = load_approved_roots(approval_path)?;
    if !approved.roots.contains(&normalized_root(canonical_text)?) {
        return Err("vault folder has not been selected in Mesa".into());
    }
    Ok(canonical)
}

pub fn require_approved(app: &AppHandle, root: &str) -> Result<PathBuf, String> {
    require_approved_from(&approved_roots_path(app)?, root)
}

/// Every recorded approved root, uncanonicalized; unavailable roots stay listed.
pub(crate) fn approved_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    Ok(load_approved_roots(&approved_roots_path(app)?)?
        .roots
        .into_iter()
        .map(PathBuf::from)
        .collect())
}

fn pi_process_allowed_from(approval_path: &Path, root: &Path) -> Result<bool, String> {
    let key = normalized_root(root.to_str().ok_or("vault root is not valid UTF-8")?)?;
    let approved = load_approved_roots(approval_path)?;
    Ok(approved.roots.contains(&key) && approved.pi_process.contains(&key))
}

fn remember_pi_process_from(approval_path: &Path, root: &Path) -> Result<(), String> {
    let key = normalized_root(root.to_str().ok_or("vault root is not valid UTF-8")?)?;
    invalidate_approved_roots();
    let mut approved = load_approved_roots(approval_path)?;
    if !approved.roots.contains(&key) {
        return Err("vault folder has not been selected in Mesa".into());
    }
    if approved.pi_process.insert(key) {
        save_approved_roots(approval_path, &approved)?;
    }
    Ok(())
}

/// True when the user already allowed Pi for this canonical approved root.
pub(crate) fn pi_process_allowed(app: &AppHandle, root: &Path) -> Result<bool, String> {
    pi_process_allowed_from(&approved_roots_path(app)?, root)
}

/// Records the Pi decision with the vault approval; forgetting the vault removes both.
pub(crate) fn remember_pi_process(app: &AppHandle, root: &Path) -> Result<(), String> {
    let state = app.state::<VaultScopeState>();
    let _guard = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    remember_pi_process_from(&approved_roots_path(app)?, root)
}

fn visible_vault_path(path: &Path) -> bool {
    path.components().all(|part| {
        matches!(part, Component::Normal(name)
        if name.to_str().is_some_and(|name| !crate::vault_names::is_hidden_name(name)))
    })
}

/// A dot-prefixed or `node_modules` folder beneath an approved root. Both
/// sides are root keys (`normalized_root`), so Windows verbatim and plain
/// spellings of one folder compare equal.
fn hidden_inside_approved(roots: &BTreeSet<String>, key: &str) -> bool {
    roots.iter().any(|root| {
        let rel = key.strip_prefix(root.as_str()).and_then(|rel| {
            if root.ends_with('/') {
                Some(rel)
            } else {
                rel.strip_prefix('/')
            }
        });
        rel.is_some_and(|rel| !rel.is_empty() && !visible_vault_path(Path::new(rel)))
    })
}

/// True when `rel` names only visible entries under `root`, both as spelled
/// and after the OS resolves its existing components. Windows 8.3 short names
/// (`GIT~1`) open hidden entries under a visible spelling.
pub(crate) fn resolves_visible(root: &Path, rel: &str) -> bool {
    let Some(mut existing) = crate::sync_core::safe_join(root, rel) else {
        return false;
    };
    if !visible_vault_path(Path::new(rel)) {
        return false;
    }
    let Ok(canonical_root) = resolve_path(root) else {
        return false;
    };
    loop {
        match resolve_path(&existing) {
            Ok(canonical) => {
                return under_root(&canonical, &canonical_root).is_some_and(visible_vault_path)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if existing == root || !existing.pop() {
                    return false;
                }
            }
            Err(_) => return false,
        }
    }
}

/// Windows leaf-name rules shared with sync paths: no stream syntax, device
/// names or trailing dots/spaces, which Windows strips or redirects.
fn windows_leaf_name_allowed(name: &str) -> bool {
    !crate::sync_core::windows_reserved_segment(name)
}

fn require_approved_write_target_from(approval_path: &Path, path: &str) -> Result<PathBuf, String> {
    normalized_root(path)?;
    let input = Path::new(path);
    let parent = input.parent().ok_or("vault file has no parent")?;
    let name = input.file_name().ok_or("vault file has no name")?;
    if name.to_str().is_none_or(|name| {
        name.is_empty()
            || !visible_vault_path(Path::new(name))
            || (cfg!(windows) && !windows_leaf_name_allowed(name))
    }) {
        return Err("invalid vault file name".into());
    }
    let canonical_parent =
        resolve_path(parent).map_err(|error| format!("vault folder is unavailable: {error}"))?;
    let approved = load_approved_roots(approval_path)?;
    if !approved.roots.iter().any(|root| {
        resolve_path(root).ok().is_some_and(|approved_root| {
            under_root(&canonical_parent, &approved_root).is_some_and(visible_vault_path)
        })
    }) {
        return Err("vault file is outside the approved folders".into());
    }
    let target = canonical_parent.join(name);
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            // A short-name leaf such as `ENV~1` can resolve to a hidden file.
            let resolved = resolve_path(&target)
                .map_err(|error| format!("vault file is unavailable: {error}"))?;
            if resolved.parent() != Some(canonical_parent.as_path())
                || !resolved
                    .file_name()
                    .is_some_and(|name| visible_vault_path(Path::new(name)))
            {
                return Err("invalid vault file name".into());
            }
        }
        Ok(_) => return Err("vault write requires a regular file or missing target".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("vault file is unavailable: {error}")),
    }
    Ok(target)
}

pub fn require_approved_write_target(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    require_approved_write_target_from(&approved_roots_path(app)?, path)
}

fn require_approved_file_from(approval_path: &Path, path: &str) -> Result<PathBuf, String> {
    normalized_root(path)?;
    let input = Path::new(path);
    let metadata = fs::symlink_metadata(input)
        .map_err(|error| format!("vault file is unavailable: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("vault flush requires a regular file".into());
    }
    let canonical =
        resolve_path(input).map_err(|error| format!("vault file is unavailable: {error}"))?;
    let approved = load_approved_roots(approval_path)?;
    let inside = approved.roots.iter().any(|root| {
        resolve_path(root).ok().is_some_and(|approved_root| {
            under_root(&canonical, &approved_root).is_some_and(visible_vault_path)
        })
    });
    if !inside {
        return Err("vault file is outside the approved folders".into());
    }
    Ok(canonical)
}

#[cfg(windows)]
fn sync_file(path: &Path) -> std::io::Result<()> {
    fs::OpenOptions::new().write(true).open(path)?.sync_all()
}

#[cfg(unix)]
fn sync_file(path: &Path) -> std::io::Result<()> {
    fs::File::open(path)?.sync_all()
}

/// Flush a verified vault file and its containing directory after a write or
/// rename. The renderer can request this only for an existing approved file.
// Blocking work: run off the main (UI) thread.
#[tauri::command(async)]
pub fn vault_flush_file(app: AppHandle, path: String) -> Result<(), String> {
    let canonical = require_approved_file_from(&approved_roots_path(&app)?, &path)?;
    sync_file(&canonical).map_err(|error| format!("cannot flush vault file: {error}"))?;
    crate::sync_core::platform_fs::sync_directory(
        canonical.parent().ok_or("vault file has no parent")?,
    )
    .map_err(|error| format!("cannot flush vault folder: {error}"))
}

fn load_for_authorization(path: &Path, granted_by_dialog: bool) -> Result<ApprovedRoots, String> {
    match load_approved_roots(path) {
        Ok(roots) => Ok(roots),
        // A fresh native picker grant is sufficient authority to rebuild a
        // damaged local record. An arbitrary renderer path is not.
        Err(_) if granted_by_dialog => Ok(ApprovedRoots::default()),
        Err(error) => Err(error),
    }
}

fn save_approved_roots(path: &Path, roots: &ApprovedRoots) -> Result<(), String> {
    // Hold the cache lock through publication so a read cannot restore stale approvals.
    let mut cached = APPROVED_ROOTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cached = None;
    write_approved_roots(path, roots)
}

/// Publish the record. Callers hold the approval cache lock.
fn write_approved_roots(path: &Path, roots: &ApprovedRoots) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "approved vault roots path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create Mesa app-data folder: {error}"))?;
    let bytes = serde_json::to_vec(roots)
        .map_err(|error| format!("cannot encode approved vault roots: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "Cannot stage vault approvals")?;
    #[cfg(unix)]
    super::sync_core::file_metadata::private(&file)
        .map_err(|_| "Cannot restrict vault approvals")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot save vault approvals")?;
    drop(file);
    // A failed MoveFileExW leaves the stage in place, so a retry is safe.
    crate::sync_core::platform_fs::retry_transient_lock(|| replace_file(&temporary, path))
        .map_err(|error| format!("cannot publish approved vault roots: {error}"))
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both paths are NUL-terminated UTF-16 buffers that outlive the call.
    let moved = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Restores access only to a vault the user selected previously. A newly picked
/// folder is already in Tauri's runtime scope because plugin-dialog grants it;
/// that native grant is the proof used to remember the folder for later runs.
// Blocking work: run off the main (UI) thread.
#[tauri::command(async)]
pub fn vault_authorize(
    app: AppHandle,
    state: State<'_, VaultScopeState>,
    root: String,
) -> Result<(), String> {
    let _guard = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = PathBuf::from(&root);
    normalized_root(&root)?;
    let canonical =
        resolve_path(&path).map_err(|error| format!("vault root is unavailable: {error}"))?;
    if !canonical.is_dir() {
        return Err("vault root is not a directory".into());
    }
    let normalized = normalized_root(canonical.to_str().ok_or("vault root is not valid UTF-8")?)?;
    let fs_scope = app.fs_scope();
    let granted_by_dialog = fs_scope.is_allowed(&path);
    let approval_path = approved_roots_path(&app)?;
    invalidate_approved_roots();
    let mut approved = load_for_authorization(&approval_path, granted_by_dialog)?;

    if !granted_by_dialog && !approved.roots.contains(&normalized) {
        return Err("vault folder has not been selected in Mesa".into());
    }

    // An approved root's recursive scope also allows its subfolders, so this
    // check cannot tell a dialog pick of `<vault>/.git` from a renderer request.
    if !approved.roots.contains(&normalized) && hidden_inside_approved(&approved.roots, &normalized)
    {
        return Err("a hidden folder inside a vault cannot be opened as a vault".into());
    }

    if granted_by_dialog && approved.roots.insert(normalized) {
        save_approved_roots(&approval_path, &approved)?;
    }

    fs_scope
        .allow_directory(&path, true)
        .map_err(|error| format!("cannot authorize vault filesystem access: {error}"))?;
    if path != canonical {
        fs_scope
            .allow_directory(&canonical, true)
            .map_err(|error| format!("cannot authorize vault filesystem access: {error}"))?;
    }
    app.asset_protocol_scope()
        .allow_directory(&path, true)
        .map_err(|error| format!("cannot authorize vault media access: {error}"))?;
    if path != canonical {
        app.asset_protocol_scope()
            .allow_directory(&canonical, true)
            .map_err(|error| format!("cannot authorize vault media access: {error}"))?;
    }
    Ok(())
}

/// Remove one folder from the approval record. Matches the spelling the user
/// saw or its resolved form, and works when the folder no longer exists.
fn revoke_from(approval_path: &Path, root: &str) -> Result<bool, String> {
    invalidate_approved_roots();
    let mut spellings = BTreeSet::from([normalized_root(root)?]);
    // Resolve through the nearest existing ancestor so an OS alias such as
    // /var still matches after the folder itself was deleted.
    let path = Path::new(root);
    for ancestor in path.ancestors() {
        let Ok(resolved) = resolve_path(ancestor) else {
            continue;
        };
        let rest = path.strip_prefix(ancestor).map_err(|e| e.to_string())?;
        if let Some(text) = resolved.join(rest).to_str() {
            spellings.insert(normalized_root(text)?);
        }
        break;
    }
    let mut approved = load_approved_roots(approval_path)?;
    let before = approved.roots.len();
    approved
        .roots
        .retain(|approved_root| !spellings.contains(approved_root));
    approved
        .pi_process
        .retain(|approved_root| !spellings.contains(approved_root));
    if approved.roots.len() == before {
        return Ok(false);
    }
    save_approved_roots(approval_path, &approved)?;
    Ok(true)
}

/// Forget a vault folder (recents "forget"). Native commands refuse the root
/// immediately; the fs/asset plugin scopes cannot drop an allowed directory at
/// runtime and are rebuilt from the record on the next launch.
pub(crate) fn revoke_native(app: &AppHandle, root: &str) -> Result<bool, String> {
    revoke_from(&approved_roots_path(app)?, root)
}

fn is_write_artifact_name(name: &str) -> bool {
    if let Some(rest) = name.strip_prefix(".mesa-sync-tmp-") {
        return rest.split_once('-').is_some_and(|(stamp, suffix)| {
            !stamp.is_empty() && stamp.bytes().all(|b| b.is_ascii_digit()) && !suffix.is_empty()
        });
    }
    let Some((target, suffix)) = name
        .strip_prefix('.')
        .and_then(|name| name.rsplit_once(".mesa-"))
    else {
        return false;
    };
    if target.is_empty() || target == "." || target == ".." {
        return false;
    }
    let Some((label, rest)) = suffix.split_once('-') else {
        return false;
    };
    if !matches!(label, "save" | "backup" | "rescue") {
        return false;
    }
    let Some((stamp, token)) = rest
        .strip_suffix(".tmp")
        .and_then(|rest| rest.split_once('-'))
    else {
        return false;
    };
    !stamp.is_empty()
        && stamp.bytes().all(|b| b.is_ascii_digit())
        && !token.is_empty()
        && token
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Give the fs plugin exact paths for Mesa's hidden write artifacts. The
/// configured directory scope excludes dot-prefixed names, including backups.
/// Only paths inside a previously approved vault can be added.
// Blocking work: run off the main (UI) thread.
#[tauri::command(async)]
pub fn vault_authorize_artifacts(
    app: AppHandle,
    state: State<'_, VaultScopeState>,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.is_empty() || paths.len() > 256 {
        return Err("invalid write artifact batch".into());
    }
    let _guard = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let approved = load_approved_roots(&approved_roots_path(&app)?)?;
    if approved.roots.is_empty() {
        return Err("vault folder has not been selected in Mesa".into());
    }
    let canonical_roots: Vec<PathBuf> = approved
        .roots
        .iter()
        .filter_map(|root| resolve_path(root).ok())
        .collect();
    let mut checked = Vec::with_capacity(paths.len());
    for raw in paths {
        let path = PathBuf::from(&raw);
        if !path.is_absolute()
            || path
                .components()
                .any(|component| matches!(component, Component::ParentDir))
            || !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(is_write_artifact_name)
        {
            return Err("invalid Mesa write artifact path".into());
        }
        let parent = path.parent().ok_or("write artifact has no parent")?;
        let canonical_parent = resolve_path(parent)
            .map_err(|error| format!("cannot resolve write artifact parent: {error}"))?;
        if !canonical_roots
            .iter()
            .any(|root| under_root(&canonical_parent, root).is_some())
        {
            return Err("write artifact is outside the approved vault".into());
        }
        checked.push(path);
    }
    let scope = app.fs_scope();
    for path in checked {
        scope
            .allow_file(&path)
            .map_err(|error| format!("cannot authorize write artifact: {error}"))?;
    }
    Ok(())
}

fn relative_to_root(root: &Path, raw: &str) -> Option<String> {
    let spelling = |value: &str| {
        let value = if cfg!(windows) {
            strip_verbatim_prefix(value)
        } else {
            Cow::Borrowed(value.trim_start_matches("//?/"))
        };
        value.replace('\\', "/").trim_end_matches('/').to_string()
    };
    let input = spelling(raw);
    let root_text = spelling(&root.to_string_lossy());
    let input_parts: Vec<_> = input.split('/').collect();
    let root_parts: Vec<_> = root_text.split('/').collect();
    let same = |a: &str, b: &str| {
        #[cfg(windows)]
        {
            a.to_lowercase() == b.to_lowercase()
        }
        #[cfg(not(windows))]
        {
            a == b
        }
    };
    if input_parts.len() >= root_parts.len()
        && root_parts.iter().zip(&input_parts).all(|(a, b)| same(a, b))
    {
        return Some(input_parts[root_parts.len()..].join("/"));
    }
    // A selected root can have an OS alias (for example /var on macOS).
    // Resolve that root alias, never a descendant inside it.
    for ancestor in Path::new(raw).ancestors() {
        if resolve_path(ancestor).ok().as_deref() == Some(root) {
            return raw
                .strip_prefix(ancestor.to_str()?)
                .map(|rel| rel.trim_start_matches(['/', '\\']).replace('\\', "/"));
        }
    }
    None
}
/// Resolve an absolute in-vault path without treating renderer input as approval.
pub(crate) fn approved_path(app: &AppHandle, raw: &str) -> Result<(PathBuf, String), String> {
    normalized_root(raw)?;
    let approved = load_approved_roots(&approved_roots_path(app)?)?;
    for root in approved.roots {
        let Ok(root) = resolve_path(root) else {
            continue;
        };
        if let Some(rel) = relative_to_root(&root, raw) {
            if rel.is_empty() || crate::sync_core::safe_join(&root, &rel).is_some() {
                return Ok((root, rel));
            }
        }
    }
    Err("path is outside approved vault folders".into())
}

pub(crate) fn require_approved_file(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    require_approved_file_from(&approved_roots_path(app)?, path)
}

#[cfg(test)]
#[path = "vaultscope_tests.rs"]
mod tests;
