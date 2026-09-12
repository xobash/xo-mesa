use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    env,
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

#[cfg(target_os = "windows")]
use std::fs;

#[cfg(target_os = "windows")]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);

// A Windows HANDLE is an opaque, process-owned kernel reference. Moving this
// sole owner between threads is supported by the Win32 API; `Drop` closes it
// exactly once, after the terminal session leaves the mutex-protected map.
#[cfg(target_os = "windows")]
unsafe impl Send for WindowsJob {}

/// Assign the PTY leader to a kill-on-close job. Windows automatically places
/// descendants (including a shell wrapper's Node/Pi grandchild) in that job,
/// so closing Mesa cannot leave a process holding a vault or build directory.
#[cfg(target_os = "windows")]
fn own_windows_process_tree(pid: u32) -> Result<WindowsJob, String> {
    use std::ptr::null;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() { return Err(format!("CreateJobObject failed: {}", std::io::Error::last_os_error())); }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let set = unsafe { SetInformationJobObject(job, JobObjectExtendedLimitInformation, &mut info as *mut _ as *mut _, std::mem::size_of_val(&info) as u32) };
    if set == 0 { unsafe { CloseHandle(job); } return Err(format!("SetInformationJobObject failed: {}", std::io::Error::last_os_error())); }
    let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
    if process.is_null() { unsafe { CloseHandle(job); } return Err(format!("OpenProcess failed: {}", std::io::Error::last_os_error())); }
    let assigned = unsafe { AssignProcessToJobObject(job, process) };
    unsafe { CloseHandle(process); }
    if assigned == 0 { unsafe { CloseHandle(job); } return Err(format!("AssignProcessToJobObject failed: {}", std::io::Error::last_os_error())); }
    Ok(WindowsJob(job))
}

#[cfg(target_os = "windows")]
impl Drop for WindowsJob {
    fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); } }
}

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

struct TerminalSession {
    child: Box<dyn portable_pty::Child + Send>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    stream: Arc<TerminalStream>,
    /// The Mesa window currently responsible for PTY dimensions. Output/input
    /// remain app-global, but only the focused/adopting renderer may resize:
    /// two xterms fighting over one PTY width corrupt TUI cursor arithmetic.
    resize_owner: String,
    rows: u16,
    cols: u16,
    /// Dropping this handle kills the whole Windows ConPTY process tree.
    #[cfg(target_os = "windows")]
    _job: WindowsJob,
}

const TERMINAL_HISTORY_MAX_BYTES: usize = 4 * 1024 * 1024;
const TERMINAL_RESIZE_HISTORY_COST: usize = 4;

/// How long decoded PTY bytes may wait for company before Mesa emits them.
///
/// A `terminal://output` event is delivered to a webview by *evaluating a JS
/// source string*: `Listeners::emit_js_filter` builds one with
/// `event::emit_js_script` and hands it to `Webview::eval`
/// (`tauri-2.11.3/src/event/listener.rs:269-294`, `src/webview/mod.rs:1974`).
/// On Windows that eval is marshalled onto the app's UI thread — the same
/// thread that dispatches `WM_KEYDOWN`, `WM_PAINT`, and resize — and wry's
/// dispatcher additionally calls `RedrawWindow(.., RDW_INTERNALPAINT)` after
/// every dispatched item (`wry-0.55.1/src/webview2/mod.rs:1012-1035`).
///
/// One event per PTY read therefore turns a bulk Pi response into thousands of
/// UI-thread script compiles plus thousands of forced paint invalidations. A
/// real `pty.fork` measurement put 1.3 MB of output at **1,303 events in
/// 0.02 s** (mean chunk 1,023 B — the 4 KiB read buffer does not bound it),
/// which is enough to bury the message pump and freeze the window.
///
/// 8 ms is half a 60 Hz frame, so coalescing inside the window cannot cost a
/// rendered frame; `flush_delay`'s leading-edge rule keeps interactive echo at
/// zero added delay.
const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(8);

/// Emit early once a batch reaches this size instead of growing one enormous JS
/// source string. The eval is parsed and compiled in a single go, so an
/// unbounded payload would trade many short stalls for one long one.
const OUTPUT_FLUSH_MAX_BYTES: usize = 64 * 1024;

/// Hard ceiling for decoded output waiting behind a slow webview consumer.
/// Once reached, the reader waits on the same condvar until the flusher drains
/// an event. This applies backpressure to the PTY without dropping bytes or
/// allowing a Windows UI-thread stall to grow the Rust heap without bound.
const OUTPUT_PENDING_MAX_BYTES: usize = 1024 * 1024;

/// The PTY history plus the coalescing pump's wakeup channel.
///
/// One mutex guards staged bytes, committed entries, and resize markers so they
/// cannot interleave out of order, and the condvar lets the reader thread wake
/// the flusher without polling — an idle Pi session costs zero wakeups.
struct TerminalStream {
    history: Mutex<TerminalHistory>,
    wake: Condvar,
}

impl TerminalStream {
    fn new(history: TerminalHistory) -> Self {
        Self {
            history: Mutex::new(history),
            wake: Condvar::new(),
        }
    }

