// Release diagnostics on Windows. The GUI subsystem has no console, so every
// `eprintln!` and panic message was discarded. When the process has no usable
// stderr, `capture_stderr` points stderr at a pipe drained into a bounded,
// rotating file under the per-user app data folder.
//
// Mesa writes only short operational messages to stderr (failed shortcut
// registration, tray, cleanup and permission errors, panics); none carry note
// content or key material. Keep it that way: never log file bytes, sync keys
// or full vault paths.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// Bundle identifier from `tauri.conf.json`; Tauri's log folder is
/// `%LOCALAPPDATA%\{identifier}\logs`. A test keeps the two equal.
pub const APP_IDENTIFIER: &str = "dev.xo.mesa";
/// Active log file and its single rotated predecessor: at most 2 MiB on disk.
pub const LOG_FILE: &str = "mesa.log";
pub const ROTATED_FILE: &str = "mesa.1.log";
pub const LOG_LIMIT_BYTES: u64 = 1024 * 1024;

/// Append-only log that rotates to [`ROTATED_FILE`] before passing `limit`.
pub struct RotatingLog {
    dir: PathBuf,
    limit: u64,
    file: File,
    written: u64,
}

impl RotatingLog {
    pub fn open(dir: &Path, limit: u64) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let file = open_append(&dir.join(LOG_FILE))?;
        let written = file.metadata()?.len();
        let mut log = Self {
            dir: dir.to_path_buf(),
            limit,
            file,
            written,
        };
        if log.written >= limit {
            log.rotate()?;
        }
        Ok(log)
    }

    fn rotate(&mut self) -> io::Result<()> {
        let rotated = self.dir.join(ROTATED_FILE);
        let _ = fs::remove_file(&rotated);
        fs::rename(self.dir.join(LOG_FILE), &rotated)?;
        self.file = open_append(&self.dir.join(LOG_FILE))?;
        self.written = 0;
        Ok(())
    }

    /// Append `bytes`, rotating first when they would pass the limit. A single
    /// write larger than the limit keeps only its tail.
    pub fn append(&mut self, bytes: &[u8]) -> io::Result<()> {
        let limit = usize::try_from(self.limit).unwrap_or(usize::MAX);
        let bytes = &bytes[bytes.len().saturating_sub(limit)..];
        if self.written + bytes.len() as u64 > self.limit {
            self.rotate()?;
        }
        self.file.write_all(bytes)?;
        self.written += bytes.len() as u64;
        Ok(())
    }
}

