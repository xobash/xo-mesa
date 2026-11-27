//! Confined file handles, staging, conditional publication and retained originals.
use super::*;

/// Create missing destination parents one component at a time and reject
/// symlink/junction components. The target has already passed
/// `safe_join_confined`; this second check closes the common validation-to-
/// create gap for nested transfers.
pub fn ensure_real_parent(target: &Path) -> std::io::Result<()> {
    let mut created = CreatedDirs::default();
    let result = ensure_real_parent_tracked(target, &mut created);
    created.keep();
    result
}

/// Directories created for one staged receive. Dropping it removes them,
/// deepest first, only while still empty, so a rejected transfer leaves no
/// folders behind and a published file keeps its parents.
#[derive(Default)]
pub struct CreatedDirs {
    paths: Vec<PathBuf>,
    #[cfg(unix)]
    rooted: Vec<(std::fs::File, std::ffi::CString)>,
}

impl CreatedDirs {
    /// The caller owns these folders now; dropping removes nothing.
    fn keep(&mut self) {
        self.paths.clear();
        #[cfg(unix)]
        self.rooted.clear();
    }
}

impl Drop for CreatedDirs {
    fn drop(&mut self) {
        #[cfg(unix)]
        for (parent, name) in self.rooted.drain(..).rev() {
            use std::os::fd::AsRawFd;
            // SAFETY: parent is an open directory and name is NUL-terminated;
            // AT_REMOVEDIR removes only an empty directory and never follows links.
            unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) };
        }
        for path in self.paths.drain(..).rev() {
            let _ = std::fs::remove_dir(path);
        }
    }
}

#[cfg(unix)]
fn ensure_real_parent_tracked(target: &Path, created: &mut CreatedDirs) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::RawFd;

    let parent = target
        .parent()
        .ok_or_else(|| invalid_data("sync target has no parent"))?;
    let mut current = parent.to_path_buf();
    let mut missing = Vec::new();
    while !current.exists() {
        missing.push(current.clone());
        current = current
            .parent()
            .ok_or_else(|| invalid_data("sync target parent is unavailable"))?
            .to_path_buf();
    }

    fn open_dir(path: &Path) -> std::io::Result<RawFd> {
        let bytes = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| invalid_data("sync path contains NUL"))?;
        // SAFETY: bytes is NUL-terminated and lives through the open call.
        let fd = unsafe {
            libc::open(
                bytes.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(fd)
        }
    }

    let mut fd = open_dir(&current)?;
    for dir in missing.into_iter().rev() {
        let name = dir
            .file_name()
            .ok_or_else(|| invalid_data("sync target parent has no name"))?;
        let name =
            CString::new(name.as_bytes()).map_err(|_| invalid_data("sync path contains NUL"))?;
        // SAFETY: fd is an open directory descriptor and name is NUL-terminated.
        let made = unsafe { libc::mkdirat(fd, name.as_ptr(), 0o755) };
        if made < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                // SAFETY: fd is still owned here and has not been transferred to a File.
                unsafe { libc::close(fd) };
                return Err(error);
            }
        } else {
            created.paths.push(dir.clone());
        }
        // SAFETY: fd is open and name is NUL-terminated; O_NOFOLLOW rejects symlink parents.
        let next = unsafe {
            libc::openat(
                fd,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            )
        };
        if next < 0 {
            let error = std::io::Error::last_os_error();
            // SAFETY: fd is still owned here and has not been transferred to a File.
            unsafe { libc::close(fd) };
            return Err(error);
        }
        // SAFETY: fd is still owned here and has not been transferred to a File.
        unsafe { libc::close(fd) };
        fd = next;
    }
    // SAFETY: fd is still owned here and has not been transferred to a File.
    unsafe { libc::close(fd) };
    Ok(())
}

#[cfg(windows)]
fn missing_parents(target: &Path) -> Vec<PathBuf> {
    let mut missing = Vec::new();
    let mut current = target.parent();
    while let Some(dir) = current {
        if std::fs::symlink_metadata(dir).is_ok() {
            break;
        }
        missing.push(dir.to_path_buf());
        current = dir.parent();
    }
    missing.reverse();
    missing
}

#[cfg(not(unix))]
fn ensure_real_parent_tracked(target: &Path, created: &mut CreatedDirs) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| invalid_data("sync target has no parent"))?;
    let mut current = parent.to_path_buf();
    let mut missing = Vec::new();
    loop {
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(invalid_data("sync target parent is not a real directory"));
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    // Never create through a junction, mount point or other
                    // link-like reparse point; cloud placeholders are real folders.
                    if !super::platform_fs::path_is_in_place(&current, metadata.file_attributes())?
                    {
                        return Err(invalid_data("sync target parent is a reparse point"));
                    }
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(current.clone());
                current = current
                    .parent()
                    .ok_or_else(|| invalid_data("sync target parent is unavailable"))?
                    .to_path_buf();
            }
            Err(error) => return Err(error),
        }
    }
    for dir in missing.into_iter().rev() {
        std::fs::create_dir(&dir)?;
        created.paths.push(dir.clone());
        let metadata = std::fs::symlink_metadata(&dir)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(invalid_data("sync target parent was replaced"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if !super::platform_fs::path_is_in_place(&dir, metadata.file_attributes())? {
                return Err(invalid_data("sync target parent became a reparse point"));
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitOutcome {
    Created,
    Unchanged,
}

pub(super) static ARTIFACT_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(super) fn artifact_token() -> (u64, String) {
    let stamp = now_ms();
    let counter = ARTIFACT_COUNTER.fetch_add(1, Ordering::Relaxed);
    (
        stamp,
        format!("s{:x}{:x}{:x}", std::process::id(), stamp, counter),
    )
}

pub(super) fn candidate_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let (stamp, token) = artifact_token();
    path.with_file_name(format!(
        ".mesa-sync-tmp-{}-{stamp}-{token}-{file_name}",
        std::process::id()
    ))
}

pub(super) fn collision_error(path: &Path) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!(
            "destination already exists with different content: {}",
            path.display()
        ),
    )
}

pub(super) fn invalid_data(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.into())
}

#[derive(Debug)]
struct SourceChanged;

impl std::fmt::Display for SourceChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("source changed during move; it was moved back")
    }
}

impl std::error::Error for SourceChanged {}

pub(super) fn source_changed() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, SourceChanged)
}