    /// A panicked reader/flusher thread must not be able to brick Pi's output,
    /// resize, or replay, so poisoning is recovered from rather than surfaced.
    fn lock(&self) -> MutexGuard<'_, TerminalHistory> {
        self.history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Stage decoded bytes and wake the flusher when it has something new to
    /// decide.
    ///
    /// Notifying on every read would put the wakeup back on a per-read budget.
    /// Mid-batch there is nothing to tell the flusher: it is already waiting on
    /// this batch's own deadline. Only two transitions matter — opening a batch
    /// (the flusher is parked with no deadline at all) and crossing the size
    /// cap (its deadline is now too late).
    fn stage(&self, data: &str) {
        if data.is_empty() {
            return;
        }
        let mut history = self.lock();
        while history.pending.len() >= OUTPUT_PENDING_MAX_BYTES && !history.closed {
            history = self
                .wake
                .wait(history)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        if history.closed {
            return;
        }
        let opened_batch = history.pending.is_empty();
        history.stage_output(data);
        let notify = opened_batch || history.pending.len() >= OUTPUT_FLUSH_MAX_BYTES;
        drop(history);
        if notify {
            self.wake.notify_all();
        }
    }

    /// Record EOF. The flusher emits whatever is left, then exits.
    fn close(&self, tail: &str) {
        let mut history = self.lock();
        history.stage_output(tail);
        history.closed = true;
        drop(history);
        self.wake.notify_all();
    }
}

#[derive(Default)]
struct TerminalHistory {
    entries: VecDeque<TerminalHistoryEntry>,
    bytes: usize,
    seq: u64,
    /// Decoded bytes read from the PTY that are not committed yet. They are
    /// invisible to `snapshot`/`replay` until `commit_pending` runs, so a
    /// resize marker can never be recorded between a read and its own entry.
    pending: String,
    /// Committed chunks whose `terminal://output` event has not been sent yet.
    /// Only the flusher thread drains this, which keeps emission
    /// single-threaded and in `seq` order even when a resize is what forced the
    /// commit.
    outbox: VecDeque<(String, u64)>,
    /// When the last commit happened, for the leading-edge rule in
    /// `flush_delay`. `None` means nothing has been emitted yet.
    last_flush: Option<Instant>,
    /// The reader thread hit EOF; the flusher returns once `outbox` drains.
    closed: bool,
}

enum TerminalHistoryEntry {
    Output(String),
    Resize { rows: u16, cols: u16 },
}

impl TerminalHistory {
    fn trim(&mut self) {
        while self.bytes > TERMINAL_HISTORY_MAX_BYTES && self.entries.len() > 1 {
            if let Some(removed) = self.entries.pop_front() {
                self.bytes = self.bytes.saturating_sub(match removed {
                    TerminalHistoryEntry::Output(data) => data.len(),
                    TerminalHistoryEntry::Resize { .. } => TERMINAL_RESIZE_HISTORY_COST,
                });
            }
        }
    }

    fn push_output(&mut self, data: String) -> u64 {
        self.seq = self.seq.saturating_add(1);
        self.bytes += data.len();
        self.entries.push_back(TerminalHistoryEntry::Output(data));
        self.trim();
        self.seq
    }

    /// Hold decoded bytes back until the pump decides to emit them.
    fn stage_output(&mut self, data: &str) {
        self.pending.push_str(data);
    }

    /// How long staged bytes still owe before they may be emitted.
    ///
    /// `Duration::ZERO` means "send now": either the batch already reached
    /// `OUTPUT_FLUSH_MAX_BYTES`, or the stream has been quiet for a full
    /// interval and this is the *leading edge* of a burst. That second rule is
    /// what keeps a single keystroke's echo — or one line of Pi output after a
    /// pause — at zero added latency; only the reads that arrive inside an
    /// already-open window pay the coalescing delay.
    fn flush_delay(&self, now: Instant) -> Duration {
        if self.pending.is_empty() {
            return OUTPUT_FLUSH_INTERVAL;
        }
        if self.pending.len() >= OUTPUT_FLUSH_MAX_BYTES {
            return Duration::ZERO;
        }
        match self.last_flush {
            None => Duration::ZERO,
            Some(last) => OUTPUT_FLUSH_INTERVAL.saturating_sub(now.saturating_duration_since(last)),
        }
    }

    /// Move staged bytes into history as one entry and queue the event that
    /// carries them. Returns false when nothing was staged.
    ///
    /// At most `OUTPUT_FLUSH_MAX_BYTES` are taken per commit. The flusher is
    /// not guaranteed to observe the buffer the instant it crosses the cap — a
    /// busy UI thread can leave it running far ahead — so the bound has to be
    /// enforced here rather than only in `flush_delay`. Anything left over
    /// keeps `flush_delay` at zero, so the remainder drains immediately in
    /// further batches instead of waiting out another window.
    fn commit_pending(&mut self, now: Instant) -> bool {
        if self.pending.is_empty() {
            return false;
        }
        let data = if self.pending.len() <= OUTPUT_FLUSH_MAX_BYTES {
            std::mem::take(&mut self.pending)
        } else {
            // Splitting inside a multi-byte character would panic here, and
            // would reach xterm as replacement characters that widen the line
            // — the same double-render failure `Utf8Stream` prevents at the
            // read boundary. Back up to the nearest boundary (at most 3 bytes).
            let mut cut = OUTPUT_FLUSH_MAX_BYTES;
            while !self.pending.is_char_boundary(cut) {
                cut -= 1;
            }
            let rest = self.pending.split_off(cut);
            std::mem::replace(&mut self.pending, rest)
        };
        let seq = self.push_output(data.clone());
        self.outbox.push_back((data, seq));
        self.last_flush = Some(now);
        true
    }

    fn push_resize(&mut self, rows: u16, cols: u16) -> u64 {
        // Staged bytes were produced *before* this resize. Committing them
        // first is what keeps `replay()`'s grid timeline honest: replaying
        // pre-resize TUI bytes at the post-resize width re-wraps lines and
        // strands Pi's cursor-up rewrites — the same failure `Utf8Stream`
        // documents above.
        self.commit_pending(Instant::now());
        self.seq = self.seq.saturating_add(1);
        self.bytes += TERMINAL_RESIZE_HISTORY_COST;
        self.entries
            .push_back(TerminalHistoryEntry::Resize { rows, cols });
        self.trim();
        self.seq
    }

    fn snapshot(&self) -> String {
        self.entries
            .iter()
            .filter_map(|entry| match entry {
                TerminalHistoryEntry::Output(data) => Some(data.as_str()),
                TerminalHistoryEntry::Resize { .. } => None,
            })
            .collect()
    }

