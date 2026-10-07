// Read ordered vault-file batches into one binary IPC response.
// Return bytes and distinct failure/skip markers; the frontend owns UTF-8 decoding.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Marker length meaning "this file could not be read". `u32::MAX` can never be
/// a real length here: a file that large would have failed the read anyway.
const READ_FAILED: u32 = u32::MAX;
const READ_SKIPPED: u32 = u32::MAX - 1;
const DEFAULT_MAX_TEXT_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// A bulk read is background work.  Eight concurrent filesystem reads retain
/// capacity for the WebView2 UI thread and active editor work on high-core PCs.
const DEFAULT_BULK_READ_WORKERS: usize = 8;

enum ReadResult {
    Content(Vec<u8>),
    Skipped,
    Failed,
}

/// Validate vault-relative paths before filesystem access. Keep vault-read policy independent of sync policy.
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let mut p = root.to_path_buf();
    for seg in rel.replace('\\', "/").split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        p.push(seg);
    }
    Some(p)
}

/// Workers pull paths from a shared cursor and store results in request order.
fn read_all(
    root: &Path,
    rels: &[String],
    max_text_file_bytes: u64,
    worker_limit: Option<usize>,
) -> Vec<ReadResult> {
    let mut out: Vec<ReadResult> = (0..rels.len()).map(|_| ReadResult::Failed).collect();
    if rels.is_empty() {
        return out;
    }
    let available = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(rels.len());
    let threads = worker_limit
        .unwrap_or(DEFAULT_BULK_READ_WORKERS)
        .clamp(1, available);
    let cursor = AtomicUsize::new(0);

    // Each worker collects (index, bytes) locally and the results are placed
    // after the join, so no shared mutable buffer is needed and the response
    // order is the request order regardless of which thread finishes first.
    let collected: Vec<Vec<(usize, ReadResult)>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                let cursor = &cursor;
                scope.spawn(move || {
                    let mut mine = Vec::new();
                    loop {
                        let i = cursor.fetch_add(1, Ordering::Relaxed);
                        if i >= rels.len() {
                            break;
                        }
                        // An unreadable file is reported per-file, never as a
                        // failure of the batch: one bad file must not cost the
                        // other 127 their content.
                        let result = safe_join(root, &rels[i])
                            .map(|path| read_file(&path, max_text_file_bytes))
                            .unwrap_or(Ok(ReadResult::Failed))
                            .unwrap_or(ReadResult::Failed);
                        mine.push((i, result));
                    }
                    mine
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_default())
            .collect()
    });

    for chunk in collected {
        for (i, bytes) in chunk {
            out[i] = bytes;
        }
    }
    out
}

fn read_file(path: &Path, max_text_file_bytes: u64) -> io::Result<ReadResult> {
    // Regular files only, matching `vault_scan`'s `is_file` rule: a directory
    // or a device node named in `rels` must read as a failure, not hang or
    // return something the text cache would then hold forever.
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a file"));
    }
    if meta.len() > max_text_file_bytes {
        return Ok(ReadResult::Skipped);
    }
    std::fs::read(path).map(ReadResult::Content)
}

/// Frame the results into one response body.
///
/// ```text
///   u32  count
///   repeat count times:
///     u32  len   (READ_FAILED = unreadable, READ_SKIPPED = over limit)
///     u8   bytes[len]
/// ```
///
/// All integers are little-endian. `src/lib/vault.ts` `decodeTextChunk` is the
/// other half; `vaultReadWire.test.ts` checks the frontend decoder.
fn encode(results: &[ReadResult]) -> Vec<u8> {
    let total: usize = results
        .iter()
        .map(|r| {
            4 + match r {
                ReadResult::Content(bytes) => bytes.len(),
                _ => 0,
            }
        })
        .sum();
    let mut out = Vec::with_capacity(4 + total);
    out.extend_from_slice(&(results.len() as u32).to_le_bytes());
    for result in results {
        match result {
            // A file at or above 4 GiB would collide with the failure marker.
            // It cannot be read into memory here anyway, so report it as one.
            ReadResult::Content(bytes) if bytes.len() < READ_SKIPPED as usize => {
                out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                out.extend_from_slice(bytes);
            }
            ReadResult::Skipped => out.extend_from_slice(&READ_SKIPPED.to_le_bytes()),
            _ => out.extend_from_slice(&READ_FAILED.to_le_bytes()),
        }
    }
    out
}