#[cfg(test)]
thread_local! {
    static BEFORE_MOVE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

/// Test seam: run once on this thread just before the next verified move.
#[cfg(test)]
pub(super) fn set_before_move_hook(hook: impl FnOnce() + 'static) {
    BEFORE_MOVE.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
pub(super) fn run_before_move_hook() {
    if let Some(hook) = BEFORE_MOVE.with(|slot| slot.borrow_mut().take()) {
        hook();
    }
}

#[cfg(test)]
thread_local! {
    static AFTER_EXCHANGE: std::cell::RefCell<Option<std::io::Error>> =
        const { std::cell::RefCell::new(None) };
}

/// Test seam: fail the next replacement on this thread right after its
/// atomic exchange, before the displaced-bytes check.
#[cfg(test)]
pub(super) fn fail_after_exchange(error: std::io::Error) {
    AFTER_EXCHANGE.with(|slot| *slot.borrow_mut() = Some(error));
}

#[cfg(test)]
fn take_after_exchange_failure() -> Option<std::io::Error> {
    AFTER_EXCHANGE.with(|slot| slot.borrow_mut().take())
}

/// The move found different bytes and restored them to the source path.
pub(super) fn is_source_changed(error: &std::io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|inner| inner.is::<SourceChanged>())
}

pub(super) trait CommitFs {
    #[cfg(test)]
    fn create_dir_all(&self, path: &Path) -> std::io::Result<()>;
    #[cfg(test)]
    fn write_new(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()>;
    fn fingerprint(&self, path: &Path) -> std::io::Result<(u64, String)>;
    fn exclusive_publish(&self, from: &Path, to: &Path) -> Result<(), ExclusivePublishError>;
    fn hard_link(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    fn remove_file(&self, path: &Path) -> std::io::Result<()>;
}

#[derive(Debug)]
pub(super) enum ExclusivePublishError {
    Unsupported(std::io::Error),
    Failed(std::io::Error),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PublishMethod {
    ExclusiveRename,
    HardLink,
}

pub(super) struct StdCommitFs;

impl CommitFs for StdCommitFs {
    #[cfg(test)]
    fn create_dir_all(&self, path: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(path)
    }

    #[cfg(test)]
    fn write_new(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(bytes)?;
        file.sync_all()
    }

    fn fingerprint(&self, path: &Path) -> std::io::Result<(u64, String)> {
        hash_file_streaming(path)
    }

    fn exclusive_publish(&self, from: &Path, to: &Path) -> Result<(), ExclusivePublishError> {
        platform_exclusive_publish(from, to)
    }

    fn hard_link(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::hard_link(from, to)
    }

    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn unix_path(path: &Path) -> Result<std::ffi::CString, ExclusivePublishError> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        ExclusivePublishError::Failed(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "sync path contains an interior NUL",
        ))
    })
}

#[cfg(target_os = "linux")]
pub(super) fn platform_exclusive_publish(
    from: &Path,
    to: &Path,
) -> Result<(), ExclusivePublishError> {
    let from = unix_path(from)?;
    let to = unix_path(to)?;
    // SAFETY: both C strings are NUL-terminated and live through the call.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ENOSYS) | Some(libc::EINVAL) | Some(libc::EOPNOTSUPP) => {
            Err(ExclusivePublishError::Unsupported(error))
        }
        _ => Err(ExclusivePublishError::Failed(error)),
    }
}

#[cfg(target_os = "macos")]
pub(super) fn platform_exclusive_publish(
    from: &Path,
    to: &Path,
) -> Result<(), ExclusivePublishError> {
    let from = unix_path(from)?;
    let to = unix_path(to)?;
    // SAFETY: both C strings are NUL-terminated and live through the call.
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if exclusive_rename_unsupported(error.raw_os_error()) {
        Err(ExclusivePublishError::Unsupported(error))
    } else {
        Err(ExclusivePublishError::Failed(error))
    }
}

/// An exclusive rename (`renameat2(RENAME_NOREPLACE)`, `renamex_np` /
/// `renameatx_np(RENAME_EXCL)`) the filesystem does not support. macOS
/// reports `ENOTSUP` (45), which differs from `EOPNOTSUPP` (102) there
/// (renamex_np(2)); Linux defines them as one value.
#[cfg(target_os = "macos")]
pub(super) fn exclusive_rename_unsupported(errno: Option<i32>) -> bool {
    matches!(
        errno,
        Some(libc::ENOSYS | libc::EINVAL | libc::EOPNOTSUPP | libc::ENOTSUP)
    )
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(super) fn exclusive_rename_unsupported(errno: Option<i32>) -> bool {
    matches!(errno, Some(libc::ENOSYS | libc::EINVAL | libc::EOPNOTSUPP))
}

#[cfg(windows)]
pub(super) fn platform_exclusive_publish(
    from: &Path,
    to: &Path,
) -> Result<(), ExclusivePublishError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED,
    };
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let mut from_wide: Vec<u16> = from.as_os_str().encode_wide().collect();
    let mut to_wide: Vec<u16> = to.as_os_str().encode_wide().collect();
    from_wide.push(0);
    to_wide.push(0);
    // The replacement flag is deliberately absent. MoveFileExW therefore
    // fails if another writer already created the destination. A failed move
    // changes nothing, so a short antivirus or indexer lock is retried.
    let moved = super::platform_fs::retry_transient_lock(|| {
        // SAFETY: both UTF-16 buffers are NUL-terminated and live through the call.
        let result =
            unsafe { MoveFileExW(from_wide.as_ptr(), to_wide.as_ptr(), MOVEFILE_WRITE_THROUGH) };
        if result != 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    });
    let Err(error) = moved else {
        return Ok(());
    };
    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_FILE_EXISTS) | Some(ERROR_ALREADY_EXISTS) => Err(ExclusivePublishError::Failed(
            std::io::Error::new(std::io::ErrorKind::AlreadyExists, error),
        )),
        Some(ERROR_INVALID_FUNCTION) | Some(ERROR_NOT_SUPPORTED) => {
            Err(ExclusivePublishError::Unsupported(error))
        }
        _ => Err(ExclusivePublishError::Failed(error)),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(super) fn platform_exclusive_publish(
    _from: &Path,
    _to: &Path,
) -> Result<(), ExclusivePublishError> {
    Err(ExclusivePublishError::Unsupported(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "no native exclusive-rename implementation for this platform",
    )))
}

pub(super) fn fingerprint_matches(actual: &(u64, String), size: u64, hash: &str) -> bool {
    actual.0 == size && actual.1.eq_ignore_ascii_case(hash)
}