    fn replay(&self) -> Vec<TerminalReplayEvent> {
        self.entries
            .iter()
            .map(|entry| match entry {
                TerminalHistoryEntry::Output(data) => TerminalReplayEvent {
                    kind: "output",
                    data: Some(data.clone()),
                    rows: None,
                    cols: None,
                },
                TerminalHistoryEntry::Resize { rows, cols } => TerminalReplayEvent {
                    kind: "resize",
                    data: None,
                    rows: Some(*rows),
                    cols: Some(*cols),
                },
            })
            .collect()
    }
}

#[derive(Clone, Serialize)]
struct TerminalOutput {
    #[serde(rename = "sessionId")]
    session_id: String,
    stream: String,
    data: String,
    seq: u64,
}

#[derive(Serialize)]
pub struct TerminalSnapshot {
    data: String,
    seq: u64,
    events: Vec<TerminalReplayEvent>,
}

#[derive(Serialize)]
pub struct TerminalReplayEvent {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rows: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cols: Option<u16>,
}

static PI_BINARY: OnceLock<PathBuf> = OnceLock::new();

fn session_id() -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("term-{n:x}")
}

#[cfg(target_os = "windows")]
fn executable_names(name: &str) -> Vec<OsString> {
    let raw = Path::new(name);
    if raw.extension().is_some() {
        return vec![OsString::from(name)];
    }

    let mut names = Vec::new();
    let pathext = env::var_os("PATHEXT")
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
    for ext in pathext.split(';').filter(|ext| !ext.trim().is_empty()) {
        names.push(OsString::from(format!("{name}{ext}")));
    }
    names.push(OsString::from(name));
    names
}

#[cfg(target_os = "windows")]
fn executable_in_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    for executable in executable_names(name) {
        let candidate = dir.join(executable);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn executable_in_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    let candidate = dir.join(name);
    if is_executable(&candidate) {
        Some(candidate)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn command_on_path(name: &str) -> bool {
    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            if executable_in_dir(&dir, name).is_some() {
                return true;
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn comspec() -> String {
    env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
}

#[cfg(target_os = "windows")]
fn shell_command() -> CommandBuilder {
    for candidate in ["pwsh.exe", "powershell.exe"] {
        if command_on_path(candidate) {
            let mut cmd = CommandBuilder::new(candidate);
            cmd.arg("-NoLogo");
            cmd.arg("-NoExit");
            return cmd;
        }
    }
    let mut cmd = CommandBuilder::new(comspec());
    cmd.arg("/Q");
    cmd
}

fn terminal_command(program: Option<&str>) -> Result<(CommandBuilder, Vec<PathBuf>), String> {
    match program.map(str::trim).filter(|s| !s.is_empty()) {
        Some("pi") => {
            let pi = resolve_pi_binary()?;
            let path_prefixes = terminal_path_prefixes(&pi);
            let cmd = pi_command(&pi)?;
            Ok((cmd, path_prefixes))
        }
        Some(other) => Ok((CommandBuilder::new(other), Vec::new())),
        None => Ok((shell_command(), Vec::new())),
    }
}

#[cfg(not(target_os = "windows"))]
fn pi_command(pi: &Path) -> Result<CommandBuilder, String> {
    Ok(CommandBuilder::new(pi.to_string_lossy().to_string()))
}

#[cfg(target_os = "windows")]
fn pi_command(pi: &Path) -> Result<CommandBuilder, String> {
    if windows_launches_directly(pi) {
        return Ok(CommandBuilder::new(pi.to_string_lossy().to_string()));
    }

    if script_uses_node(pi) {
        return node_script_command(pi);
    }

    if let Some(ext) = pi
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
    {
        if matches!(ext.as_str(), "cmd" | "bat") {
            if let Some(script) = sibling_script_path(pi).filter(|script| script_uses_node(script))
            {
                return node_script_command(&script);
            }

            let mut cmd = CommandBuilder::new(comspec());
            cmd.arg("/d");
            cmd.arg("/s");
            cmd.arg("/c");
            cmd.arg(pi.to_string_lossy().to_string());
            return Ok(cmd);
        }
    }

    Err(format!(
        "Resolved Pi path '{}' is not a native Windows executable, Node-backed script, or runnable .cmd/.bat shim. Point MESA_PI_BIN at the native Pi launcher or its adjacent Node script.",
        pi.to_string_lossy()
    ))
}

#[cfg(not(target_os = "windows"))]
fn shell_command() -> CommandBuilder {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-i");
    cmd
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn common_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(home) = home_dir() {
        dirs.push(home.join(".hermes/node/bin"));
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".npm-global/bin"));
        dirs.push(home.join(".cargo/bin"));
    }

    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(profile) = env::var_os("APPDATA").map(PathBuf::from) {
            dirs.push(profile.join("npm"));
        }
        if let Some(home) = home_dir() {
            // run.cmd bootstraps Node/Git/Rust through Scoop; its shims live
            // here and are not always on the PATH Mesa inherits when launched
            // from the desktop instead of a terminal.
            dirs.push(home.join("scoop").join("shims"));
        }
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(pf) = env::var_os(key).map(PathBuf::from) {
                dirs.push(pf.join("nodejs"));
            }
        }
        if let Some(local) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            dirs.push(local.join("Programs"));
            // Per-user Node.js installer target.
            dirs.push(local.join("Programs").join("nodejs"));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/bin"));
    }

    dirs
}

fn resolve_pi_binary() -> Result<PathBuf, String> {
    if let Some(cached) = PI_BINARY.get() {
        return Ok(cached.clone());
    }

    let resolved = find_pi_binary()?;
    let _ = PI_BINARY.set(resolved.clone());
    Ok(resolved)
}

fn find_pi_binary() -> Result<PathBuf, String> {
    let mut checked: Vec<PathBuf> = Vec::new();

    for key in ["MESA_PI_BIN", "PI_BIN"] {
        if let Some(raw) = env::var_os(key).filter(|value| !value.is_empty()) {
            let candidate = PathBuf::from(raw);
            checked.push(candidate.clone());
            if let Some(executable) = resolve_explicit_pi_candidate(&candidate) {
                return Ok(executable);
            }
        }
    }

    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            let candidate = dir.join("pi");
            checked.push(candidate);
            if let Some(executable) = executable_in_dir(&dir, "pi") {
                return Ok(executable);
            }
        }
    }

    for dir in common_bin_dirs() {
        checked.push(dir.join("pi"));
        if let Some(executable) = executable_in_dir(&dir, "pi") {
            return Ok(executable);
        }
    }

    let checked = checked
        .iter()
        .map(|path| path.to_string_lossy())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "Unable to spawn pi because it was not found in PATH or Mesa's known install locations. Set MESA_PI_BIN to the Pi executable path, or install Pi in a standard bin directory. Checked: {checked}"
    ))
}

