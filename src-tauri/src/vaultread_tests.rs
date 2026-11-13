use super::*;
use std::fs;
use std::time::UNIX_EPOCH;

struct TempVault(PathBuf);
impl TempVault {
    fn new(tag: &str) -> Self {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "mesa-vaultread-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        TempVault(p)
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

#[test]
fn reads_are_sized_from_the_file_length() {
    let v = TempVault::new("presize");
    let body: Vec<u8> = (0..65_537u32).map(|i| (i % 251) as u8).collect();
    v.file("big.md", &body);
    let Ok(ReadResult::Content(bytes)) = read_file(&v.0.join("big.md"), 8 * 1024 * 1024) else {
        panic!("expected content");
    };
    assert_eq!(bytes, body);
    // A growing buffer would hold up to twice the file until the batch is encoded.
    assert_eq!(bytes.capacity(), body.len());
    let bounded = read_bounded(&v.0, "big.md", 8 * 1024 * 1024, true).unwrap();
    assert_eq!(bounded, body);
    assert_eq!(bounded.capacity(), body.len());
}

/// Decode the wire format the way the frontend does, so the tests exercise
/// the actual contract rather than the in-memory `Vec<Option<..>>`.
fn decode(body: &[u8]) -> Vec<Option<Vec<u8>>> {
    let count = u32::from_le_bytes(body[0..4].try_into().unwrap()) as usize;
    let mut at = 4;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let len = u32::from_le_bytes(body[at..at + 4].try_into().unwrap());
        at += 4;
        if len == READ_FAILED || len == READ_SKIPPED || len == READ_OFFLINE {
            out.push(None);
        } else {
            let len = len as usize;
            out.push(Some(body[at..at + len].to_vec()));
            at += len;
        }
    }
    assert_eq!(at, body.len(), "frame consumed exactly");
    out
}

fn round_trip(root: &Path, rels: &[&str]) -> Vec<Option<Vec<u8>>> {
    let rels: Vec<String> = rels.iter().map(|s| s.to_string()).collect();
    decode(&encode(&read_all(
        root,
        &rels,
        DEFAULT_MAX_TEXT_FILE_BYTES,
        None,
    )))
}

#[test]
fn online_only_files_have_their_own_marker() {
    // The frontend discloses these separately and never caches them as text.
    let body = encode(&[
        ReadResult::Offline,
        ReadResult::Skipped,
        ReadResult::Content(b"x".to_vec()),
    ]);
    assert_eq!(&body[4..8], &(u32::MAX - 2).to_le_bytes());
    assert_eq!(&body[8..12], &(u32::MAX - 1).to_le_bytes());
    assert_eq!(decode(&body), vec![None, None, Some(b"x".to_vec())]);
}

#[test]
fn reads_files_in_request_order() {
    let v = TempVault::new("order");
    v.file("a.md", b"alpha");
    v.file("deep/b.md", b"bravo");
    v.file("c.md", b"charlie");
    // Deliberately not sorted: the response must follow the REQUEST order,
    // because the frontend zips it back against its own file list.
    let got = round_trip(&v.0, &["c.md", "a.md", "deep/b.md"]);
    assert_eq!(
        got,
        vec![
            Some(b"charlie".to_vec()),
            Some(b"alpha".to_vec()),
            Some(b"bravo".to_vec())
        ]
    );
}

#[test]
fn unreadable_files_are_reported_per_file() {
    let v = TempVault::new("missing");
    v.file("ok.md", b"fine");
    let got = round_trip(&v.0, &["ok.md", "gone.md", "also-ok.md"]);
    assert_eq!(got[0], Some(b"fine".to_vec()));
    assert_eq!(got[1], None, "a missing file is a per-file failure");
    assert_eq!(got[2], None);
}

#[test]
fn a_directory_is_a_failure_not_a_read() {
    let v = TempVault::new("dir");
    v.file("sub/inner.md", b"x");
    assert_eq!(round_trip(&v.0, &["sub"]), vec![None]);
}

#[test]
fn rejects_paths_that_escape_the_root() {
    let v = TempVault::new("escape");
    v.file("in.md", b"inside");
    fs::write(v.0.parent().unwrap().join("mesa-outside.md"), b"outside").unwrap();
    let got = round_trip(
        &v.0,
        &["../mesa-outside.md", "./in.md", "sub/../../x", "", "in.md"],
    );
    assert_eq!(got[0], None, "..");
    assert_eq!(got[1], None, ".");
    assert_eq!(got[2], None, "embedded ..");
    assert_eq!(got[3], None, "empty");
    assert_eq!(got[4], Some(b"inside".to_vec()));
    let _ = fs::remove_file(v.0.parent().unwrap().join("mesa-outside.md"));
}

#[test]
fn hidden_and_dependency_paths_are_not_vault_text() {
    let v = TempVault::new("hidden");
    v.file(".git/config", b"[core]");
    v.file(".env", b"TOKEN=x");
    v.file(".mesa-trash/1/a.md", b"deleted");
    v.file("node_modules/pkg/readme.md", b"dependency");
    v.file("in.md", b"inside");
    let rels = [
        ".git/config",
        ".env",
        ".mesa-trash/1/a.md",
        "node_modules/pkg/readme.md",
        "in.md",
    ];
    let got = round_trip(&v.0, &rels);
    assert_eq!(got, vec![None, None, None, None, Some(b"inside".to_vec())]);
    let owned: Vec<String> = rels.iter().map(|rel| rel.to_string()).collect();
    let hashes = fingerprint_all(&v.0, &owned, None);
    assert!(hashes[..4].iter().all(Option::is_none));
    assert!(hashes[4].is_some());
}

// Unix stands in for a Windows 8.3 alias with a link: both spell a hidden
// folder under a visible name that the OS resolves.
#[cfg(unix)]
#[test]
fn short_name_aliases_of_hidden_folders_are_not_read() {
    let v = TempVault::new("alias");
    v.file(".git/config", b"[core]");
    std::os::unix::fs::symlink(".git", v.0.join("GIT~1")).unwrap();
    assert_eq!(round_trip(&v.0, &["GIT~1/config"]), vec![None]);
    let hashes = fingerprint_all(&v.0, &["GIT~1/config".to_string()], None);
    assert_eq!(hashes, vec![None]);
}

#[test]
fn renderer_text_limit_cannot_exceed_the_default() {
    assert_eq!(text_file_limit(None), DEFAULT_MAX_TEXT_FILE_BYTES);
    assert_eq!(text_file_limit(Some(u64::MAX)), DEFAULT_MAX_TEXT_FILE_BYTES);
    assert_eq!(text_file_limit(Some(4)), 4);
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_read_outside_the_vault() {
    let v = TempVault::new("symlink");
    v.file("in.md", b"inside");
    let outside = TempVault::new("symlink-outside");
    outside.file("secret.md", b"outside");
    std::os::unix::fs::symlink(&outside.0, v.0.join("linked-dir")).unwrap();
    std::os::unix::fs::symlink(outside.0.join("secret.md"), v.0.join("linked.md")).unwrap();
    let got = round_trip(&v.0, &["linked-dir/secret.md", "linked.md", "in.md"]);
    assert_eq!(got, vec![None, None, Some(b"inside".to_vec())]);
}

#[cfg(windows)]
#[test]
fn drive_prefix_segments_are_rejected() {
    let v = TempVault::new("prefix");
    v.file("in.md", b"inside");
    let got = round_trip(&v.0, &["C:Windows/win.ini", "D:x", "sub/C:x", "in.md"]);
    assert_eq!(got, vec![None, None, None, Some(b"inside".to_vec())]);
}

#[test]
fn backslash_segments_are_traversal_too() {
    // Windows accepts `\` as a separator, so `..\x` escapes there. The rel
    // paths Mesa produces are always forward-slashed, so rejecting both
    // spellings costs nothing and closes the platform-specific hole.
    let v = TempVault::new("backslash");
    v.file("in.md", b"inside");
    assert_eq!(round_trip(&v.0, &["..\\mesa-outside.md"]), vec![None]);
}

#[test]
fn preserves_bytes_exactly_including_invalid_utf8() {
    // The frontend decodes with a non-fatal TextDecoder, exactly as it does
    // for `plugin:fs|read_text_file`. Substitution must happen THERE, so
    // this side has to hand back the original bytes untouched.
    let v = TempVault::new("bytes");
    v.file("bad.txt", &[0x68, 0x69, 0xff, 0xfe, 0x0a]);
    v.file("crlf.txt", b"a\r\nb");
    v.file("empty.txt", b"");
    let got = round_trip(&v.0, &["bad.txt", "crlf.txt", "empty.txt"]);
    assert_eq!(got[0], Some(vec![0x68, 0x69, 0xff, 0xfe, 0x0a]));
    assert_eq!(got[1], Some(b"a\r\nb".to_vec()));
    assert_eq!(
        got[2],
        Some(Vec::new()),
        "empty file is a read, not a failure"
    );
}

#[test]
fn skips_all_oversized_text_before_reading_it() {
    let v = TempVault::new("oversized");
    v.file("huge.log", b"0123456789");
    v.file("note.md", b"0123456789");
    let rels = vec!["huge.log".to_string(), "note.md".to_string()];
    let got = decode(&encode(&read_all(&v.0, &rels, 4, None)));
    assert_eq!(got[0], None, "oversized search-only text is skipped");
    assert_eq!(got[1], None, "oversized Markdown is skipped too");
    let raw = read_all(&v.0, &rels, 4, None);
    assert!(matches!(raw[0], ReadResult::Skipped));
    assert!(matches!(raw[1], ReadResult::Skipped));
}

#[test]
fn empty_request_is_an_empty_frame() {
    let v = TempVault::new("none");
    let body = encode(&read_all(&v.0, &[], DEFAULT_MAX_TEXT_FILE_BYTES, None));
    assert_eq!(body, 0u32.to_le_bytes().to_vec());
    assert!(decode(&body).is_empty());
}

#[test]
fn large_batches_keep_order_across_threads() {
    // Order is the whole contract when more files than threads are in
    // flight; a serial implementation would pass this trivially, so the
    // batch is deliberately much larger than any core count.
    let v = TempVault::new("many");
    let rels: Vec<String> = (0..500).map(|i| format!("n{i}.md")).collect();
    for (i, rel) in rels.iter().enumerate() {
        v.file(rel, format!("body-{i}").as_bytes());
    }
    let got = decode(&encode(&read_all(
        &v.0,
        &rels,
        DEFAULT_MAX_TEXT_FILE_BYTES,
        None,
    )));
    assert_eq!(got.len(), 500);
    for (i, entry) in got.iter().enumerate() {
        assert_eq!(entry.as_deref(), Some(format!("body-{i}").as_bytes()));
    }
}

/// What the bulk path costs on a REAL vault, in the shape the command runs
/// it (chunked exactly as the frontend chunks). Ignored by default; run with:
///   MESA_PARITY_VAULT="/path/to/vault" \
///     cargo test --release --lib vaultread::tests::bench -- --ignored --nocapture
/// Release matters: the debug build's read path is not what ships.
#[test]
#[ignore]
fn bench_real_vault() {
    use std::time::Instant;
    const CHUNK: usize = 128; // paths per bulk read request

    let root = std::env::var("MESA_PARITY_VAULT").expect("set MESA_PARITY_VAULT to a vault path");
    let root = PathBuf::from(root);
    let mut scanned = Vec::new();
    crate::vaultscan::walk_for_tests(&root, "", &mut scanned);

    let textual = |rel: &str| {
        let ext = rel.rsplit('.').next().unwrap_or("").to_lowercase();
        matches!(
            ext.as_str(),
            "md" | "markdown"
                | "txt"
                | "html"
                | "htm"
                | "json"
                | "csv"
                | "tsv"
                | "py"
                | "js"
                | "ts"
                | "tsx"
                | "jsx"
                | "xml"
                | "yml"
                | "yaml"
                | "log"
                | "css"
                | "sh"
                | "rs"
                | "toml"
                | "ini"
                | "c"
                | "h"
                | "cpp"
                | "java"
                | "go"
        )
    };
    let is_md = |rel: &str| {
        let ext = rel.rsplit('.').next().unwrap_or("").to_lowercase();
        ext == "md" || ext == "markdown"
    };

    let mut rels: Vec<String> = scanned.into_iter().map(|e| e.rel).collect();
    rels.sort();
    let markdown: Vec<String> = rels.iter().filter(|r| is_md(r)).cloned().collect();
    let corpus: Vec<String> = rels
        .iter()
        .filter(|r| textual(r) && !is_md(r))
        .cloned()
        .collect();

    for (label, set) in [("markdown", &markdown), ("corpus", &corpus)] {
        // Two passes: the first warms the OS page cache, the second is the
        // number to compare. A single pass measures whatever the cache
        // happened to hold, which is the classic way to fake a win here.
        for pass in 0..2 {
            let start = Instant::now();
            let mut bytes = 0usize;
            let mut failed = 0usize;
            let mut round_trips = 0usize;
            for group in set.chunks(CHUNK) {
                round_trips += 1;
                for result in read_all(&root, group, DEFAULT_MAX_TEXT_FILE_BYTES, None) {
                    match result {
                        ReadResult::Content(b) => bytes += b.len(),
                        ReadResult::Skipped | ReadResult::Offline | ReadResult::Failed => {
                            failed += 1
                        }
                    }
                }
            }
            println!(
                "{label} pass{pass}: {} files in {} round-trips, {:.1} MB, {} unreadable, {:.1} ms",
                set.len(),
                round_trips,
                bytes as f64 / 1_048_576.0,
                failed,
                start.elapsed().as_secs_f64() * 1000.0
            );
        }
    }
}

/// Dump real frames for the JS half to verify against the same files read
/// directly. The wire format is hand-rolled binary over thousands of real
/// documents; synthetic cases cannot prove the pair agrees on a vault that
/// contains invalid UTF-8, CRLF, empty files and 40 MB outliers. Run with:
///   MESA_PARITY_VAULT="/path/to/vault" MESA_PARITY_OUT=/tmp/frames \
///     cargo test --release --lib vaultread::tests::parity_dump -- --ignored --nocapture
/// Inspect the emitted frames with the same decoder used by `vaultReadWire.test.ts`.
#[test]
#[ignore]
fn parity_dump_for_real_vault() {
    const CHUNK: usize = 128; // paths per bulk read request
    let root = std::env::var("MESA_PARITY_VAULT").expect("set MESA_PARITY_VAULT to a vault path");
    let out_dir =
        std::env::var("MESA_PARITY_OUT").expect("set MESA_PARITY_OUT to an output directory");
    let root = PathBuf::from(root);
    let out_dir = PathBuf::from(out_dir);
    fs::create_dir_all(&out_dir).unwrap();

    let mut scanned = Vec::new();
    crate::vaultscan::walk_for_tests(&root, "", &mut scanned);
    let mut rels: Vec<String> = scanned.into_iter().map(|e| e.rel).collect();
    rels.sort();

    // Every file the walk found, not just the textual ones: the command is
    // given whatever the frontend asks for, and a binary read must frame
    // correctly too.
    let mut manifest = Vec::new();
    for (i, group) in rels.chunks(CHUNK).enumerate() {
        let body = encode(&read_all(&root, group, DEFAULT_MAX_TEXT_FILE_BYTES, None));
        fs::write(out_dir.join(format!("frame-{i:04}.bin")), &body).unwrap();
        manifest.push(group.join("\n"));
    }
    fs::write(out_dir.join("manifest.txt"), manifest.join("\n\u{1e}\n")).unwrap();
    println!(
        "wrote {} frames for {} files to {}",
        manifest.len(),
        rels.len(),
        out_dir.display()
    );
}

#[test]
fn duplicate_rels_each_get_their_own_slot() {
    let v = TempVault::new("dupes");
    v.file("a.md", b"same");
    let got = round_trip(&v.0, &["a.md", "a.md"]);
    assert_eq!(got, vec![Some(b"same".to_vec()), Some(b"same".to_vec())]);
}
