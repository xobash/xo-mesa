use super::*;
use std::os::unix::fs::PermissionsExt;
#[test]
fn stage_and_new_files_are_private_and_existing_modes_survive() {
    let dir = std::env::temp_dir().join(format!("mesa-save-metadata-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let stage = dir.join("stage");
    write_staged(&stage, b"private").unwrap();
    assert_eq!(
        fs::metadata(&stage).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let target = dir.join("note");
    write_atomic(&target, b"new", &ExpectedCurrent::Missing).unwrap();
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o600
    );
    for mode in [0o600, 0o640, 0o604] {
        fs::set_permissions(&target, fs::Permissions::from_mode(mode)).unwrap();
        write_atomic(&target, b"edited", &ExpectedCurrent::Any).unwrap();
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            mode
        );
    }
    fs::remove_dir_all(dir).unwrap();
}
#[cfg(target_os = "macos")]
#[test]
fn macos_acl_and_xattrs_survive_save_and_inherited_acl_is_removed() {
    use std::process::Command;
    let dir = std::env::temp_dir().join(format!("mesa-save-acl-{}", std::process::id()));
    if dir.exists() {
        let _ = Command::new("chmod").arg("-RN").arg(&dir).status();
        let _ = fs::remove_dir_all(&dir);
    }
    fs::create_dir_all(&dir).unwrap();
    assert!(Command::new("chmod")
        .args(["+a", "everyone allow read,file_inherit,directory_inherit"])
        .arg(&dir)
        .status()
        .unwrap()
        .success());
    let target = dir.join("note");
    write_atomic(&target, b"private", &ExpectedCurrent::Missing).unwrap();
    let acl = |path: &Path| {
        let result = Command::new("ls").args(["-le"]).arg(path).output().unwrap();
        assert!(result.status.success());
        String::from_utf8(result.stdout)
            .unwrap()
            .lines()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
    };
    assert!(
        acl(&target).is_empty(),
        "New plaintext must not inherit broad ACL grants"
    );
    assert!(Command::new("chmod")
        .args(["+a", "everyone allow read"])
        .arg(&target)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("xattr")
        .args(["-w", "org.mesa.test", "synthetic-value"])
        .arg(&target)
        .status()
        .unwrap()
        .success());
    let before = acl(&target);
    assert!(!before.is_empty());
    write_atomic(&target, b"edited", &ExpectedCurrent::Any).unwrap();
    assert_eq!(acl(&target), before);
    let value = Command::new("xattr")
        .args(["-p", "org.mesa.test"])
        .arg(&target)
        .output()
        .unwrap();
    assert!(value.status.success());
    assert_eq!(value.stdout, b"synthetic-value\n");
    assert!(Command::new("chmod")
        .arg("-RN")
        .arg(&dir)
        .status()
        .unwrap()
        .success());
    fs::remove_dir_all(dir).unwrap();
}
#[cfg(target_os = "linux")]
#[test]
fn linux_posix_acl_and_user_xattr_survive_replacement() {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;
    let dir = std::env::temp_dir().join(format!("mesa-save-acl-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let target = dir.join("note");
    write_atomic(&target, b"private", &ExpectedCurrent::Missing).unwrap();
    let file = File::open(&target).unwrap();
    let mut acl = 2u32.to_le_bytes().to_vec();
    for (tag, perm, id) in [
        (1u16, 6u16, u32::MAX),
        (2, 4, 65534),
        (4, 0, u32::MAX),
        (16, 0, u32::MAX),
        (32, 0, u32::MAX),
    ] {
        acl.extend(tag.to_le_bytes());
        acl.extend(perm.to_le_bytes());
        acl.extend(id.to_le_bytes());
    }
    for (name, bytes) in [
        ("system.posix_acl_access", acl.as_slice()),
        ("user.mesa_test", b"synthetic-value".as_slice()),
    ] {
        let name = CString::new(name).unwrap();
        // SAFETY: live fd, terminated name and valid buffer length.
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    file.as_raw_fd(),
                    name.as_ptr(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    0,
                )
            },
            0
        );
    }
    write_atomic(&target, b"edited", &ExpectedCurrent::Any).unwrap();
    let file = File::open(&target).unwrap();
    for (name, expected) in [
        ("system.posix_acl_access", acl.as_slice()),
        ("user.mesa_test", b"synthetic-value".as_slice()),
    ] {
        let name = CString::new(name).unwrap();
        let mut value = vec![0u8; 1024];
        // SAFETY: live fd, terminated name and allocated output buffer.
        let n = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
            )
        };
        assert!(n >= 0);
        assert_eq!(&value[..n as usize], expected);
    }
    fs::remove_dir_all(dir).unwrap();
}
