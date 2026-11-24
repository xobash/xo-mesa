use super::*;

// A throwaway test key (its secret half was discarded) and its prehashed
// minisign signature of b"mesa test package" for version 0.2.0, in the
// formats `tauri signer` writes.
const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgRjVFMDlFNEM3ODRGOTA0OQpSV1QxNEo1TWVFK1FTVzRJVmlzUHRhOXNQMzRJdC95d1VJb0lneWZBVUZoaGJpTVVWMFQraUJzMgo=";
const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUMTRKNU1lRStRU2JPYXFvWTRtZy80VXd3aHdSdGpKYzI2d2dzRFlrV0k4WDFQYjhXV1JSbXY2MnBKUG9VRGFQZ2U0UTRwK1pvZkUxZzY3cDRxSk4zKy9EQ0pwWk9IYlFvPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzAwMDAwMDAwCWZpbGU6cGFja2FnZQl2ZXJzaW9uOjAuMi4wCm9HdGI4TnhXbURrei8yMk1JaXpJVWxxazdKUlNhaW1vNnVxM2xSTWxRSHVuYTllaE41ZzVkeTV2cnU5N1dTdDRBajNacGk0dmhrL0ViRWdzSSt3YUJBPT0K";
const PACKAGE: &[u8] = b"mesa test package";

fn scratch(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let dir =
        std::env::temp_dir().join(format!("mesa-update-{name}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

#[test]
fn a_staged_package_is_verified_again_with_key_and_signed_version() {
    assert_eq!(
        verify_package(PACKAGE, TEST_SIGNATURE, TEST_PUBKEY, "0.2.0"),
        Ok(())
    );
    assert_eq!(
        verify_package(PACKAGE, TEST_SIGNATURE, TEST_PUBKEY, "v0.2.0"),
        Ok(())
    );
    let refused = Err(SIGNATURE_REFUSED.to_string());
    assert_eq!(
        verify_package(b"mesa test packagf", TEST_SIGNATURE, TEST_PUBKEY, "0.2.0"),
        refused
    );
    // A genuine signature served under another version number.
    assert_eq!(
        verify_package(PACKAGE, TEST_SIGNATURE, TEST_PUBKEY, "0.3.0"),
        refused
    );
    assert_eq!(
        verify_package(
            PACKAGE,
            TEST_SIGNATURE,
            crate::updater::PLACEHOLDER_PUBKEY,
            "0.2.0"
        ),
        refused
    );
    assert_eq!(verify_package(PACKAGE, "", TEST_PUBKEY, "0.2.0"), refused);
}

#[test]
fn signed_version_reads_the_tauri_trusted_comment() {
    assert_eq!(
        signed_version("timestamp:1\tfile:a\tversion:1.2.3"),
        Some("1.2.3")
    );
    assert_eq!(signed_version("timestamp:1\tfile:a"), None);
}

#[test]
fn staging_replaces_the_previous_package_and_reads_back_bounded() {
    let dir = scratch("stage").join("updates");
    let first = stage_package(&dir, b"old").expect("stage");
    let second = stage_package(&dir, b"new").expect("restage");
    assert_eq!(first, second);
    assert_eq!(read_staged(&second).expect("read"), b"new");
    assert_eq!(std::fs::read_dir(&dir).expect("dir").count(), 1);
    std::fs::remove_dir_all(dir.parent().unwrap()).ok();
    assert!(read_staged(&second).is_err());
}

#[cfg(unix)]
fn app_archive(body: &[u8]) -> Vec<u8> {
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::fast(),
    ));
    let mut header = tar::Header::new_gnu();
    header.set_size(body.len() as u64);
    header.set_mode(0o755);
    header.set_cksum();
    builder
        .append_data(&mut header, "Mesa.app/Contents/MacOS/Mesa", body)
        .expect("append");
    builder.into_inner().expect("tar").finish().expect("gzip")
}

#[cfg(unix)]
fn installed(bundle: &Path) -> Vec<u8> {
    std::fs::read(bundle.join("Contents/MacOS/Mesa")).expect("binary")
}

#[cfg(unix)]
fn old_bundle(parent: &Path) -> PathBuf {
    let bundle = parent.join("Mesa.app");
    std::fs::create_dir_all(bundle.join("Contents/MacOS")).expect("bundle");
    std::fs::write(bundle.join("Contents/MacOS/Mesa"), b"old").expect("old binary");
    bundle
}

#[cfg(unix)]
#[test]
fn the_bundle_swap_installs_the_new_app_and_leaves_nothing_behind() {
    use std::os::unix::fs::PermissionsExt;
    let parent = scratch("swap");
    let bundle = old_bundle(&parent);
    swap_bundle(&bundle, &app_archive(b"new")).expect("swap");
    assert_eq!(installed(&bundle), b"new");
    let mode = std::fs::metadata(bundle.join("Contents/MacOS/Mesa"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o111, 0o111, "the binary stays executable");
    let names: Vec<_> = std::fs::read_dir(&parent)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from("Mesa.app")]);
    std::fs::remove_dir_all(parent).ok();
}

/// The refusal path: a folder Mesa may not change (here read-only, on macOS
/// also app-management protection) leaves the old app running and returns a
/// quiet message. Nothing falls back to an administrator prompt.
#[cfg(unix)]
#[test]
fn a_protected_folder_refuses_quietly_and_keeps_the_old_app() {
    use std::os::unix::fs::PermissionsExt;
    let parent = scratch("refuse");
    let bundle = old_bundle(&parent);
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o555)).unwrap();
    // Root ignores directory permissions; the refusal cannot be staged there.
    let probe = parent.join(".probe");
    if std::fs::create_dir(&probe).is_ok() {
        std::fs::remove_dir(&probe).ok();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir_all(parent).ok();
        return;
    }
    assert_eq!(
        swap_bundle(&bundle, &app_archive(b"new")),
        Err(BUNDLE_REFUSED.to_string())
    );
    assert_eq!(installed(&bundle), b"old");
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::remove_dir_all(parent).ok();
}

#[cfg(unix)]
#[test]
fn a_package_without_one_app_folder_is_refused_before_the_swap() {
    let parent = scratch("malformed");
    let bundle = old_bundle(&parent);
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::fast(),
    ));
    let mut header = tar::Header::new_gnu();
    header.set_size(1);
    header.set_cksum();
    builder
        .append_data(&mut header, "evil.txt", &b"x"[..])
        .unwrap();
    let archive = builder.into_inner().unwrap().finish().unwrap();
    assert!(swap_bundle(&bundle, &archive).is_err());
    assert!(swap_bundle(&bundle, b"not gzip").is_err());
    assert_eq!(installed(&bundle), b"old");
    let names: Vec<_> = std::fs::read_dir(&parent)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from("Mesa.app")]);
    std::fs::remove_dir_all(parent).ok();
}