pub(super) fn destination_state<F: CommitFs>(
    fs: &F,
    path: &Path,
    size: u64,
    hash: &str,
) -> std::io::Result<Option<bool>> {
    match fs.fingerprint(path) {
        Ok(actual) => Ok(Some(fingerprint_matches(&actual, size, hash))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub(super) fn publish_candidate<F: CommitFs>(
    fs: &F,
    candidate: &Path,
    target: &Path,
) -> std::io::Result<PublishMethod> {
    match fs.exclusive_publish(candidate, target) {
        Ok(()) => Ok(PublishMethod::ExclusiveRename),
        Err(ExclusivePublishError::Failed(e)) => Err(e),
        Err(ExclusivePublishError::Unsupported(exclusive_error)) => {
            match fs.hard_link(candidate, target) {
                Ok(()) => Ok(PublishMethod::HardLink),
                Err(link_error) => Err(std::io::Error::new(
                    link_error.kind(),
                    format!(
                        "native exclusive rename is unsupported ({exclusive_error}); safe hard-link fallback failed: {link_error}"
                    ),
                )),
            }
        }
    }
}

pub(super) fn publish_verified_candidate<F: CommitFs>(
    fs: &F,
    candidate: &Path,
    path: &Path,
    size: u64,
    hash: &str,
    preserve_candidate: &mut bool,
) -> std::io::Result<CommitOutcome> {
    match publish_candidate(fs, candidate, path) {
        Ok(method) => match fs.fingerprint(path) {
            Ok(committed) if fingerprint_matches(&committed, size, hash) => {
                if method == PublishMethod::HardLink {
                    let _ = fs.remove_file(candidate);
                }
                Ok(CommitOutcome::Created)
            }
            Ok(_) => {
                *preserve_candidate = method == PublishMethod::HardLink;
                Err(invalid_data(format!(
                "sync target failed final read-back verification; target was preserved because portable file-identity proof is unavailable{}",
                if method == PublishMethod::HardLink {
                    format!("; staged link remains at {}", candidate.display())
                } else {
                    String::new()
                }
            )))
            }
            Err(e) => {
                *preserve_candidate = method == PublishMethod::HardLink;
                Err(invalid_data(format!(
                "sync target final read-back failed ({e}); target was preserved because portable file-identity proof is unavailable{}",
                if method == PublishMethod::HardLink {
                    format!("; staged link remains at {}", candidate.display())
                } else {
                    String::new()
                }
            )))
            }
        },
        Err(publish_error) => {
            let state = destination_state(fs, path, size, hash);
            match state {
                Ok(Some(true)) => Ok(CommitOutcome::Unchanged),
                Ok(Some(false)) => Err(collision_error(path)),
                Ok(None) => Err(std::io::Error::new(
                    publish_error.kind(),
                    format!("safe create failed; destination was not modified: {publish_error}"),
                )),
                Err(e) => Err(e),
            }
        }
    }
}

/// The reason a streamed receive failed, kept distinct for HTTP diagnostics.
#[derive(Debug)]
pub enum ReceiveError {
    TooLarge { limit: u64 },
    SizeMismatch { expected: u64, actual: u64 },
    HashMismatch { expected: String, actual: String },
    Read(std::io::Error),
    Write(std::io::Error),
}

impl std::fmt::Display for ReceiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { limit } => write!(f, "transfer exceeds {limit} byte limit"),
            Self::SizeMismatch { expected, actual } => write!(
                f,
                "content size mismatch after transfer (expected {expected}, got {actual})"
            ),
            Self::HashMismatch { expected, actual } => write!(
                f,
                "content hash mismatch after transfer (expected {expected}, got {actual})"
            ),
            Self::Read(e) => write!(f, "transfer read failed: {e}"),
            Self::Write(e) => write!(f, "staged write failed: {e}"),
        }
    }
}

impl std::error::Error for ReceiveError {}

/// Verified, private sibling file. Dropping an interrupted receive removes only
/// this create-new candidate. Publication never replaces an existing target.
pub struct StagedFile {
    #[cfg(windows)]
    _parents: WindowsParentGuard,
    path: PathBuf,
    pub size: u64,
    hash: String,
    preserve: bool,
    #[cfg(unix)]
    rooted: Option<RootedStage>,
    // Last: removed after the candidate and any parent guard are released.
    _created: CreatedDirs,
}

#[cfg(unix)]
pub(super) struct RootedStage {
    parent: std::fs::File,
    candidate: std::ffi::CString,
}