#[cfg(target_os = "windows")]
fn resolve_explicit_pi_candidate(candidate: &Path) -> Option<PathBuf> {
    if candidate.extension().is_some() {
        return is_executable(candidate).then(|| candidate.to_path_buf());
    }

    for executable in executable_names(&candidate.to_string_lossy()) {
        let path = PathBuf::from(executable);
        if path != candidate && is_executable(&path) {
            return Some(path);
        }
    }

    is_executable(candidate).then(|| candidate.to_path_buf())
}

#[cfg(not(target_os = "windows"))]
fn resolve_explicit_pi_candidate(candidate: &Path) -> Option<PathBuf> {
    is_executable(candidate).then(|| candidate.to_path_buf())
}

fn terminal_path_prefixes(program: &Path) -> Vec<PathBuf> {
    let mut prefixes = Vec::new();

    if let Some(parent) = program.parent() {
        prefixes.push(parent.to_path_buf());
    }

    for dir in common_bin_dirs() {
        prefixes.push(dir);
    }

    prefixes
}

#[cfg(target_os = "windows")]
fn windows_launches_directly(path: &Path) -> bool {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
    {
        Some(ext) => matches!(ext.as_str(), "exe" | "com"),
        None => file_starts_with_mz(path),
    }
}

#[cfg(target_os = "windows")]
fn file_starts_with_mz(path: &Path) -> bool {
    fs::read(path)
        .map(|bytes| bytes.starts_with(b"MZ"))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn script_uses_node(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return false;
    };
    text.lines()
        .next()
        .map(|line| line.starts_with("#!") && line.contains("node"))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn sibling_script_path(path: &Path) -> Option<PathBuf> {
    let stem = path.file_stem()?;
    let sibling = path.with_file_name(stem);
    sibling.is_file().then_some(sibling)
}

#[cfg(target_os = "windows")]
fn node_script_command(script: &Path) -> Result<CommandBuilder, String> {
    let node = resolve_node_binary_for_script(script)?;
    let mut cmd = CommandBuilder::new(node.to_string_lossy().to_string());
    cmd.arg(script.to_string_lossy().to_string());
    Ok(cmd)
}

#[cfg(target_os = "windows")]
fn resolve_node_binary_for_script(script: &Path) -> Result<PathBuf, String> {
    if let Some(parent) = script.parent() {
        for candidate in [parent.join("node.exe"), parent.join("node")] {
            if windows_launches_directly(&candidate) {
                return Ok(candidate);
            }
        }
    }

    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            if let Some(executable) = executable_in_dir(&dir, "node") {
                return Ok(executable);
            }
        }
    }

    for dir in common_bin_dirs() {
        if let Some(executable) = executable_in_dir(&dir, "node") {
            return Ok(executable);
        }
    }

    Err(format!(
        "Pi resolved to the Node script '{}', but Mesa could not find node.exe to launch it. Install Node.js or point MESA_PI_BIN at a native Pi executable.",
        script.to_string_lossy()
    ))
}

fn merged_path(prefixes: &[PathBuf]) -> Option<OsString> {
    let mut paths: Vec<PathBuf> = Vec::new();

    for prefix in prefixes {
        if prefix.is_dir() && !paths.iter().any(|existing| existing == prefix) {
            paths.push(prefix.clone());
        }
    }

    if let Some(existing) = env::var_os("PATH") {
        for path in env::split_paths(&existing) {
            if !paths.iter().any(|candidate| candidate == &path) {
                paths.push(path);
            }
        }
    }

    if paths.is_empty() {
        return None;
    }

    env::join_paths(paths).ok()
}

/// Incremental UTF-8 decoder for one PTY byte stream.
///
/// **Double-render contract.** A PTY read returns whatever bytes were available
/// when the kernel filled the buffer, so a multi-byte character is regularly
/// split across two reads. Decoding each read independently with
/// `String::from_utf8_lossy` turned every such split into replacement
/// characters — and a 1-column character becomes 2-3 U+FFFD columns, which
/// silently widens the line. The emulator then soft-wraps a row earlier than Pi
/// does, Pi's cursor-up redraw arithmetic lands one row low, and the previous
/// render is stranded above the new one. That is the "Pi renders text twice"
/// bug, and it fires wherever Pi's TUI uses box drawing, spinners, em dashes,
/// or curly quotes — i.e. constantly.
///
/// Holding an incomplete trailing sequence back until the next read keeps the
/// emitted text byte-exact. The carry is bounded by UTF-8 itself: a truncated
/// sequence is at most 3 bytes.
#[derive(Default)]
struct Utf8Stream {
    carry: Vec<u8>,
}

impl Utf8Stream {
    /// Decode `chunk`, prefixed by any tail held back from the previous read.
    /// Genuinely invalid bytes still become U+FFFD, matching `from_utf8_lossy`;
    /// only *truncated* sequences are deferred.
    fn push(&mut self, chunk: &[u8]) -> String {
        let joined: Vec<u8>;
        let mut rest: &[u8] = if self.carry.is_empty() {
            chunk
        } else {
            joined = self
                .carry
                .drain(..)
                .chain(chunk.iter().copied())
                .collect::<Vec<u8>>();
            &joined
        };

        let mut out = String::with_capacity(chunk.len());
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    return out;
                }
                Err(err) => {
                    let valid = err.valid_up_to();
                    // `valid_up_to` is guaranteed to sit on a char boundary.
                    if let Ok(text) = std::str::from_utf8(&rest[..valid]) {
                        out.push_str(text);
                    }
                    match err.error_len() {
                        // Truncated tail — the rest of the character is in the
                        // next read. Hold it back rather than mangling it.
                        None => {
                            self.carry.extend_from_slice(&rest[valid..]);
                            return out;
                        }
                        // Not UTF-8 at all; emit U+FFFD and keep decoding.
                        Some(len) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            rest = &rest[valid + len..];
                        }
                    }
                }
            }
        }
    }

    /// Flush a tail left incomplete by EOF. Nothing more is coming, so the
    /// truncated bytes can only be rendered as U+FFFD.
    fn flush(&mut self) -> String {
        if self.carry.is_empty() {
            return String::new();
        }
        self.carry.clear();
        char::REPLACEMENT_CHARACTER.to_string()
    }
}