fn open_append(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

/// Output waiting for the file writer. Bounded: when the writer falls behind
/// (antivirus scanning the log, a slow disk) new output is dropped and counted,
/// so a thread writing to stderr never waits on the disk.
#[derive(Default)]
pub struct PendingLog {
    bytes: Vec<u8>,
    dropped: u64,
}

/// Most bytes held in memory for the writer.
pub const PENDING_LIMIT_BYTES: usize = 256 * 1024;

impl PendingLog {
    pub fn push(&mut self, chunk: &[u8]) {
        if self.bytes.len() + chunk.len() > PENDING_LIMIT_BYTES {
            self.dropped += chunk.len() as u64;
        } else {
            self.bytes.extend_from_slice(chunk);
        }
    }

    /// Everything pending, with a line that reports dropped output first.
    pub fn take(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if self.dropped > 0 {
            out.extend_from_slice(
                format!("[mesa] {} bytes of log output dropped\n", self.dropped).as_bytes(),
            );
            self.dropped = 0;
        }
        out.append(&mut self.bytes);
        out
    }
}

/// Shared between the pipe reader and the file writer.
#[derive(Default)]
pub struct LogQueue {
    pending: std::sync::Mutex<PendingLog>,
    ready: std::sync::Condvar,
}

impl LogQueue {
    fn lock(&self) -> std::sync::MutexGuard<'_, PendingLog> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Drain `input` into memory only, never the disk, so the pipe stays empty and
/// writers to stderr do not block. Returns when `input` fails or closes.
pub fn read_into_queue(mut input: impl Read, queue: &LogQueue) {
    let mut buffer = [0u8; 8 * 1024];
    loop {
        match input.read(&mut buffer) {
            Ok(0) => return,
            Ok(count) => {
                queue.lock().push(&buffer[..count]);
                queue.ready.notify_one();
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

/// Write queued output to the rotating file until the process ends.
/// File errors drop that chunk; diagnostics never stop the app.
#[cfg(windows)]
pub fn write_from_queue(queue: &LogQueue, log: &mut RotatingLog) -> ! {
    loop {
        let chunk = {
            let mut pending = queue.lock();
            while pending.bytes.is_empty() && pending.dropped == 0 {
                pending = queue
                    .ready
                    .wait(pending)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            pending.take()
        };
        let _ = log.append(&chunk);
    }
}

/// The panic line keeps only the source file name and line: a payload can
/// hold any string, including a vault path or note text.
pub fn panic_line(location: Option<(&str, u32)>) -> String {
    match location {
        Some((file, line)) => {
            let name = Path::new(file)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unknown");
            format!("[mesa] panic at {name}:{line}\n")
        }
        None => "[mesa] panic\n".into(),
    }
}

/// Redirect stderr to the rotating log when the process has no usable stderr
/// (the release GUI subsystem). A console or redirected stderr is left alone.
/// Stderr is switched only after both log threads run; if the reader ever
/// stops, stderr moves to NUL so `eprintln!` can never hit a broken pipe
/// (which would panic, and release builds abort on panic).
#[cfg(windows)]
pub fn capture_stderr() {
    use std::os::windows::io::{AsRawHandle, IntoRawHandle};
    use std::sync::Arc;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::{GetStdHandle, SetStdHandle, STD_ERROR_HANDLE};

    // SAFETY: GetStdHandle only reads the process parameter block.
    let current = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
    if !current.is_null() && current != INVALID_HANDLE_VALUE {
        return;
    }
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let dir = Path::new(&local).join(APP_IDENTIFIER).join("logs");
    let Ok(mut log) = RotatingLog::open(&dir, LOG_LIMIT_BYTES) else {
        return;
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let _ = log.append(
        format!(
            "--- Mesa {} started (unix time {stamp}) ---\n",
            env!("CARGO_PKG_VERSION")
        )
        .as_bytes(),
    );
    let Ok((reader, writer)) = std::io::pipe() else {
        return;
    };
    let queue = Arc::new(LogQueue::default());
    let file_queue = queue.clone();
    let spawned_writer = std::thread::Builder::new()
        .name("mesa-log-file".into())
        .spawn(move || write_from_queue(&file_queue, &mut log));
    if spawned_writer.is_err() {
        return;
    }
    let spawned_reader = std::thread::Builder::new()
        .name("mesa-log-pipe".into())
        .spawn(move || {
            read_into_queue(reader, &queue);
            // Never leave stderr on a pipe nobody reads.
            if let Ok(null) = OpenOptions::new().write(true).open("NUL") {
                // SAFETY: the NUL handle stays open for the life of the process.
                unsafe { SetStdHandle(STD_ERROR_HANDLE, null.into_raw_handle()) };
            }
        });
    if spawned_reader.is_err() {
        return;
    }
    // Release builds abort on panic before the queue drains, so the panic hook
    // appends one line itself, through its own handle and without any lock.
    let panic_file = dir.join(LOG_FILE);
    std::panic::set_hook(Box::new(move |info| {
        let line = panic_line(info.location().map(|at| (at.file(), at.line())));
        if let Ok(mut file) = open_append(&panic_file) {
            let _ = file.write_all(line.as_bytes());
        }
    }));
    // SAFETY: the pipe handle is valid; ownership moves to the process stderr
    // slot and stays open for the life of the process.
    if unsafe { SetStdHandle(STD_ERROR_HANDLE, writer.as_raw_handle()) } != 0 {
        let _ = writer.into_raw_handle();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mesa-applog-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn log_rotates_once_and_stays_bounded() {
        let dir = folder("rotate");
        let mut log = RotatingLog::open(&dir, 64).unwrap();
        for line in 0..100 {
            log.append(format!("line {line:04}\n").as_bytes()).unwrap();
        }
        let active = fs::read(dir.join(LOG_FILE)).unwrap();
        let rotated = fs::read(dir.join(ROTATED_FILE)).unwrap();
        assert!(active.len() <= 64 && rotated.len() <= 64);
        // The newest line is kept; only two files ever exist.
        assert!(String::from_utf8(active).unwrap().ends_with("line 0099\n"));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        // An oversized write keeps its tail instead of growing past the limit.
        log.append(&[b'x'; 500]).unwrap();
        assert_eq!(fs::read(dir.join(LOG_FILE)).unwrap().len(), 64);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reopening_a_full_log_rotates_before_appending() {
        let dir = folder("reopen");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(LOG_FILE), [b'a'; 80]).unwrap();
        let mut log = RotatingLog::open(&dir, 64).unwrap();
        log.append(b"new run\n").unwrap();
        assert_eq!(fs::read(dir.join(LOG_FILE)).unwrap(), b"new run\n");
        assert_eq!(fs::read(dir.join(ROTATED_FILE)).unwrap().len(), 80);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stderr_bytes_reach_the_log_through_the_queue() {
        let queue = LogQueue::default();
        read_into_queue(&b"Mesa could not register global shortcut\n"[..], &queue);
        let dir = folder("queue");
        let mut log = RotatingLog::open(&dir, LOG_LIMIT_BYTES).unwrap();
        log.append(&queue.lock().take()).unwrap();
        assert_eq!(
            fs::read(dir.join(LOG_FILE)).unwrap(),
            b"Mesa could not register global shortcut\n"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_slow_writer_drops_and_counts_output_instead_of_blocking() {
        let mut pending = PendingLog::default();
        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..6 {
            pending.push(&chunk); // never waits, whatever the disk does
        }
        let out = pending.take();
        assert!(out.starts_with(b"[mesa] 131072 bytes of log output dropped\n"));
        assert!(out.len() <= PENDING_LIMIT_BYTES + 64);
        assert!(pending.take().is_empty());
    }

    #[test]
    fn panic_lines_never_carry_the_payload_or_full_paths() {
        let line = panic_line(Some(("/Data/someone/build/src/vaultwrite.rs", 42)));
        assert_eq!(line, "[mesa] panic at vaultwrite.rs:42\n");
        assert!(!line.contains("someone"));
        assert_eq!(panic_line(None), "[mesa] panic\n");
    }

    #[test]
    fn stderr_is_redirected_only_after_both_log_threads_run() {
        let source = include_str!("applog.rs");
        let capture = &source[source.find("pub fn capture_stderr()").unwrap()..];
        let redirect = capture
            .find("SetStdHandle(STD_ERROR_HANDLE, writer")
            .unwrap();
        assert!(capture.find("spawned_writer.is_err()").unwrap() < redirect);
        assert!(capture.find("spawned_reader.is_err()").unwrap() < redirect);
        assert!(capture.contains("open(\"NUL\")"));
    }

    #[test]
    fn identifier_matches_the_bundle_configuration() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], APP_IDENTIFIER);
    }

    #[test]
    fn release_entry_point_captures_stderr_before_running() {
        // The windows subsystem discards stderr; main must capture it first.
        let main = include_str!("main.rs");
        let capture = main.find("applog::capture_stderr()").expect("capture call");
        assert!(capture < main.find("mesa_lib::run()").unwrap());
    }
}
