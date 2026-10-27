//! Preserve Unix access controls across inode replacement; refuse metadata loss.
#[cfg(unix)]
use std::{fs::File, io, os::fd::AsRawFd};

#[cfg(unix)]
pub(crate) fn preserve(source: &File, candidate: &File) -> io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let original = source.metadata()?;
    if !original.is_file() {
        return Err(io::Error::other("metadata source is not a regular file"));
    }
    let current = candidate.metadata()?;
    if (original.uid(), original.gid()) != (current.uid(), current.gid()) {
        // SAFETY: both descriptors remain owned by File; ids come from fstat.
        if unsafe { libc::fchown(candidate.as_raw_fd(), original.uid(), original.gid()) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    copy_access_metadata(source, candidate)?;
    candidate.set_permissions(std::fs::Permissions::from_mode(original.mode() & 0o7777))?;
    candidate.sync_all()
}

#[cfg(target_os = "macos")]
fn copy_access_metadata(source: &File, candidate: &File) -> io::Result<()> {
    // COPYFILE_STAT would also copy timestamps; edits must keep their new mtime.
    // SAFETY: live descriptors and a null optional state are valid for fcopyfile.
    let result = unsafe {
        libc::fcopyfile(
            source.as_raw_fd(),
            candidate.as_raw_fd(),
            std::ptr::null_mut(),
            libc::COPYFILE_ACL | libc::COPYFILE_XATTR,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn copy_access_metadata(source: &File, candidate: &File) -> io::Result<()> {
    use std::ffi::CString;
    // Includes POSIX ACL and security xattrs, not just user attributes.
    // SAFETY: null buffer queries the required size on a live descriptor.
    let count = unsafe { libc::flistxattr(source.as_raw_fd(), std::ptr::null_mut(), 0) };
    if count < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOTSUP) {
            return Ok(());
        }
        return Err(error);
    }
    let mut names = vec![0u8; count as usize];
    // SAFETY: allocated buffer has the declared length and descriptors are live.
    let count =
        unsafe { libc::flistxattr(source.as_raw_fd(), names.as_mut_ptr().cast(), names.len()) };
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    for name in names[..count as usize]
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
    {
        let name = CString::new(name)?;
        // SAFETY: name is terminated; null buffer queries size.
        let length =
            unsafe { libc::fgetxattr(source.as_raw_fd(), name.as_ptr(), std::ptr::null_mut(), 0) };
        if length < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut value = vec![0u8; length as usize];
        // SAFETY: name and allocated output buffer remain live through the call.
        let read = unsafe {
            libc::fgetxattr(
                source.as_raw_fd(),
                name.as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
            )
        };
        if read < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: read never exceeds the supplied buffer; flag 0 allows replacement.
        if unsafe {
            libc::fsetxattr(
                candidate.as_raw_fd(),
                name.as_ptr(),
                value.as_ptr().cast(),
                read as usize,
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

// macOS ACL grants are independent of POSIX mode. Remove inherited grants
// before writing private plaintext, including new files in ACL-bearing folders.
#[cfg(target_os = "macos")]
pub(crate) fn private(file: &File) -> io::Result<()> {
    use std::ffi::c_void;
    unsafe extern "C" {
        fn acl_init(count: libc::c_int) -> *mut c_void;
        fn acl_set_fd_np(fd: libc::c_int, acl: *mut c_void, kind: libc::c_int) -> libc::c_int;
        fn acl_free(acl: *mut c_void) -> libc::c_int;
    }
    // SAFETY: empty ACL is owned here and freed once; fd remains live.
    unsafe {
        let acl = acl_init(0);
        if acl.is_null() {
            return Err(io::Error::last_os_error());
        }
        let result = acl_set_fd_np(file.as_raw_fd(), acl, 0x100); // ACL_TYPE_EXTENDED
        let error = io::Error::last_os_error();
        acl_free(acl);
        if result != 0 {
            return Err(error);
        }
    }
    Ok(())
}
#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn private(_file: &File) -> io::Result<()> {
    Ok(())
}