/// Drain the PTY as fast as it produces bytes, staging decoded text for the
/// flusher.
///
/// Reading and emitting are deliberately on separate threads: the reader never
/// blocks on a coalescing window, so the PTY buffer keeps draining (no
/// backpressure onto Pi) while the flusher rate-limits what crosses the bridge.
fn spawn_reader<R>(mut reader: R, stream: Arc<TerminalStream>)
where
    R: Read + Send + 'static,
{
    let _ = thread::Builder::new()
        .name("mesa-terminal-reader".to_string())
        .spawn(move || {
            let mut buf = [0u8; 4096];
            let mut decoder = Utf8Stream::default();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => stream.stage(&decoder.push(&buf[..n])),
                    Err(_) => break,
                }
            }
            stream.close(&decoder.flush());
        });
}

/// Block until the next batch of `terminal://output` events is due.
///
/// Returns an empty batch exactly once, when the reader has closed and
/// everything staged has been committed — that is the flusher's exit signal.
/// Factored out of `spawn_flusher` so the batching policy is testable without
/// an `AppHandle`.
fn next_output_batch(stream: &TerminalStream) -> Vec<(String, u64)> {
    let mut history = stream.lock();
    loop {
        if !history.outbox.is_empty() {
            break;
        }
        if !history.pending.is_empty() {
            let now = Instant::now();
            // At EOF there is nothing left to coalesce with, so the tail goes
            // out immediately rather than paying one last window.
            let delay = if history.closed {
                Duration::ZERO
            } else {
                history.flush_delay(now)
            };
            if delay.is_zero() {
                history.commit_pending(now);
                break;
            }
            let (guard, _) = stream
                .wake
                .wait_timeout(history, delay)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            history = guard;
            continue;
        }
        if history.closed {
            return Vec::new();
        }
        history = stream
            .wake
            .wait(history)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
    let batch: Vec<_> = history.outbox.drain(..).collect();
    drop(history);
    // A reader may be blocked at OUTPUT_PENDING_MAX_BYTES. Wake it after the
    // committed event leaves the staging queue, before the caller emits the
    // event to the webview.
    stream.wake.notify_all();
    batch
}

/// Emit coalesced output batches for one PTY session.
fn spawn_flusher(stream: Arc<TerminalStream>, app: AppHandle, id: String, name: &'static str) {
    let _ = thread::Builder::new()
        .name("mesa-terminal-flusher".to_string())
        .spawn(move || loop {
            let batch = next_output_batch(&stream);
            if batch.is_empty() {
                return;
            }
            for (data, seq) in batch {
                // Emission stays on this one thread, so `seq` reaches the
                // webview in the order the bytes left the PTY.
                let _ = app.emit(
                    "terminal://output",
                    TerminalOutput {
                        session_id: id.clone(),
                        stream: name.to_string(),
                        data,
                        seq,
                    },
                );
            }
        });
}

// The parameter list is the IPC contract with the frontend's `terminal_start`
// invoke — every argument arrives as a named field, so a params struct would
// only obscure the wire shape.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn terminal_start(
    window: tauri::Window,
    app: AppHandle,
    state: State<TerminalState>,
    cwd: Option<String>,
    program: Option<String>,
    args: Option<Vec<String>>,
    envs: Option<HashMap<String, String>>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<String, String> {
    let id = session_id();
    let (mut cmd, path_prefixes) = terminal_command(program.as_deref())?;
    if let Some(dir) = cwd.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.cwd(dir);
    }
    if let Some(args) = args {
        for arg in args {
            cmd.arg(arg);
        }
    }
    cmd.env("MESA_TERMINAL", "1");
    cmd.env("TERM", "xterm-256color");
    cmd.env("TERM_PROGRAM", "Mesa");
    cmd.env("COLORTERM", "truecolor");
    if let Some(path) = merged_path(&path_prefixes) {
        cmd.env("PATH", path.to_string_lossy().to_string());
    }
    if let Some(envs) = envs {
        for (key, value) in envs {
            if key.starts_with("MESA_") {
                cmd.env(key, value);
            }
        }
    }

    let rows = rows.unwrap_or(24).clamp(2, 500);
    let cols = cols.unwrap_or(80).clamp(2, 500);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    #[allow(unused_mut)] // Windows kills the child if Job Object setup fails.
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let job = match child.process_id().ok_or_else(|| "PTY child has no Windows process id".to_string()).and_then(own_windows_process_tree) {
        Ok(job) => job,
        Err(error) => { let _ = child.kill(); return Err(error); }
    };
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut initial_history = TerminalHistory::default();
    initial_history.push_resize(rows, cols);
    let stream = Arc::new(TerminalStream::new(initial_history));
    spawn_reader(reader, Arc::clone(&stream));
    spawn_flusher(Arc::clone(&stream), app, id.clone(), "stdout");

    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(
        id.clone(),
        TerminalSession {
            child,
            master: pair.master,
            writer,
            stream,
            resize_owner: window.label().to_string(),
            rows,
            cols,
            #[cfg(target_os = "windows")]
            _job: job,
        },
    );
    Ok(id)
}

fn resize_master(session: &mut TerminalSession, rows: u16, cols: u16) -> Result<(), String> {
    let rows = rows.clamp(2, 500);
    let cols = cols.clamp(2, 500);
    if session.rows == rows && session.cols == cols {
        return Ok(());
    }
    // Keep the history lock across the native resize so any TUI repaint bytes
    // the reader sees afterwards cannot enter history before this resize
    // marker. A detached xterm replays the exact historical grid timeline.
    let mut history = session.stream.lock();
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    // Commits any staged pre-resize bytes ahead of the marker, so they need a
    // wakeup to leave the outbox even if the PTY then goes quiet.
    history.push_resize(rows, cols);
    drop(history);
    session.stream.wake.notify_all();
    session.rows = rows;
    session.cols = cols;
    Ok(())
}

