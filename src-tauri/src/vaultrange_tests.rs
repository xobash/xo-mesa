use super::*;
use std::fs;
use std::path::PathBuf;

struct TempVault(PathBuf);
impl TempVault {
    fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!(
            "mesa-vaultrange-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&p).unwrap();
        // Canonical, as `approved_path` hands out roots.
        TempVault(fs::canonicalize(p).unwrap())
    }
    fn file(&self, rel: &str, body: &[u8]) {
        let full = self.0.join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, body).unwrap();
    }
}
impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn split(body: &[u8]) -> (u64, u64, &[u8]) {
    let size = u64::from_le_bytes(body[0..8].try_into().unwrap());
    let mtime = u64::from_le_bytes(body[8..16].try_into().unwrap());
    (size, mtime, &body[HEADER_BYTES..])
}

fn sample(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

#[test]
fn reads_a_slice_at_any_offset_with_size_and_mtime() {
    let v = TempVault::new("slice");
    let body = sample(3 * 1024 * 1024 + 7);
    v.file("big.bin", &body);
    let offset = 2 * 1024 * 1024 + 3;
    let got = read_range(&v.0, "big.bin", offset as u64, 4096).unwrap();
    let (size, mtime, bytes) = split(&got);
    assert_eq!(size, body.len() as u64);
    assert!(mtime > 0);
    assert_eq!(bytes, &body[offset..offset + 4096]);
}

#[test]
fn a_slice_stops_at_end_of_file_and_offset_at_eof_is_empty() {
    let v = TempVault::new("eof");
    v.file("small.bin", b"0123456789");
    let tail = read_range(&v.0, "small.bin", 6, 1024).unwrap();
    assert_eq!(split(&tail).2, b"6789");
    let at_end = read_range(&v.0, "small.bin", 10, 16).unwrap();
    assert_eq!(split(&at_end).0, 10);
    assert!(split(&at_end).2.is_empty());
    v.file("empty.bin", b"");
    assert_eq!(split(&read_range(&v.0, "empty.bin", 0, 0).unwrap()).0, 0);
}

#[test]
fn offset_past_end_of_file_is_refused() {
    let v = TempVault::new("past");
    v.file("small.bin", b"0123456789");
    let err = read_range(&v.0, "small.bin", 11, 1).unwrap_err();
    assert!(err.contains("past the end"), "{err}");
    assert!(read_range(&v.0, "small.bin", u64::MAX, 1).is_err());
}

#[test]
fn length_is_capped_at_one_mebibyte() {
    let v = TempVault::new("cap");
    v.file("big.bin", &sample(2 * 1024 * 1024));
    let ok = read_range(&v.0, "big.bin", 0, MAX_RANGE_BYTES).unwrap();
    assert_eq!(ok.len(), HEADER_BYTES + MAX_RANGE_BYTES as usize);
    let err = read_range(&v.0, "big.bin", 0, MAX_RANGE_BYTES + 1).unwrap_err();
    assert!(err.contains("1 MiB"), "{err}");
}

#[test]
fn a_changed_file_reports_a_new_stamp() {
    let v = TempVault::new("change");
    v.file("a.bin", b"first version");
    let first = split(&read_range(&v.0, "a.bin", 0, 4).unwrap()).0;
    v.file("a.bin", b"second, longer version");
    let second = split(&read_range(&v.0, "a.bin", 0, 4).unwrap()).0;
    assert_ne!(first, second);
}

#[test]
fn paths_outside_or_hidden_are_refused() {
    let v = TempVault::new("escape");
    v.file("in.bin", b"inside");
    v.file(".git/config", b"[core]");
    let outside = TempVault::new("escape-outside");
    outside.file("secret.bin", b"outside");
    let traversal = format!(
        "../{}/secret.bin",
        outside.0.file_name().unwrap().to_str().unwrap()
    );
    for rel in [
        traversal.as_str(),
        ".git/config",
        "",
        "sub/../in.bin",
        "..\\in.bin",
    ] {
        assert!(read_range(&v.0, rel, 0, 4).is_err(), "{rel}");
    }
    assert!(read_range(&v.0, "in.bin", 0, 4).is_ok());
}

#[test]
fn a_directory_is_not_read() {
    let v = TempVault::new("dir");
    v.file("sub/inner.bin", b"x");
    assert!(read_range(&v.0, "sub", 0, 4).is_err());
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_escape_the_vault() {
    let v = TempVault::new("symlink");
    let outside = TempVault::new("symlink-outside");
    outside.file("secret.bin", b"outside");
    std::os::unix::fs::symlink(outside.0.join("secret.bin"), v.0.join("linked.bin")).unwrap();
    std::os::unix::fs::symlink(&outside.0, v.0.join("linked-dir")).unwrap();
    assert!(read_range(&v.0, "linked.bin", 0, 4).is_err());
    assert!(read_range(&v.0, "linked-dir/secret.bin", 0, 4).is_err());
}

/// Measured on the developer machine with `--ignored --nocapture`; not a gate.
#[test]
#[ignore]
fn measure_one_mebibyte_window() {
    let v = TempVault::new("measure");
    v.file("big.bin", &sample(64 * 1024 * 1024));
    let mut samples = Vec::new();
    for i in 0..32u64 {
        let started = std::time::Instant::now();
        let got = read_range(&v.0, "big.bin", i * 2 * MAX_RANGE_BYTES, MAX_RANGE_BYTES).unwrap();
        samples.push(started.elapsed());
        assert_eq!(got.len(), HEADER_BYTES + MAX_RANGE_BYTES as usize);
    }
    samples.sort();
    println!(
        "1 MiB range read: median {:?}, max {:?}",
        samples[samples.len() / 2],
        samples[samples.len() - 1]
    );
}