/// Rename `from` (relative to `from_dir`) to `to` (relative to `to_dir`) and
/// never replace an existing `to`. Returns the libc result: 0 on success,
/// otherwise -1 with `errno` set. Platforms without a no-replace `renameat`
/// return -1 so callers take their fallback or error path.
#[cfg(unix)]
fn renameat_no_replace(
    from_dir: &std::fs::File,
    from: &std::ffi::CStr,
    to_dir: &std::fs::File,
    to: &std::ffi::CStr,
) -> libc::c_int {
    use std::os::fd::AsRawFd;
    let (from_fd, to_fd) = (from_dir.as_raw_fd(), to_dir.as_raw_fd());
    #[cfg(target_os = "linux")]
    // SAFETY: both directory Files are borrowed open and both names are NUL-terminated.
    let moved = unsafe {
        libc::renameat2(
            from_fd,
            from.as_ptr(),
            to_fd,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    // SAFETY: both directory Files are borrowed open and both names are NUL-terminated.
    let moved = unsafe {
        libc::renameatx_np(
            from_fd,
            from.as_ptr(),
            to_fd,
            to.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let moved = {
        let _ = (from_fd, from, to_fd, to);
        -1
    };
    moved
}

/// Open each descendant relative to the already-open vault directory. A
/// renamed or replaced ancestor cannot redirect a later operation outside it.
#[cfg(unix)]
pub struct RootedTarget {
    parent: std::fs::File,
    pub(super) name: std::ffi::CString,
    display: PathBuf,
}

#[cfg(unix)]
impl RootedTarget {
    pub(super) fn open_root_dir(root: &Path) -> std::io::Result<std::fs::File> {
        use std::os::fd::FromRawFd;
        use std::os::unix::ffi::OsStrExt;
        let root_name = std::ffi::CString::new(root.as_os_str().as_bytes())
            .map_err(|_| invalid_data("vault root contains NUL"))?;
        // SAFETY: root_name is NUL-terminated and lives through the open call.
        let raw = unsafe {
            libc::open(
                root_name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if raw < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            // SAFETY: open returned a nonnegative descriptor with no other owner.
            // The vault root keeps the user's own access controls.
            Ok(unsafe { std::fs::File::from_raw_fd(raw) })
        }
    }

    pub fn resolve(root: &Path, rel: &str, create_parents: bool) -> std::io::Result<Self> {
        let mut created = CreatedDirs::default();
        let target = Self::resolve_tracked(root, rel, create_parents, &mut created);
        // Callers of this form keep the folders they asked for.
        created.keep();
        target
    }

    /// [`Self::resolve`] for local vault operations: the same rooted walk,
    /// validated by `vault_join` instead of sync's portable `safe_join`.
    pub(crate) fn resolve_local(
        root: &Path,
        rel: &str,
        create_parents: bool,
    ) -> std::io::Result<Self> {
        let display = vault_join(root, rel).ok_or_else(|| invalid_data("unsafe vault path"))?;
        let mut created = CreatedDirs::default();
        let target = Self::resolve_joined(display, root, rel, create_parents, &mut created);
        created.keep();
        target
    }

    fn resolve_tracked(
        root: &Path,
        rel: &str,
        create_parents: bool,
        created: &mut CreatedDirs,
    ) -> std::io::Result<Self> {
        let display = safe_join(root, rel).ok_or_else(|| invalid_data("unsafe sync path"))?;
        Self::resolve_joined(display, root, rel, create_parents, created)
    }

    /// Walk `rel` from the root with `openat(O_NOFOLLOW)`; `display` is the
    /// already validated lexical join of the same path.
    fn resolve_joined(
        display: PathBuf,
        root: &Path,
        rel: &str,
        create_parents: bool,
        created: &mut CreatedDirs,
    ) -> std::io::Result<Self> {
        use std::os::fd::FromRawFd;
        let mut parent = Self::open_root_dir(root)?;
        let mut segments = rel.split('/').peekable();
        while let Some(segment) = segments.next() {
            let name = std::ffi::CString::new(segment)
                .map_err(|_| invalid_data("sync path contains NUL"))?;
            if segments.peek().is_none() {
                return Ok(Self {
                    parent,
                    name,
                    display,
                });
            }
            if create_parents {
                // SAFETY: parent remains open and name is NUL-terminated.
                let made = unsafe {
                    libc::mkdirat(
                        std::os::fd::AsRawFd::as_raw_fd(&parent),
                        name.as_ptr(),
                        0o755,
                    )
                };
                if made == 0 {
                    created.rooted.push((parent.try_clone()?, name.clone()));
                } else if std::io::Error::last_os_error().kind()
                    != std::io::ErrorKind::AlreadyExists
                {
                    return Err(std::io::Error::last_os_error());
                }
            }
            // SAFETY: parent remains open and name is NUL-terminated; O_NOFOLLOW rejects symlink parents.
            let next = unsafe {
                libc::openat(
                    std::os::fd::AsRawFd::as_raw_fd(&parent),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if next < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: openat returned a nonnegative descriptor with no other owner.
            parent = unsafe { std::fs::File::from_raw_fd(next) };
        }
        Err(invalid_data("empty sync path"))
    }

    pub fn open_read(&self) -> std::io::Result<std::fs::File> {
        use std::os::fd::{AsRawFd, FromRawFd};
        // SAFETY: parent remains open and self.name is NUL-terminated.
        let raw = unsafe {
            libc::openat(
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if raw < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            // SAFETY: openat returned a nonnegative descriptor with no other owner.
            let file = unsafe { std::fs::File::from_raw_fd(raw) };
            if !file.metadata()?.is_file() {
                return Err(invalid_data("vault input is not a regular file"));
            }
            Ok(file)
        }
    }

    /// Open this existing regular entry for writing without following a link.
    fn open_write(&self) -> std::io::Result<std::fs::File> {
        use std::os::fd::{AsRawFd, FromRawFd};
        // SAFETY: parent remains open and self.name is NUL-terminated.
        let raw = unsafe {
            libc::openat(
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if raw < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: openat returned a nonnegative descriptor with no other owner.
        let file = unsafe { std::fs::File::from_raw_fd(raw) };
        if !file.metadata()?.is_file() {
            return Err(invalid_data("sync candidate is not a regular file"));
        }
        Ok(file)
    }

    fn open_new(&self, name: &std::ffi::CStr) -> std::io::Result<std::fs::File> {
        use std::os::fd::{AsRawFd, FromRawFd};
        // SAFETY: parent remains open and name is NUL-terminated.
        let raw = unsafe {
            libc::openat(
                self.parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if raw < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            // SAFETY: openat returned a nonnegative descriptor with no other owner.
            let file = unsafe { std::fs::File::from_raw_fd(raw) };
            file_metadata::private(&file)?;
            Ok(file)
        }
    }

    pub(super) fn fingerprint(&self, name: &std::ffi::CStr) -> std::io::Result<(u64, String)> {
        use std::os::fd::{AsRawFd, FromRawFd};
        // SAFETY: parent remains open and name is NUL-terminated.
        let raw = unsafe {
            libc::openat(
                self.parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if raw < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: openat returned a nonnegative descriptor with no other owner.
        let file = unsafe { std::fs::File::from_raw_fd(raw) };
        if !file.metadata()?.is_file() {
            return Err(invalid_data("vault input is not a regular file"));
        }
        let (size, digest) = hash_reader(file)?;
        Ok((size, hex::encode(&digest)))
    }

    pub(super) fn unlink(&self, name: &std::ffi::CStr) -> std::io::Result<()> {
        use std::os::fd::AsRawFd;
        // SAFETY: parent remains open and name is NUL-terminated.
        if unsafe { libc::unlinkat(self.parent.as_raw_fd(), name.as_ptr(), 0) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    fn rename_entry_no_replace(&self, to: &Self) -> std::io::Result<()> {
        use std::os::fd::AsRawFd;
        let from_fd = self.parent.as_raw_fd();
        let to_fd = to.parent.as_raw_fd();
        let moved = renameat_no_replace(&self.parent, &self.name, &to.parent, &to.name);
        if moved == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if !exclusive_rename_unsupported(error.raw_os_error()) {
            return Err(error);
        }
        // SAFETY: both parent Files remain open and both names are NUL-terminated.
        if unsafe { libc::linkat(from_fd, self.name.as_ptr(), to_fd, to.name.as_ptr(), 0) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if let Err(error) = self.unlink(&self.name) {
            let _ = to.unlink(&to.name);
            return Err(error);
        }
        Ok(())
    }

    /// Move only the expected bytes. If a writer changed the source between
    /// the caller's check and the move, move it back and report
    /// [`is_source_changed`]; never strand the new bytes in recovery storage.
    pub(super) fn move_no_replace(&self, to: &Self, size: u64, hash: &str) -> std::io::Result<()> {
        #[cfg(test)]
        run_before_move_hook();
        self.rename_entry_no_replace(to)?;
        match to.fingerprint(&to.name) {
            Ok(actual) if fingerprint_matches(&actual, size, hash) => Ok(()),
            _ => match to.rename_entry_no_replace(self) {
                Ok(()) => Err(source_changed()),
                Err(restore) => Err(invalid_data(format!(
                    "rooted move failed final verification; moved bytes kept at {}: {restore}",
                    to.display.display()
                ))),
            },
        }
    }

    /// Move a regular file or directory using held parents; never replace a destination.
    pub(crate) fn move_entry_no_replace(&self, to: &Self) -> std::io::Result<()> {
        use std::os::fd::AsRawFd;
        let mut meta = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: both parent descriptors and NUL-terminated names remain owned.
        let checked = unsafe {
            libc::fstatat(
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                meta.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if checked != 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: successful fstatat initialized the metadata.
        let kind = unsafe { meta.assume_init() }.st_mode & libc::S_IFMT;
        if kind != libc::S_IFREG && kind != libc::S_IFDIR {
            return Err(invalid_data("recovery source must be a file or directory"));
        }
        if renameat_no_replace(&self.parent, &self.name, &to.parent, &to.name) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        self.parent.sync_all()?;
        to.parent.sync_all()
    }

    pub(crate) fn remove_entry(&self) -> std::io::Result<()> {
        use std::os::fd::AsRawFd;
        // SAFETY: the held parent and name are valid; no directory recursion or link traversal.
        if unsafe { libc::unlinkat(self.parent.as_raw_fd(), self.name.as_ptr(), 0) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        self.parent.sync_all()
    }

    /// Remove this entry only if it is an empty directory.
    pub(crate) fn remove_empty_dir(&self) -> std::io::Result<()> {
        use std::os::fd::AsRawFd;
        // SAFETY: the held parent and name are valid; AT_REMOVEDIR never recurses.
        if unsafe {
            libc::unlinkat(
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                libc::AT_REMOVEDIR,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        self.parent.sync_all()
    }

    /// Permanently remove this file or folder tree through held directory
    /// handles. Every descent is `openat(O_DIRECTORY | O_NOFOLLOW)` from the
    /// already open parent, so a link swapped in anywhere (including an
    /// ancestor after validation) is unlinked as a link or refused, never
    /// followed. Iterative and bounded by `max_depth` levels and `max_entries`
    /// removals; reaching a bound fails closed, leaving the rest in place.
    pub(crate) fn remove_tree_no_follow(
        &self,
        max_depth: usize,
        max_entries: usize,
    ) -> std::io::Result<()> {
        match entry_kind(&self.parent, &self.name)? {
            libc::S_IFREG => return self.remove_entry(),
            libc::S_IFDIR => {}
            _ => return Err(invalid_data("recovery item must be a file or folder")),
        }
        let mut stack = vec![TreeFrame::open(&self.parent, &self.name)?];
        // Entries met so far, this item included. Each pass handles one entry
        // (unlink or descend) or closes one emptied folder, so at most
        // `2 * max_entries` passes remove an item within the bound.
        let mut seen = 1usize;
        for _ in 0..max_entries.saturating_mul(2).saturating_add(1) {
            let Some(frame) = stack.last_mut() else {
                return self.parent.sync_all();
            };
            let Some(name) = frame.names.pop() else {
                let done = stack.pop().ok_or_else(|| invalid_data("empty stack"))?;
                unlink_at(&done.parent, &done.name, libc::AT_REMOVEDIR)?;
                continue;
            };
            seen += 1;
            if seen > max_entries {
                return Err(invalid_data("recovery item has too many entries"));
            }
            let name = std::ffi::CString::new(name)
                .map_err(|_| invalid_data("directory entry contains NUL"))?;
            if entry_kind(&frame.dir, &name)? != libc::S_IFDIR {
                // Files, links and special files: unlinkat never follows.
                unlink_at(&frame.dir, &name, 0)?;
                continue;
            }
            let child = TreeFrame::open(&frame.dir, &name)?;
            if stack.len() >= max_depth {
                return Err(invalid_data("recovery item is nested too deeply"));
            }
            stack.push(child);
        }
        Err(invalid_data("recovery item has too many entries"))
    }

    pub fn rename_no_replace(&self, to: &Self) -> std::io::Result<()> {
        let (size, hash) = self.fingerprint(&self.name)?;
        self.move_no_replace(to, size, &hash)
    }

    pub(super) fn child(&self, name: &str) -> std::io::Result<Self> {
        let name = std::ffi::CString::new(name).map_err(|_| invalid_data("invalid child name"))?;
        let display = self.display.with_file_name(name.to_string_lossy().as_ref());
        Ok(Self {
            parent: self.parent.try_clone()?,
            name,
            display,
        })
    }

    pub(super) fn list_parent_names(&self) -> std::io::Result<Vec<String>> {
        Self::list_dir_names(&self.parent)
    }

    pub(super) fn list_dir_names(dir_handle: &std::fs::File) -> std::io::Result<Vec<String>> {
        use std::os::fd::AsRawFd;
        // SAFETY: dir_handle owns an open descriptor throughout dup.
        let duplicate = unsafe { libc::dup(dir_handle.as_raw_fd()) };
        if duplicate < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: duplicate is nonnegative and ownership transfers to DIR only on success.
        let dir = unsafe { libc::fdopendir(duplicate) };
        if dir.is_null() {
            let error = std::io::Error::last_os_error();
            // SAFETY: fdopendir failed, so duplicate is still owned here and must be closed.
            unsafe { libc::close(duplicate) };
            return Err(error);
        }
        let mut names = Vec::new();
        loop {
            // SAFETY: dir is a live DIR pointer until closedir after this loop.
            let entry = unsafe { libc::readdir(dir) };
            if entry.is_null() {
                break;
            }
            // SAFETY: entry is non-null and its d_name remains valid until the next readdir call.
            let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            match name.to_str() {
                Ok(name) => names.push(name.to_string()),
                Err(_) => {
                    // SAFETY: dir is live and this branch exits before any later use.
                    unsafe { libc::closedir(dir) };
                    return Err(invalid_data("directory contains a non-UTF-8 name"));
                }
            }
        }
        // SAFETY: dir is live and is closed exactly once after iteration.
        unsafe { libc::closedir(dir) };
        Ok(names)
    }
}

/// One folder being emptied by [`RootedTarget::remove_tree_no_follow`].
#[cfg(unix)]
struct TreeFrame {
    parent: std::fs::File,
    name: std::ffi::CString,
    dir: std::fs::File,
    names: Vec<String>,
}

#[cfg(unix)]
impl TreeFrame {
    fn open(parent: &std::fs::File, name: &std::ffi::CStr) -> std::io::Result<Self> {
        use std::os::fd::{AsRawFd, FromRawFd};
        // SAFETY: parent is open and name is NUL-terminated; O_NOFOLLOW refuses a link.
        let raw = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if raw < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: openat returned a nonnegative descriptor with no other owner.
        let dir = unsafe { std::fs::File::from_raw_fd(raw) };
        let names = RootedTarget::list_dir_names(&dir)?;
        Ok(Self {
            parent: parent.try_clone()?,
            name: name.to_owned(),
            dir,
            names,
        })
    }
}

/// `S_IFMT` bits of `name` in `dir`, without following a final link.
#[cfg(unix)]
fn entry_kind(dir: &std::fs::File, name: &std::ffi::CStr) -> std::io::Result<libc::mode_t> {
    use std::os::fd::AsRawFd;
    let mut meta = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: dir is open, name is NUL-terminated and meta is writable.
    let checked = unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            meta.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if checked != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: successful fstatat initialized the metadata.
    Ok(unsafe { meta.assume_init() }.st_mode & libc::S_IFMT)
}

#[cfg(unix)]
fn unlink_at(
    dir: &std::fs::File,
    name: &std::ffi::CStr,
    flags: libc::c_int,
) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: dir is open and name is NUL-terminated; unlinkat never follows links.
    if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), flags) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

pub struct StagedReceive {
    // Close the candidate handle before the staged file removes it.
    file: std::fs::File,
    staged: StagedFile,
    hasher: ContentHasher,
    max_bytes: u64,
    expected_size: Option<u64>,
    expected_hash: Option<String>,
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if !self.preserve {
            #[cfg(unix)]
            if let Some(rooted) = &self.rooted {
                use std::os::fd::AsRawFd;
                // SAFETY: rooted.parent remains open and candidate is NUL-terminated.
                let _ = unsafe {
                    libc::unlinkat(rooted.parent.as_raw_fd(), rooted.candidate.as_ptr(), 0)
                };
                return;
            }
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl StagedFile {
    #[cfg(unix)]
    fn publish_rooted(&mut self, name: &std::ffi::OsStr) -> std::io::Result<CommitOutcome> {
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;
        let dest = std::ffi::CString::new(name.as_bytes())
            .map_err(|_| invalid_data("sync destination contains NUL"))?;
        let rooted = self
            .rooted
            .as_ref()
            .ok_or_else(|| invalid_data("missing rooted stage"))?;
        let target = RootedTarget {
            parent: rooted.parent.try_clone()?,
            name: dest.clone(),
            display: self.path.with_file_name(name),
        };
        match target.fingerprint(&dest) {
            Ok(actual) if fingerprint_matches(&actual, self.size, &self.hash) => {
                return Ok(CommitOutcome::Unchanged);
            }
            Ok(_) => return Err(collision_error(&target.display)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let fd = rooted.parent.as_raw_fd();
        let renamed = renameat_no_replace(&rooted.parent, &rooted.candidate, &rooted.parent, &dest);
        let linked = if renamed == 0 {
            false
        } else {
            let error = std::io::Error::last_os_error();
            if !exclusive_rename_unsupported(error.raw_os_error()) {
                return match target.fingerprint(&dest) {
                    Ok(actual) if fingerprint_matches(&actual, self.size, &self.hash) => {
                        Ok(CommitOutcome::Unchanged)
                    }
                    Ok(_) => Err(collision_error(&target.display)),
                    Err(_) => Err(error),
                };
            }
            // SAFETY: the parent File remains open and both names are NUL-terminated.
            if unsafe { libc::linkat(fd, rooted.candidate.as_ptr(), fd, dest.as_ptr(), 0) } < 0 {
                return Err(std::io::Error::last_os_error());
            }
            true
        };
        match target.fingerprint(&dest) {
            Ok(actual) if fingerprint_matches(&actual, self.size, &self.hash) => {
                if linked {
                    target.unlink(&rooted.candidate)?;
                }
                Ok(CommitOutcome::Created)
            }
            result => {
                self.preserve = linked;
                Err(invalid_data(format!(
                    "rooted sync publication failed verification: {result:?}"
                )))
            }
        }
    }

    pub fn begin(
        target: &Path,
        max_bytes: u64,
        expected_size: Option<u64>,
        expected_hash: Option<&str>,
    ) -> Result<StagedReceive, ReceiveError> {
        let mut created = CreatedDirs::default();
        // The Windows guard creates missing ancestors itself; record them first.
        #[cfg(windows)]
        created.paths.extend(missing_parents(target));
        #[cfg(windows)]
        let parents = WindowsParentGuard::acquire(target, true).map_err(ReceiveError::Write)?;
        ensure_real_parent_tracked(target, &mut created).map_err(ReceiveError::Write)?;
        let mut opened = None;
        for _ in 0..16 {
            let path = candidate_path(target);
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            match options.open(&path) {
                Ok(file) => {
                    #[cfg(unix)]
                    if let Err(error) = file_metadata::private(&file) {
                        let _ = std::fs::remove_file(&path);
                        return Err(ReceiveError::Write(error));
                    }
                    opened = Some((path, file));
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(ReceiveError::Write(e)),
            }
        }
        let (path, file) = opened.ok_or_else(|| {
            ReceiveError::Write(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "could not allocate a unique sync candidate",
            ))
        })?;
        Ok(StagedReceive {
            staged: Self {
                #[cfg(windows)]
                _parents: parents,
                path,
                size: 0,
                hash: String::new(),
                preserve: false,
                #[cfg(unix)]
                rooted: None,
                _created: created,
            },
            file,
            hasher: ContentHasher::new(),
            max_bytes,
            expected_size,
            expected_hash: expected_hash.map(str::to_string),
        })
    }

    #[cfg(unix)]
    pub fn begin_rooted(
        root: &Path,
        rel: &str,
        max_bytes: u64,
        expected_size: Option<u64>,
        expected_hash: Option<&str>,
    ) -> Result<StagedReceive, ReceiveError> {
        let mut created = CreatedDirs::default();
        let target = RootedTarget::resolve_tracked(root, rel, true, &mut created)
            .map_err(ReceiveError::Write)?;
        for _ in 0..16 {
            let path = candidate_path(&target.display);
            let candidate = std::ffi::CString::new(
                path.file_name()
                    .ok_or_else(|| ReceiveError::Write(invalid_data("candidate has no name")))?
                    .to_string_lossy()
                    .as_bytes(),
            )
            .map_err(|_| ReceiveError::Write(invalid_data("candidate contains NUL")))?;
            match target.open_new(&candidate) {
                Ok(file) => {
                    return Ok(StagedReceive {
                        staged: Self {
                            path,
                            size: 0,
                            hash: String::new(),
                            preserve: false,
                            rooted: Some(RootedStage {
                                parent: target.parent,
                                candidate,
                            }),
                            _created: created,
                        },
                        file,
                        hasher: ContentHasher::new(),
                        max_bytes,
                        expected_size,
                        expected_hash: expected_hash.map(str::to_string),
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(ReceiveError::Write(error)),
            }
        }
        Err(ReceiveError::Write(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "could not allocate a unique sync candidate",
        )))
    }

    /// Receive with fixed 64 KiB memory, hash during the write, then verify the
    /// staged disk bytes. The target remains untouched on every receive error.
    pub fn receive(
        target: &Path,
        mut reader: impl Read,
        max_bytes: u64,
        expected_size: Option<u64>,
        expected_hash: Option<&str>,
    ) -> Result<Self, ReceiveError> {
        let mut receive = Self::begin(target, max_bytes, expected_size, expected_hash)?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = match reader.read(&mut buffer) {
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                result => result.map_err(ReceiveError::Read)?,
            };
            if n == 0 {
                break;
            }
            receive.write_chunk(&buffer[..n])?;
        }
        receive.finish()
    }

    #[cfg(unix)]
    pub fn receive_rooted(
        root: &Path,
        rel: &str,
        mut reader: impl Read,
        max_bytes: u64,
        expected_size: Option<u64>,
        expected_hash: Option<&str>,
    ) -> Result<Self, ReceiveError> {
        let mut receive = Self::begin_rooted(root, rel, max_bytes, expected_size, expected_hash)?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = match reader.read(&mut buffer) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                result => result.map_err(ReceiveError::Read)?,
            };
            if n == 0 {
                break;
            }
            receive.write_chunk(&buffer[..n])?;
        }
        receive.finish()
    }

    fn publish(&mut self, target: &Path) -> std::io::Result<CommitOutcome> {
        #[cfg(windows)]
        let _target_parents = WindowsParentGuard::acquire(target, true)?;
        // Repeat the existing-file check for idempotency and numbered conflicts.
        // The exclusive rename remains authoritative for a race after this check.
        match destination_state(&StdCommitFs, target, self.size, &self.hash)? {
            Some(true) => return Ok(CommitOutcome::Unchanged),
            Some(false) => return Err(collision_error(target)),
            None => {}
        }
        publish_verified_candidate(
            &StdCommitFs,
            &self.path,
            target,
            self.size,
            &self.hash,
            &mut self.preserve,
        )
    }

    pub fn commit(mut self, target: &Path) -> std::io::Result<CommitOutcome> {
        #[cfg(unix)]
        if self.rooted.is_some() {
            return self.publish_rooted(
                target
                    .file_name()
                    .ok_or_else(|| invalid_data("target has no name"))?,
            );
        }
        self.publish(target)
    }

    /// Publish a one-sided edit only while the target still has the shared
    /// base bytes. The verified candidate first takes a fresh `.mesa-trash`
    /// name; one atomic replace (`atomic_replace`) then puts it at the target
    /// and the displaced original at that recovery name. The note is never
    /// missing and its original is never under a disposable name. Bytes that
    /// another writer put in the target meanwhile go back and are reported as
    /// a conflict. A filesystem without atomic replace refuses unchanged.
    pub fn commit_replace(
        mut self,
        root: &Path,
        rel: &str,
        expected_size: u64,
        expected_hash: &str,
    ) -> std::io::Result<CommitOutcome> {
        let target_path = safe_join_confined(root, rel)
            .ok_or_else(|| invalid_data("unsafe replacement target"))?;
        let expected = (expected_size, expected_hash);
        #[cfg(unix)]
        {
            self.replace_rooted(root, rel, &target_path, expected)
        }
        #[cfg(not(unix))]
        {
            self.replace_paths(root, rel, &target_path, expected)
        }
    }

    #[cfg(unix)]
    fn replace_rooted(
        &mut self,
        root: &Path,
        rel: &str,
        target_path: &Path,
        (size, hash): (u64, &str),
    ) -> std::io::Result<CommitOutcome> {
        use std::os::fd::AsRawFd;
        // One held parent serves the check, metadata copy, exchange and put-back.
        let source = RootedTarget::resolve(root, rel, false)?;
        if !fingerprint_matches(&source.fingerprint(&source.name)?, size, hash) {
            return Err(collision_error(target_path));
        }
        let stage = self.stage_entry(&source)?;
        file_metadata::preserve(&source.open_read()?, &stage.open_write()?)?;
        let (tomb_rel, tomb) = stage_into_tomb(root, rel, &stage)?;
        // The candidate name is gone; never unlink whatever later takes it.
        self.preserve = true;
        #[cfg(test)]
        run_before_move_hook();
        let (tomb_fd, source_fd) = (tomb.parent.as_raw_fd(), source.parent.as_raw_fd());
        if let Err(error) = exchange_at(tomb_fd, &tomb.name, source_fd, &source.name) {
            // The target is intact; drop only the candidate's recovery copy.
            if self.holds_stage(tomb.fingerprint(&tomb.name)) {
                let _ = tomb.unlink(&tomb.name);
            }
            return Err(replace_error(error));
        }
        let kept = |error: std::io::Error| kept_at(error, &tomb_rel);
        #[cfg(test)]
        take_after_exchange_failure()
            .map_or(Ok(()), Err)
            .map_err(kept)?;
        if !fingerprint_matches(&tomb.fingerprint(&tomb.name).map_err(kept)?, size, hash) {
            return Err(self.put_back_rooted(&source, &tomb, &tomb_rel, target_path));
        }
        flush_replaced(&[&source.parent, &tomb.parent]);
        if self.holds_stage(source.fingerprint(&source.name)) {
            Ok(CommitOutcome::Created)
        } else {
            Err(kept(invalid_data("replacement changed before read-back")))
        }
    }

    /// The stage as a rooted entry. A path stage is its target's sibling.
    #[cfg(unix)]
    fn stage_entry(&self, source: &RootedTarget) -> std::io::Result<RootedTarget> {
        if let Some(rooted) = &self.rooted {
            return Ok(RootedTarget {
                parent: rooted.parent.try_clone()?,
                name: rooted.candidate.clone(),
                display: self.path.clone(),
            });
        }
        if self.path.parent() != source.display.parent() {
            return Err(invalid_data("sync candidate is not beside its target"));
        }
        let name = self.path.file_name().and_then(|name| name.to_str());
        source.child(name.ok_or_else(|| invalid_data("candidate has no name"))?)
    }

    /// Another writer changed the target before the exchange took it: swap
    /// those bytes back and drop the candidate, or name where they are kept.
    #[cfg(unix)]
    fn put_back_rooted(
        &self,
        source: &RootedTarget,
        tomb: &RootedTarget,
        tomb_rel: &str,
        target_path: &Path,
    ) -> std::io::Error {
        use std::os::fd::AsRawFd;
        let (tomb_fd, source_fd) = (tomb.parent.as_raw_fd(), source.parent.as_raw_fd());
        if let Err(error) = exchange_at(tomb_fd, &tomb.name, source_fd, &source.name) {
            return changed_during_replace(tomb_rel, &error.to_string());
        }
        if !self.holds_stage(tomb.fingerprint(&tomb.name)) {
            return changed_during_replace(tomb_rel, "the target changed again");
        }
        let _ = tomb.unlink(&tomb.name);
        collision_error(target_path)
    }

    #[cfg(not(unix))]
    fn replace_paths(
        &mut self,
        root: &Path,
        rel: &str,
        target_path: &Path,
        (size, hash): (u64, &str),
    ) -> std::io::Result<CommitOutcome> {
        #[cfg(windows)]
        let _target_parents = WindowsParentGuard::acquire(target_path, false)?;
        if !fingerprint_matches(&hash_file_streaming(target_path)?, size, hash) {
            return Err(collision_error(target_path));
        }
        let (tomb_rel, tomb) = unused_tomb(root, rel, 0)?;
        #[cfg(windows)]
        let _tomb_parents = WindowsParentGuard::acquire(&tomb, true)?;
        #[cfg(not(windows))]
        ensure_real_parent(&tomb)?;
        #[cfg(test)]
        run_before_move_hook();
        if let Err(error) = replace_preserving(&self.path, target_path, &tomb) {
            let error = replace_error(error);
            return Err(if std::fs::symlink_metadata(&tomb).is_ok() {
                kept_at(error, &tomb_rel)
            } else {
                error
            });
        }
        // The candidate now has the target's name; never remove it as a stage.
        self.preserve = true;
        let kept = |error: std::io::Error| kept_at(error, &tomb_rel);
        #[cfg(test)]
        take_after_exchange_failure()
            .map_or(Ok(()), Err)
            .map_err(kept)?;
        if !fingerprint_matches(&hash_file_streaming(&tomb).map_err(kept)?, size, hash) {
            return Err(self.put_back_paths(root, rel, target_path, &tomb_rel));
        }
        if self.holds_stage(hash_file_streaming(target_path)) {
            Ok(CommitOutcome::Created)
        } else {
            Err(kept(invalid_data("replacement changed before read-back")))
        }
    }

    /// [`Self::put_back_rooted`] for path platforms: replace the target with
    /// the changed bytes again, retaining the candidate under a spare name.
    #[cfg(not(unix))]
    fn put_back_paths(
        &self,
        root: &Path,
        rel: &str,
        target_path: &Path,
        tomb_rel: &str,
    ) -> std::io::Error {
        let Some(tomb) = safe_join(root, tomb_rel) else {
            return changed_during_replace(tomb_rel, "unsafe recovery path");
        };
        let (spare_rel, spare) = match unused_tomb(root, rel, 16) {
            Ok(found) => found,
            Err(error) => return changed_during_replace(tomb_rel, &error.to_string()),
        };
        if let Err(error) = replace_preserving(&tomb, target_path, &spare) {
            return changed_during_replace(tomb_rel, &error.to_string());
        }
        if !self.holds_stage(hash_file_streaming(&spare)) {
            return changed_during_replace(&spare_rel, "the target changed again");
        }
        let _ = std::fs::remove_file(&spare);
        collision_error(target_path)
    }

    /// Whether `observed` is exactly this stage's verified bytes.
    fn holds_stage(&self, observed: std::io::Result<(u64, String)>) -> bool {
        observed.is_ok_and(|actual| fingerprint_matches(&actual, self.size, &self.hash))
    }

    pub fn commit_conflict(
        mut self,
        root: &Path,
        base_rel: &str,
    ) -> std::io::Result<(CommitOutcome, String)> {
        #[cfg(unix)]
        if self.rooted.is_some() {
            for ordinal in 1..=10_000 {
                let rel = numbered_conflict_name(base_rel, ordinal);
                safe_join(root, &rel).ok_or_else(|| invalid_data("unsafe conflict path"))?;
                let name = Path::new(&rel)
                    .file_name()
                    .ok_or_else(|| invalid_data("conflict has no name"))?;
                match self.publish_rooted(name) {
                    Ok(outcome) => return Ok((outcome, rel)),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error),
                }
            }
            return Err(invalid_data("too many same-day conflict copies"));
        }
        for ordinal in 1..=10_000 {
            let rel = numbered_conflict_name(base_rel, ordinal);
            let target = safe_join_confined(root, &rel).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("unsafe destination path {rel:?}"),
                )
            })?;
            match self.publish(&target) {
                Ok(outcome) => return Ok((outcome, rel)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "too many same-day conflict copies",
        ))
    }
}

impl StagedReceive {
    pub fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), ReceiveError> {
        if bytes.len() as u64 > self.max_bytes.saturating_sub(self.staged.size) {
            return Err(ReceiveError::TooLarge {
                limit: self.max_bytes,
            });
        }
        self.file.write_all(bytes).map_err(ReceiveError::Write)?;
        self.hasher.update(bytes);
        self.staged.size += bytes.len() as u64;
        Ok(())
    }

    pub fn finish(mut self) -> Result<StagedFile, ReceiveError> {
        if let Some(expected) = self.expected_size {
            if self.staged.size != expected {
                return Err(ReceiveError::SizeMismatch {
                    expected,
                    actual: self.staged.size,
                });
            }
        }
        self.staged.hash = self.hasher.hex();
        if let Some(expected) = &self.expected_hash {
            if !expected.eq_ignore_ascii_case(&self.staged.hash) {
                return Err(ReceiveError::HashMismatch {
                    expected: expected.clone(),
                    actual: self.staged.hash.clone(),
                });
            }
        }
        self.file.sync_all().map_err(ReceiveError::Write)?;
        drop(self.file);
        #[cfg(unix)]
        let actual = if let Some(rooted) = &self.staged.rooted {
            let target = RootedTarget {
                parent: rooted.parent.try_clone().map_err(ReceiveError::Write)?,
                name: rooted.candidate.clone(),
                display: self.staged.path.clone(),
            };
            target
                .fingerprint(&rooted.candidate)
                .map_err(ReceiveError::Write)?
        } else {
            hash_file_streaming(&self.staged.path).map_err(ReceiveError::Write)?
        };
        #[cfg(not(unix))]
        let actual = hash_file_streaming(&self.staged.path).map_err(ReceiveError::Write)?;
        if !fingerprint_matches(&actual, self.staged.size, &self.staged.hash) {
            return Err(ReceiveError::Write(invalid_data(format!(
                "sync candidate failed read-back verification: {}",
                self.staged.path.display()
            ))));
        }
        Ok(self.staged)
    }
}
/// The `.mesa-trash` name that keeps a replaced sync original, as before.
fn replacement_tomb_rel(rel: &str, offset: u64) -> String {
    let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    format!(
        "{}{}.mesa-trash/{}-remote--{}",
        parent,
        if parent.is_empty() { "" } else { "/" },
        now_ms().saturating_add(offset),
        name,
    )
}

/// Move the verified stage to a fresh recovery name through held parents.
#[cfg(unix)]
fn stage_into_tomb(
    root: &Path,
    rel: &str,
    stage: &RootedTarget,
) -> std::io::Result<(String, RootedTarget)> {
    for offset in 0..16u64 {
        let tomb_rel = replacement_tomb_rel(rel, offset);
        let tomb = RootedTarget::resolve(root, &tomb_rel, true)?;
        match stage.rename_entry_no_replace(&tomb) {
            Ok(()) => return Ok((tomb_rel, tomb)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(invalid_data("could not allocate replacement recovery path"))
}

/// A recovery name no entry has yet (ReplaceFileW overwrites a backup).
#[cfg(not(unix))]
fn unused_tomb(root: &Path, rel: &str, first: u64) -> std::io::Result<(String, PathBuf)> {
    for offset in first..first + 16 {
        let tomb_rel = replacement_tomb_rel(rel, offset);
        let tomb = safe_join(root, &tomb_rel)
            .ok_or_else(|| invalid_data("unsafe replacement recovery path"))?;
        if std::fs::symlink_metadata(&tomb).is_err() {
            return Ok((tomb_rel, tomb));
        }
    }
    Err(invalid_data("could not allocate replacement recovery path"))
}

/// The publication already happened; a failed folder flush only weakens
/// crash durability, so it is logged, never reported as a failed replace.
#[cfg(unix)]
fn flush_replaced(dirs: &[&std::fs::File]) {
    for dir in dirs {
        if let Err(error) = dir.sync_all() {
            eprintln!("[mesa] sync replaced a file but could not flush its folder: {error}");
        }
    }
}

const UNSUPPORTED_SYNC_REPLACE: &str = "unsupported-filesystem: This vault's filesystem does not support Mesa's atomic replace, so sync cannot update existing files here. The local file is unchanged.";

fn replace_error(error: std::io::Error) -> std::io::Error {
    if is_atomic_replace_unsupported(&error) {
        std::io::Error::new(std::io::ErrorKind::Unsupported, UNSUPPORTED_SYNC_REPLACE)
    } else {
        error
    }
}

fn kept_at(error: std::io::Error, tomb_rel: &str) -> std::io::Error {
    std::io::Error::new(
        error.kind(),
        format!("{error}; the previous version is kept at {tomb_rel}"),
    )
}

fn changed_during_replace(kept_rel: &str, detail: &str) -> std::io::Error {
    invalid_data(format!(
        "the file changed during replacement; other bytes are kept at {kept_rel}: {detail}"
    ))
}

/// Add a numeric collision suffix before the extension. The base conflict
/// name remains mirrored with TypeScript; this Rust-only helper prevents a
/// second same-day conflict from overwriting the first one.
pub fn numbered_conflict_name(base: &str, ordinal: u32) -> String {
    if ordinal <= 1 {
        return base.to_string();
    }
    let tag = format!(" ({ordinal})");
    let dot = base.rfind('.').map(|i| i as i64).unwrap_or(-1);
    let slash = base.rfind('/').map(|i| i as i64).unwrap_or(-1);
    if dot > slash {
        let d = dot as usize;
        format!("{}{}{}", &base[..d], tag, &base[d..])
    } else {
        format!("{base}{tag}")
    }
}

/// Check the contiguous conflict-copy sequence for identical bytes. Mesa's
/// own numbering is gap-free, so this avoids downloading and reporting the
/// same conflict on every later sync without scanning 10,000 missing paths.
pub fn conflict_copy_already_present(
    root: &Path,
    base_rel: &str,
    expected_size: u64,
    expected_hash: &str,
) -> std::io::Result<bool> {
    for ordinal in 1..=10_000 {
        let dest_rel = numbered_conflict_name(base_rel, ordinal);
        #[cfg(unix)]
        let actual = RootedTarget::resolve(root, &dest_rel, false)
            .and_then(|target| target.fingerprint(&target.name));
        #[cfg(not(unix))]
        let actual = {
            let dest = safe_join_confined(root, &dest_rel).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("unsafe destination path {dest_rel:?}"),
                )
            })?;
            hash_file_streaming(&dest)
        };
        match actual {
            Ok(actual) if fingerprint_matches(&actual, expected_size, expected_hash) => {
                return Ok(true);
            }
            Ok(_) => continue,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e),
        }
    }
    Ok(false)
}

#[cfg(test)]
#[path = "sync_fs_tests.rs"]
mod tests;
