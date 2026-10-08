//! Confined file handles, staging, conditional publication and retained originals.
use super::*;

/// Create missing destination parents one component at a time and reject
/// symlink/junction components. The target has already passed
/// `safe_join_confined`; this second check closes the common validation-to-
/// create gap for nested transfers.
#[cfg(unix)]
pub fn ensure_real_parent(target: &Path) -> std::io::Result<()> {
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

#[cfg(not(unix))]
pub fn ensure_real_parent(target: &Path) -> std::io::Result<()> {
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
                    // Junctions and mount points are reparse points but need not
                    // report file_type().is_symlink(). Never create through one.
                    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
                    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
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
        let metadata = std::fs::symlink_metadata(&dir)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(invalid_data("sync target parent was replaced"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
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
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
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
    match error.raw_os_error() {
        Some(libc::EINVAL) | Some(libc::EOPNOTSUPP) => {
            Err(ExclusivePublishError::Unsupported(error))
        }
        _ => Err(ExclusivePublishError::Failed(error)),
    }
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
    // fails if another writer already created the destination.
    // SAFETY: both UTF-16 buffers are NUL-terminated and live through the call.
    let result =
        unsafe { MoveFileExW(from_wide.as_ptr(), to_wide.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if result != 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
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

#[cfg(test)]
pub(super) fn stage_candidate<F: CommitFs>(
    fs: &F,
    path: &Path,
    bytes: &[u8],
    size: u64,
    hash: &str,
) -> std::io::Result<PathBuf> {
    for _ in 0..16 {
        let candidate = candidate_path(path);
        match fs.write_new(&candidate, bytes) {
            Ok(()) => {
                let staged = match fs.fingerprint(&candidate) {
                    Ok(staged) => staged,
                    Err(e) => {
                        let _ = fs.remove_file(&candidate);
                        return Err(std::io::Error::new(
                            e.kind(),
                            format!(
                                "sync candidate read-back failed at {}: {e}",
                                candidate.display()
                            ),
                        ));
                    }
                };
                if !fingerprint_matches(&staged, size, hash) {
                    let _ = fs.remove_file(&candidate);
                    return Err(invalid_data(format!(
                        "sync candidate failed read-back verification: {}",
                        candidate.display()
                    )));
                }
                return Ok(candidate);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                // `write_all` or `sync_all` can fail after creating a partial
                // candidate. It is uniquely ours and safe to remove.
                let _ = fs.remove_file(&candidate);
                return Err(e);
            }
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate a unique sync candidate",
    ))
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

#[cfg(test)]
pub(super) fn commit_verified_create_with_fs<F: CommitFs>(
    fs: &F,
    path: &Path,
    bytes: &[u8],
    size: u64,
    hash: &str,
) -> std::io::Result<CommitOutcome> {
    if let Some(parent) = path.parent() {
        fs.create_dir_all(parent)?;
    }
    match destination_state(fs, path, size, hash)? {
        Some(true) => return Ok(CommitOutcome::Unchanged),
        Some(false) => return Err(collision_error(path)),
        None => {}
    }

    let candidate = stage_candidate(fs, path, bytes, size, hash)?;
    let mut preserve_candidate = false;
    let result =
        publish_verified_candidate(fs, &candidate, path, size, hash, &mut preserve_candidate);
    if !preserve_candidate {
        let _ = fs.remove_file(&candidate);
    }
    result
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

/// Commit a verified candidate only when `path` is missing. The platform's
/// native exclusive-rename primitive publishes the complete sibling candidate
/// without a check-then-rename race. A hard link is used only when the native
/// primitive reports that the filesystem does not support exclusive rename.
#[cfg(test)]
pub fn commit_verified_create(path: &Path, bytes: &[u8]) -> std::io::Result<CommitOutcome> {
    let size = bytes.len() as u64;
    let hash = content_hash_hex(bytes);
    commit_verified_create_with_fs(&StdCommitFs, path, bytes, size, &hash)
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
}

#[cfg(unix)]
pub(super) struct RootedStage {
    parent: std::fs::File,
    candidate: std::ffi::CString,
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
            let file = unsafe { std::fs::File::from_raw_fd(raw) };
            file_metadata::private(&file)?;
            Ok(file)
        }
    }

    pub fn resolve(root: &Path, rel: &str, create_parents: bool) -> std::io::Result<Self> {
        use std::os::fd::FromRawFd;
        let display = safe_join(root, rel).ok_or_else(|| invalid_data("unsafe sync path"))?;
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
                if made < 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
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
        let mut file = unsafe { std::fs::File::from_raw_fd(raw) };
        if !file.metadata()?.is_file() {
            return Err(invalid_data("vault input is not a regular file"));
        }
        let mut hash = ContentHasher::new();
        let mut size = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            size += n as u64;
            hash.update(&buffer[..n]);
        }
        Ok((size, hash.hex()))
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

    pub(super) fn move_no_replace(&self, to: &Self, size: u64, hash: &str) -> std::io::Result<()> {
        use std::os::fd::AsRawFd;
        let from_fd = self.parent.as_raw_fd();
        let to_fd = to.parent.as_raw_fd();
        #[cfg(target_os = "linux")]
        // SAFETY: both parent Files remain open and both names are NUL-terminated.
        let moved = unsafe {
            libc::renameat2(
                from_fd,
                self.name.as_ptr(),
                to_fd,
                to.name.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        // SAFETY: both parent Files remain open and both names are NUL-terminated.
        let moved = unsafe {
            libc::renameatx_np(
                from_fd,
                self.name.as_ptr(),
                to_fd,
                to.name.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let moved = -1;
        if moved < 0 {
            let error = std::io::Error::last_os_error();
            if !matches!(
                error.raw_os_error(),
                Some(libc::ENOSYS | libc::EINVAL | libc::EOPNOTSUPP)
            ) {
                return Err(error);
            }
            // SAFETY: both parent Files remain open and both names are NUL-terminated.
            if unsafe { libc::linkat(from_fd, self.name.as_ptr(), to_fd, to.name.as_ptr(), 0) } < 0
            {
                return Err(std::io::Error::last_os_error());
            }
            if let Err(error) = self.unlink(&self.name) {
                let _ = to.unlink(&to.name);
                return Err(error);
            }
        }
        let actual = to.fingerprint(&to.name)?;
        if fingerprint_matches(&actual, size, hash) {
            Ok(())
        } else {
            Err(invalid_data(
                "rooted journal move failed final verification",
            ))
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
        #[cfg(target_os = "linux")]
        let moved = unsafe {
            libc::renameat2(
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                to.parent.as_raw_fd(),
                to.name.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        let moved = unsafe {
            libc::renameatx_np(
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                to.parent.as_raw_fd(),
                to.name.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if moved != 0 {
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

pub struct StagedReceive {
    staged: StagedFile,
    file: std::fs::File,
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
        #[cfg(target_os = "linux")]
        // SAFETY: the parent File remains open and both names are NUL-terminated.
        let renamed = unsafe {
            libc::renameat2(
                fd,
                rooted.candidate.as_ptr(),
                fd,
                dest.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        // SAFETY: the parent File remains open and both names are NUL-terminated.
        let renamed = unsafe {
            libc::renameatx_np(
                fd,
                rooted.candidate.as_ptr(),
                fd,
                dest.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let renamed = -1;
        let linked = if renamed == 0 {
            false
        } else {
            let error = std::io::Error::last_os_error();
            if !matches!(
                error.raw_os_error(),
                Some(libc::ENOSYS | libc::EINVAL | libc::EOPNOTSUPP)
            ) {
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
        #[cfg(windows)]
        let parents = WindowsParentGuard::acquire(target, true).map_err(ReceiveError::Write)?;
        ensure_real_parent(target).map_err(ReceiveError::Write)?;
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
        let target = RootedTarget::resolve(root, rel, true).map_err(ReceiveError::Write)?;
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
    /// base bytes. Move those bytes into ordinary recovery storage first, so
    /// a failed publication or crash never silently destroys the old version.
    pub fn commit_replace(
        self,
        root: &Path,
        rel: &str,
        expected_size: u64,
        expected_hash: &str,
    ) -> std::io::Result<CommitOutcome> {
        let target_path = safe_join_confined(root, rel)
            .ok_or_else(|| invalid_data("unsafe replacement target"))?;
        let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel));
        let from = {
            #[cfg(unix)]
            {
                RootedTarget::resolve(root, rel, false)?
                    .fingerprint(&RootedTarget::resolve(root, rel, false)?.name)?
            }
            #[cfg(not(unix))]
            {
                hash_file_streaming(&target_path)?
            }
        };
        if !fingerprint_matches(&from, expected_size, expected_hash) {
            return Err(collision_error(&target_path));
        }
        #[cfg(unix)]
        {
            let original = RootedTarget::resolve(root, rel, false)?.open_read()?;
            let candidate = if let Some(rooted) = &self.rooted {
                {
                    use std::os::fd::{AsRawFd, FromRawFd};
                    // SAFETY: held parent and NUL-terminated candidate remain live.
                    let fd = unsafe {
                        libc::openat(
                            rooted.parent.as_raw_fd(),
                            rooted.candidate.as_ptr(),
                            libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                        )
                    };
                    if fd < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    // SAFETY: fd has exactly one owner.
                    unsafe { std::fs::File::from_raw_fd(fd) }
                }
            } else {
                use std::os::unix::fs::OpenOptionsExt;
                std::fs::OpenOptions::new()
                    .write(true)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(&self.path)?
            };
            file_metadata::preserve(&original, &candidate)?;
        }
        for offset in 0..16u64 {
            let tomb_rel = format!(
                "{}{}.mesa-trash/{}-remote--{}",
                parent,
                if parent.is_empty() { "" } else { "/" },
                now_ms().saturating_add(offset),
                name,
            );
            #[cfg(unix)]
            let move_result = {
                let source = RootedTarget::resolve(root, rel, false)?;
                let tomb = RootedTarget::resolve(root, &tomb_rel, true)?;
                source.move_no_replace(&tomb, expected_size, expected_hash)
            };
            #[cfg(not(unix))]
            let move_result = {
                let tomb = safe_join(root, &tomb_rel)
                    .ok_or_else(|| invalid_data("unsafe replacement recovery path"))?;
                move_no_replace(&target_path, &tomb, expected_size, expected_hash)
            };
            match move_result {
                Ok(()) => {
                    let publish = self.commit(&target_path);
                    if publish.is_err() {
                        #[cfg(unix)]
                        let restored = {
                            let tomb = RootedTarget::resolve(root, &tomb_rel, false)?;
                            let target = RootedTarget::resolve(root, rel, false)?;
                            tomb.move_no_replace(&target, expected_size, expected_hash)
                        };
                        #[cfg(not(unix))]
                        let restored = {
                            let tomb = safe_join(root, &tomb_rel)
                                .ok_or_else(|| invalid_data("unsafe replacement recovery path"))?;
                            move_no_replace(&tomb, &target_path, expected_size, expected_hash)
                        };
                        if let Err(restore_error) = restored {
                            return Err(invalid_data(format!(
                                "replacement failed; original preserved at {tomb_rel}; restore failed: {restore_error}"
                            )));
                        }
                    }
                    return publish;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(invalid_data("could not allocate replacement recovery path"))
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

/// Commit a conflict copy without replacing any existing same-day copy.
/// Identical bytes reuse the first matching numbered destination; different
/// bytes advance until an unused sibling is available.
#[cfg(test)]
pub fn commit_conflict_verified(
    root: &Path,
    base_rel: &str,
    bytes: &[u8],
) -> std::io::Result<(CommitOutcome, String)> {
    for ordinal in 1..=10_000 {
        let dest_rel = numbered_conflict_name(base_rel, ordinal);
        let dest = safe_join_confined(root, &dest_rel).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("unsafe destination path {dest_rel:?}"),
            )
        })?;
        match commit_verified_create(&dest, bytes) {
            Ok(outcome) => return Ok((outcome, dest_rel)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "too many same-day conflict copies",
    ))
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
#[path = "sync_tests.rs"]
mod tests;