/// Adopt resize ownership for an existing shared PTY. A detached Pi webview
/// calls this before replaying output; focus changes call it again when the
/// session docks back. The mutex makes owner change + resize one transaction,
/// so an old renderer cannot land a stale size after the handoff.
#[tauri::command]
pub fn terminal_attach(
    window: tauri::Window,
    state: State<TerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    resize_master(session, rows, cols)?;
    session.resize_owner = window.label().to_string();
    Ok(())
}

#[tauri::command]
pub fn terminal_snapshot(
    state: State<TerminalState>,
    session_id: String,
) -> Result<TerminalSnapshot, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    // Staged-but-uncommitted bytes are deliberately excluded: they will arrive
    // as a live event with `seq > snapshot.seq`, which is exactly what the
    // frontend's replay/dedupe path expects.
    let history = session.stream.lock();
    Ok(TerminalSnapshot {
        data: history.snapshot(),
        seq: history.seq,
        events: history.replay(),
    })
}

#[tauri::command]
pub fn terminal_resize(
    window: tauri::Window,
    state: State<TerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<bool, String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    if session.resize_owner != window.label() {
        return Ok(false);
    }
    resize_master(session, rows, cols)?;
    Ok(true)
}

#[tauri::command]
pub fn terminal_write(
    state: State<TerminalState>,
    session_id: String,
    input: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    session
        .writer
        .write_all(input.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_stop(state: State<TerminalState>, session_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&session_id) {
        let _ = session.child.kill();
        // Waiting for a PTY child is allowed to block indefinitely on some
        // backends. Reap it away from the IPC thread so closing Pi cannot
        // freeze the renderer or the Tauri event loop.
        let mut child = session.child;
        let _ = thread::Builder::new()
            .name("mesa-terminal-reaper".to_string())
            .spawn(move || {
                let _ = child.wait();
            });
    }
    Ok(())
}

/// Kill every live PTY on the way out of the app.
///
/// Mesa spawns Pi through a PTY, so `pi` (and the Node process behind it) are
/// ordinary child processes of the app — nothing reparents, reaps, or kills
/// them when the event loop ends, and no `Drop` runs on managed state at exit.
/// Quitting Mesa therefore left Pi running with no window attached to it. This
/// is worst on Windows, where the ConPTY child is not in a job object either,
/// so the orphan holds the vault folder and a later `run.cmd` can hit a locked
/// build cache. Called only from the `RunEvent::Exit` handler in `lib.rs`;
/// `terminal_stop` still owns the ordinary one-session case.
///
/// Never returns an error: a failure here must not be able to stop Mesa from
/// exiting. A poisoned lock is recovered from rather than skipped, because the
/// children still need killing even if some reader thread panicked.
pub fn stop_all_sessions(state: &TerminalState) {
    let mut sessions = state
        .sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for (_, mut session) in sessions.drain() {
        let _ = session.child.kill();
        // The process is already exiting. A non-blocking reap is useful when
        // the child stopped immediately, but shutdown must never wait for a
        // PTY backend or child process that fails to acknowledge termination.
        let _ = session.child.try_wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_history_preserves_order_and_sequence() {
        let mut history = TerminalHistory::default();
        assert_eq!(history.push_resize(24, 80), 1);
        assert_eq!(history.push_output("one".into()), 2);
        assert_eq!(history.push_output(" two".into()), 3);
        assert_eq!(history.snapshot(), "one two");
        assert_eq!(history.seq, 3);
        let replay = history.replay();
        assert_eq!(replay.len(), 3);
        assert_eq!(replay[0].kind, "resize");
        assert_eq!(replay[0].rows, Some(24));
        assert_eq!(replay[1].kind, "output");
        assert_eq!(replay[1].data.as_deref(), Some("one"));
    }

    #[test]
    fn terminal_history_is_bounded_without_dropping_the_latest_chunk() {
        let mut history = TerminalHistory::default();
        history.push_output("a".repeat(TERMINAL_HISTORY_MAX_BYTES));
        history.push_output("latest".into());
        assert_eq!(history.snapshot(), "latest");
    }

    /// The double-render regression: splitting a multi-byte character across
    /// two PTY reads must not change the decoded text by a single column.
    #[test]
    fn split_multibyte_characters_survive_a_read_boundary() {
        // Box drawing, spinner, em dash, curly quotes — Pi's TUI vocabulary.
        let source = "─┤⋮├─ Mesa — “Local NSFW” ─┤⋮├─";
        let bytes = source.as_bytes();

        for split in 0..bytes.len() {
            let mut decoder = Utf8Stream::default();
            let mut decoded = decoder.push(&bytes[..split]);
            decoded.push_str(&decoder.push(&bytes[split..]));
            decoded.push_str(&decoder.flush());
            assert_eq!(decoded, source, "split at byte {split}");
        }
    }

    #[test]
    fn every_read_boundary_of_a_stream_is_lossless() {
        let source = "⋮ Working…\r\n─────────\r\n17.8%/64k (auto)\r\n".repeat(4);
        let bytes = source.as_bytes();

        for chunk in 1..=bytes.len().min(24) {
            let mut decoder = Utf8Stream::default();
            let mut decoded = String::new();
            for window in bytes.chunks(chunk) {
                decoded.push_str(&decoder.push(window));
            }
            decoded.push_str(&decoder.flush());
            assert_eq!(decoded, source, "chunk size {chunk}");
        }
    }

    #[test]
    fn invalid_bytes_still_become_replacement_characters() {
        let mut decoder = Utf8Stream::default();
        // 0xFF is never valid UTF-8 and is not a truncated prefix, so it must
        // be replaced immediately rather than held back forever.
        assert_eq!(decoder.push(b"a\xffb"), "a\u{fffd}b");
        assert!(decoder.carry.is_empty());
    }

    #[test]
    fn a_truncated_tail_is_held_back_not_mangled() {
        let mut decoder = Utf8Stream::default();
        // First two bytes of "─" (E2 94 80).
        assert_eq!(decoder.push(b"ok\xe2\x94"), "ok");
        assert_eq!(decoder.carry, vec![0xe2, 0x94]);
        assert_eq!(decoder.push(b"\x80!"), "─!");
        assert!(decoder.carry.is_empty());
    }

    #[test]
    fn eof_flushes_a_truncated_tail_once() {
        let mut decoder = Utf8Stream::default();
        assert_eq!(decoder.push(b"\xe2\x94"), "");
        assert_eq!(decoder.flush(), "\u{fffd}");
        assert_eq!(decoder.flush(), "");
    }

    #[test]
    fn resize_markers_do_not_consume_output_history_budget() {
        let mut history = TerminalHistory::default();
        history.push_resize(24, 80);
        history.push_resize(30, 100);
        history.push_output("visible".into());
        assert_eq!(history.snapshot(), "visible");
        assert_eq!(history.replay().len(), 3);
    }

    /// The leading edge of a burst must not pay the coalescing delay: a single
    /// keystroke's echo after a quiet stream is the latency users feel.
    #[test]
    fn the_first_chunk_after_a_quiet_stream_flushes_immediately() {
        let mut history = TerminalHistory::default();
        let start = Instant::now();
        assert_eq!(history.flush_delay(start), OUTPUT_FLUSH_INTERVAL); // nothing staged
        history.stage_output("x");
        assert_eq!(history.flush_delay(start), Duration::ZERO);
        assert!(history.commit_pending(start));
        assert_eq!(history.outbox.pop_front(), Some(("x".to_string(), 1)));

        // Inside the window a second chunk waits out the remainder…
        history.stage_output("y");
        let inside = start + Duration::from_millis(3);
        assert_eq!(
            history.flush_delay(inside),
            OUTPUT_FLUSH_INTERVAL - Duration::from_millis(3)
        );
        // …and once the stream has been quiet for a full interval it is a
        // leading edge again.
        assert_eq!(
            history.flush_delay(start + OUTPUT_FLUSH_INTERVAL),
            Duration::ZERO
        );
    }

    /// A batch may not grow into one enormous JS source string, however busy
    /// the window is.
    #[test]
    fn an_oversized_batch_flushes_before_the_window_closes() {
        let mut history = TerminalHistory::default();
        let start = Instant::now();
        history.commit_pending(start); // no-op: nothing staged
        history.stage_output("seed");
        history.commit_pending(start);
        history.outbox.clear();

        history.stage_output(&"a".repeat(OUTPUT_FLUSH_MAX_BYTES - 1));
        assert!(history.flush_delay(start) > Duration::ZERO);
        history.stage_output("a");
        assert_eq!(history.flush_delay(start), Duration::ZERO);
    }

    /// A flusher that only gets scheduled once the reader is far ahead must
    /// still emit capped events, and must not split a multi-byte character
    /// across two of them.
    #[test]
    fn an_overrun_buffer_is_committed_in_capped_char_safe_slices() {
        let mut history = TerminalHistory::default();
        // "─" is 3 bytes, so the cap lands mid-character on most slices.
        let chunk = "─".repeat(OUTPUT_FLUSH_MAX_BYTES);
        history.stage_output(&chunk);

        let now = Instant::now();
        while history.commit_pending(now) {}
        assert!(history.pending.is_empty());

        let mut rejoined = String::new();
        for (data, _) in &history.outbox {
            assert!(data.len() <= OUTPUT_FLUSH_MAX_BYTES);
            rejoined.push_str(data);
        }
        assert_eq!(rejoined, chunk);
        // Backing up to a char boundary costs at most 3 bytes per slice, so the
        // count is the ideal split or a hair above it — never one giant event.
        let ideal = chunk.len().div_ceil(OUTPUT_FLUSH_MAX_BYTES);
        assert!((ideal..=ideal + 1).contains(&history.outbox.len()));
    }

    #[test]
    fn staging_applies_lossless_backpressure_to_a_slow_consumer() {
        let stream = Arc::new(TerminalStream::new(TerminalHistory::default()));
        let (filled_tx, filled_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let producer_stream = Arc::clone(&stream);
        let producer = thread::spawn(move || {
            producer_stream.stage(&"x".repeat(OUTPUT_PENDING_MAX_BYTES));
            filled_tx.send(()).unwrap();
            producer_stream.stage("y");
            done_tx.send(()).unwrap();
        });

        filled_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("producer should fill the pending ceiling");
        assert!(
            done_rx.recv_timeout(Duration::from_millis(20)).is_err(),
            "producer must wait for the slow consumer instead of growing pending"
        );

        let batch = next_output_batch(&stream);
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].0.len(), OUTPUT_FLUSH_MAX_BYTES);
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("draining one event should release the producer");
        producer.join().unwrap();
    }

    #[test]
    fn committing_nothing_neither_advances_seq_nor_queues_an_event() {
        let mut history = TerminalHistory::default();
        assert!(!history.commit_pending(Instant::now()));
        assert_eq!(history.seq, 0);
        assert!(history.outbox.is_empty());
        assert!(history.replay().is_empty());
    }

    /// Staged bytes are produced before a resize, so they must be committed
    /// ahead of the marker. Replaying them at the post-resize width re-wraps
    /// the lines Pi's cursor-up rewrites depend on.
    #[test]
    fn a_resize_commits_staged_bytes_ahead_of_its_own_marker() {
        let mut history = TerminalHistory::default();
        history.stage_output("before");
        assert_eq!(history.push_resize(30, 100), 2);
        history.stage_output("after");
        history.commit_pending(Instant::now());

        let replay = history.replay();
        assert_eq!(replay.len(), 3);
        assert_eq!(replay[0].kind, "output");
        assert_eq!(replay[0].data.as_deref(), Some("before"));
        assert_eq!(replay[1].kind, "resize");
        assert_eq!(replay[2].data.as_deref(), Some("after"));
        assert_eq!(
            history
                .outbox
                .iter()
                .map(|(_, seq)| *seq)
                .collect::<Vec<_>>(),
            vec![1, 3]
        );
    }

    /// Staged bytes must stay out of `snapshot`/`replay` until they are
    /// committed, otherwise a detached window would receive them twice: once in
    /// the snapshot and again as a live event whose `seq` exceeds
    /// `snapshot.seq`.
    #[test]
    fn staged_bytes_are_invisible_until_committed() {
        let mut history = TerminalHistory::default();
        history.stage_output("in flight");
        assert_eq!(history.snapshot(), "");
        assert_eq!(history.seq, 0);
        history.commit_pending(Instant::now());
        assert_eq!(history.snapshot(), "in flight");
        assert_eq!(history.seq, 1);
    }

    /// A `Read` that hands back the measured real-PTY shape: 1,303 chunks
    /// averaging 1,023 B, i.e. 1.3 MB of bulk Pi output.
    struct BurstReader {
        remaining: usize,
    }

    impl Read for BurstReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.remaining == 0 {
                return Ok(0);
            }
            let n = self.remaining.min(1023).min(buf.len());
            buf[..n].fill(b'x');
            self.remaining -= n;
            Ok(n)
        }
    }

    /// The regression this whole pump exists for. Every `terminal://output`
    /// event costs a UI-thread script eval plus a forced repaint on Windows, so
    /// the event COUNT — not the byte count — is what freezes the window.
    #[test]
    fn a_bulk_burst_is_coalesced_without_losing_or_reordering_bytes() {
        const TOTAL: usize = 1_303 * 1_023;
        let stream = Arc::new(TerminalStream::new(TerminalHistory::default()));
        spawn_reader(BurstReader { remaining: TOTAL }, Arc::clone(&stream));

        let mut events = 0usize;
        let mut bytes = 0usize;
        let mut last_seq = 0u64;
        loop {
            let batch = next_output_batch(&stream);
            if batch.is_empty() {
                break;
            }
            for (data, seq) in batch {
                assert!(seq > last_seq, "seq must be strictly increasing");
                last_seq = seq;
                assert!(data.bytes().all(|b| b == b'x'));
                assert!(
                    data.len() <= OUTPUT_FLUSH_MAX_BYTES,
                    "event exceeded the cap"
                );
                bytes += data.len();
                events += 1;
            }
        }

        assert_eq!(bytes, TOTAL, "coalescing must be byte-lossless");
        // One event per read would be 1,303. `OUTPUT_FLUSH_MAX_BYTES` is the
        // floor on the count (21 here) and the leading-edge rule adds a handful
        // of small events at the head of the burst, whose exact number depends
        // on when the scheduler first runs the flusher.
        let capped = TOTAL.div_ceil(OUTPUT_FLUSH_MAX_BYTES);
        assert!(
            (capped..capped + 8).contains(&events),
            "expected ~{capped} coalesced events, got {events}"
        );
        assert_eq!(
            stream.lock().snapshot().len(),
            TOTAL.min(TERMINAL_HISTORY_MAX_BYTES),
            "history must hold the same bytes it emitted, bounded by its budget"
        );
    }

    /// The same burst through a real PTY master rather than a synthetic
    /// `Read`, so the read sizes, EOF, and blocking behaviour are the
    /// platform's own. What matters is that the pump is byte-lossless and
    /// order-preserving end to end: xterm's parser concatenates consecutive
    /// `write()` calls, so identical bytes in identical order render
    /// identically no matter how they were chunked.
    #[cfg(unix)]
    #[test]
    fn a_real_pty_burst_survives_the_pump_byte_for_byte() {
        const LINES: usize = 20_000;
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        // No newlines: a PTY in canonical mode rewrites "\n" as "\r\n", which
        // would make a byte-for-byte comparison test the tty discipline
        // instead of the pump.
        cmd.arg(format!(
            "for i in $(seq {LINES}); do printf 'mesa-terminal-'; done"
        ));
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        let reader = pair.master.try_clone_reader().expect("reader");
        drop(pair.slave);

        let stream = Arc::new(TerminalStream::new(TerminalHistory::default()));
        spawn_reader(reader, Arc::clone(&stream));

        let mut received = String::new();
        let mut last_seq = 0u64;
        loop {
            let batch = next_output_batch(&stream);
            if batch.is_empty() {
                break;
            }
            for (data, seq) in batch {
                assert!(seq > last_seq, "seq must be strictly increasing");
                last_seq = seq;
                assert!(data.len() <= OUTPUT_FLUSH_MAX_BYTES);
                received.push_str(&data);
            }
        }
        let _ = child.wait();

        assert_eq!(received, "mesa-terminal-".repeat(LINES));
        // The real PTY's read boundaries and scheduler timing vary by host.
        // The deterministic BurstReader test above owns the coalescing-count
        // contract; this integration test must stay focused on the native
        // PTY's byte-lossless/order-preserving behavior and the per-event cap.
        let minimum_events = received.len().div_ceil(OUTPUT_FLUSH_MAX_BYTES) as u64;
        assert!(last_seq >= minimum_events);
        assert!(last_seq <= received.len() as u64);
    }

    /// Quiet-then-single-chunk must not be delayed, and the flusher must exit
    /// on EOF instead of leaking a thread per session.
    #[test]
    fn an_interactive_echo_is_emitted_immediately_and_eof_ends_the_pump() {
        let stream = Arc::new(TerminalStream::new(TerminalHistory::default()));
        stream.stage("a");
        let started = Instant::now();
        let batch = next_output_batch(&stream);
        assert_eq!(batch, vec![("a".to_string(), 1)]);
        assert!(started.elapsed() < OUTPUT_FLUSH_INTERVAL);

        stream.close("");
        assert!(next_output_batch(&stream).is_empty());
    }

    /// EOF with a truncated multi-byte tail still delivers the replacement
    /// character rather than dropping it inside the pump.
    #[test]
    fn a_tail_staged_at_eof_is_still_emitted() {
        let stream = Arc::new(TerminalStream::new(TerminalHistory::default()));
        stream.close("\u{fffd}");
        assert_eq!(
            next_output_batch(&stream),
            vec![("\u{fffd}".to_string(), 1)]
        );
        assert!(next_output_batch(&stream).is_empty());
    }
}