/// Read many vault files in one round-trip.
///
/// `rels` are vault-relative, forward-slashed paths as produced by
/// `vault_scan`. The response is the framed body described on `encode`.
#[tauri::command]
pub async fn vault_read_text(
    app: tauri::AppHandle,
    root: String,
    rels: Vec<String>,
    max_text_file_bytes: Option<u64>,
    worker_limit: Option<usize>,
) -> Result<tauri::ipc::Response, String> {
    let path = crate::vaultscope::require_approved(&app, &root)?;
    // Blocking syscall work: keep it off the async runtime's worker so other
    // IPC (the editor's own saves, terminal traffic) stays responsive while a
    // batch is in flight.
    let max_text_file_bytes = max_text_file_bytes.unwrap_or(DEFAULT_MAX_TEXT_FILE_BYTES);
    let body = tauri::async_runtime::spawn_blocking(move || {
        encode(&read_all(&path, &rels, max_text_file_bytes, worker_limit))
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(body))
}

/// Bounded read-only access replaces generic file handles in privileged renderers.
#[tauri::command]
pub async fn vault_read_bytes(
    app: tauri::AppHandle,
    path: String,
    max_bytes: usize,
    require_complete: bool,
) -> Result<Vec<u8>, String> {
    if max_bytes > 8 * 1024 * 1024 {
        return Err("invalid bounded read limit".into());
    }
    let (root, rel) = crate::vaultscope::approved_path(&app, &path)?;
    let access = crate::vaulttransaction::access(&root).await?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let _access = access;
        #[cfg(unix)]
        let file = crate::sync_core::RootedTarget::resolve(&root, &rel, false)
            .map_err(|e| e.to_string())?
            .open_read()
            .map_err(|e| e.to_string())?;
        #[cfg(windows)]
        let file =
            crate::sync_core::open_file_no_follow(&root.join(rel)).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take((max_bytes + usize::from(require_complete)) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > max_bytes {
            return Err(
                "File exceeds the inline review limit. Open each copy to review it.".into(),
            );
        }
        Ok(bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
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

    /// Decode the wire format the way the frontend does, so the tests exercise
    /// the actual contract rather than the in-memory `Vec<Option<..>>`.
    fn decode(body: &[u8]) -> Vec<Option<Vec<u8>>> {
        let count = u32::from_le_bytes(body[0..4].try_into().unwrap()) as usize;
        let mut at = 4;
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            let len = u32::from_le_bytes(body[at..at + 4].try_into().unwrap());
            at += 4;
            if len == READ_FAILED || len == READ_SKIPPED {
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
        const CHUNK: usize = 128; // VAULT_TEXT_CHUNK in src/lib/vault.ts

        let root =
            std::env::var("MESA_PARITY_VAULT").expect("set MESA_PARITY_VAULT to a vault path");
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
                            ReadResult::Skipped | ReadResult::Failed => failed += 1,
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
        const CHUNK: usize = 128; // VAULT_TEXT_CHUNK in src/lib/vault.ts
        let root =
            std::env::var("MESA_PARITY_VAULT").expect("set MESA_PARITY_VAULT to a vault path");
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
}

/// Content identity for a reusable frontend index. Never trusts mtime alone.
#[tauri::command]
pub async fn vault_text_fingerprints(
    app: tauri::AppHandle,
    root: String,
    rels: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    if rels.len() > 128 {
        return Err("Fingerprint batch exceeds 128 files".into());
    }
    let root = crate::vaultscope::require_approved(&app, &root)?;
    tauri::async_runtime::spawn_blocking(move || fingerprint_all(&root, &rels))
        .await
        .map_err(|e| e.to_string())
}

fn fingerprint_all(root: &Path, rels: &[String]) -> Vec<Option<String>> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let canonical_root = match root.canonicalize() {
        Ok(root) => root,
        Err(_) => return vec![None; rels.len()],
    };
    rels.iter()
        .map(|rel| {
            let path = safe_join(&canonical_root, rel)?.canonicalize().ok()?;
            if !path.starts_with(&canonical_root) {
                return None;
            }
            let mut file = std::fs::File::open(path).ok()?;
            let before = file.metadata().ok()?;
            if !before.is_file() {
                return None;
            }
            let mut remaining = before.len();
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 65536];
            while remaining > 0 {
                let take = remaining.min(buffer.len() as u64) as usize;
                let count = file.read(&mut buffer[..take]).ok()?;
                if count == 0 {
                    return None;
                }
                remaining -= count as u64;
                hasher.update(&buffer[..count]);
            }
            let after = file.metadata().ok()?;
            if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
                return None;
            }
            Some(format!("{:x}", hasher.finalize()))
        })
        .collect()
}

#[cfg(test)]
mod fingerprint_tests {
    use super::*;
    #[test]
    fn rejects_traversal_and_hashes_content_including_empty_files() {
        let root = std::env::temp_dir().join(format!("mesa-index-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("note.md"), b"abc").unwrap();
        std::fs::write(root.join("empty.md"), b"").unwrap();
        let hashes = fingerprint_all(
            &root,
            &[
                "note.md".into(),
                "empty.md".into(),
                "../outside".into(),
                "missing".into(),
            ],
        );
        assert_eq!(
            hashes[0].as_deref(),
            Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        assert_eq!(
            hashes[1].as_deref(),
            Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
        assert!(hashes[2].is_none() && hashes[3].is_none());
        std::fs::write(root.join("note.md"), b"xyz").unwrap();
        assert_ne!(fingerprint_all(&root, &["note.md".into()])[0], hashes[0]);
        std::fs::remove_dir_all(root).unwrap();
    }
}
